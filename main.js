const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');

let mainWindow;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const configPath = path.join(__dirname, 'agents', 'config.json');
const memoryPath = path.join(__dirname, 'agents', 'memory.json');
const libraryPath = path.join(__dirname, 'library');
const LIBRARY_FOLDERS = ['raw', 'wiki', 'output'];

function ensureLibrary() {
  if (!fs.existsSync(libraryPath)) fs.mkdirSync(libraryPath);
  LIBRARY_FOLDERS.forEach(f => {
    const p = path.join(libraryPath, f);
    if (!fs.existsSync(p)) fs.mkdirSync(p);
  });
}

function sanitizeFilename(name) {
  const clean = String(name || '')
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return (clean || 'untitled') + '.md';
}

function libraryWrite(folder, filename, content) {
  if (!LIBRARY_FOLDERS.includes(folder)) throw new Error('Invalid folder');
  ensureLibrary();
  const finalName = sanitizeFilename(filename);
  const filepath = path.join(libraryPath, folder, finalName);
  fs.writeFileSync(filepath, content);
  return `library/${folder}/${finalName}`;
}

function libraryList() {
  ensureLibrary();
  return LIBRARY_FOLDERS.reduce((acc, folder) => {
    const p = path.join(libraryPath, folder);
    acc[folder] = fs.existsSync(p) ? fs.readdirSync(p).filter(f => f.endsWith('.md')) : [];
    return acc;
  }, {});
}

function libraryRead(folder, filename) {
  if (!LIBRARY_FOLDERS.includes(folder)) throw new Error('Invalid folder');
  const finalName = sanitizeFilename(filename);
  const filepath = path.join(libraryPath, folder, finalName);
  if (!fs.existsSync(filepath)) throw new Error(`Not found: ${folder}/${finalName}`);
  return fs.readFileSync(filepath, 'utf8');
}

const HERMES_TOOLS = [
  {
    name: 'log_to_raw',
    description: 'Save an observation, snippet, or log entry to library/raw/ as markdown. Use freely to capture anything worth remembering — patterns, decisions, user preferences, project context, recurring requests.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'kebab-case filename, no extension' },
        content: { type: 'string', description: 'Markdown content. Include date and topic context at the top.' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'update_wiki',
    description: 'Create or update a distilled wiki note in library/wiki/. Wiki notes are the organized knowledge base. Synthesize patterns from raw logs into wiki entries. Use [[backlinks]] to link related notes (Obsidian-style).',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'kebab-case filename, no extension' },
        content: { type: 'string', description: 'Well-organized markdown with backlinks like [[other-note]]' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'save_output',
    description: 'Save a generated deliverable (summary, document, artifact) to library/output/.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'kebab-case filename, no extension' },
        content: { type: 'string', description: 'Markdown content of the artifact' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'list_library',
    description: 'List all files across raw/, wiki/, and output/. Use before creating to avoid duplicates and find existing notes to update.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'read_library',
    description: 'Read a specific file from the library to recall past context.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', enum: ['raw', 'wiki', 'output'] },
        filename: { type: 'string', description: 'kebab-case filename, no extension' }
      },
      required: ['folder', 'filename']
    }
  }
];

const READER_TOOLS = [
  {
    name: 'list_library',
    description: 'List existing notes in the shared library (raw/, wiki/, output/) to discover prior context before answering.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'read_library',
    description: 'Read a specific library file to recall past decisions, patterns, or relevant context.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', enum: ['raw', 'wiki', 'output'] },
        filename: { type: 'string', description: 'kebab-case filename, no extension' }
      },
      required: ['folder', 'filename']
    }
  }
];

const READER_PROMPT_SUFFIX = `

You have read-only access to a shared knowledge library at /library/. ONLY call list_library when you have a specific reason to believe prior context exists that would meaningfully change your answer (e.g. the user references "the project", "what we decided", "last time"). For most requests, just answer directly without checking — the library is a recall tool, not a default lookup. Hermes maintains the library; you don't write to it.`;

function handleReaderTool(call) {
  if (call.name === 'list_library') return JSON.stringify(libraryList(), null, 2);
  if (call.name === 'read_library') return libraryRead(call.input.folder, call.input.filename);
  return null;
}

async function runAgentWithReaders(agent, userMessage, history) {
  let messages = [...history, { role: 'user', content: userMessage }];
  const system = agent.system_prompt + READER_PROMPT_SUFFIX;

  for (let turn = 0; turn < 4; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      tools: READER_TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { reply: text, messages };
    }

    const results = [];
    for (const call of response.content.filter(b => b.type === 'tool_use')) {
      try {
        const r = handleReaderTool(call);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r ?? 'Unknown tool' });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: '(tool limit)', messages };
}

const ASK_ORACLE_TOOL = {
  name: 'ask_oracle',
  description: 'Ask the Oracle a clarifying question before producing your answer. Use SPARINGLY — only when the request is genuinely ambiguous, missing critical info, or a key assumption needs confirmation. Most requests do NOT need clarification; just answer them.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'A specific, focused question. Be direct — one sentence.' }
    },
    required: ['question']
  }
};

async function askOracle(oracle, userQuery, specialistQuestion) {
  const system = `${oracle.system_prompt}

A specialist working on your behalf needs clarification. The user's original request was:
"${userQuery}"

Answer the specialist's question briefly and decisively — they need direction, not exploration. One or two sentences max.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: specialistQuestion }]
  });
  return response.content[0].text;
}

async function runConsultation(specialist, query, oracle, userQuery, event) {
  let messages = [{ role: 'user', content: query }];
  const tools = [...READER_TOOLS, ASK_ORACLE_TOOL];
  const system = specialist.system_prompt + READER_PROMPT_SUFFIX + `

You may use ask_oracle AT MOST ONCE per consultation, only if the request is genuinely ambiguous. Otherwise just answer with what you have.`;
  let askOracleUsed = false;

  for (let turn = 0; turn < 4; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      tools,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    const results = [];
    for (const call of response.content.filter(b => b.type === 'tool_use')) {
      try {
        if (call.name === 'ask_oracle') {
          if (askOracleUsed) {
            results.push({ type: 'tool_result', tool_use_id: call.id, content: 'ask_oracle already used this consultation. Answer with what you have.', is_error: true });
            continue;
          }
          askOracleUsed = true;
          event?.sender.send('chat:clarify-q', {
            agentId: specialist.id, agentName: specialist.name,
            agentEmoji: specialist.emoji, agentColor: specialist.color,
            question: call.input.question
          });
          const answer = await askOracle(oracle, userQuery, call.input.question);
          event?.sender.send('chat:clarify-a', { agentId: specialist.id, answer });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: answer });
        } else {
          const r = handleReaderTool(call);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: r ?? 'Unknown tool' });
        }
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return '(consultation iteration limit reached)';
}

function autoLog(event, summary, contentSize) {
  // Skip trivial content — short greetings, acknowledgments, etc.
  if (typeof contentSize === 'number' && contentSize < 200) return;
  setImmediate(async () => {
    try {
      const config = loadConfig();
      const hermes = config.agents.find(a => a.id === 'hermes');
      if (!hermes) return;
      // Stateless invocation — bypass conversation memory to prevent context bloat.
      // Hermes's true memory IS the library; conversation history adds no value here.
      await runHermes(event, hermes, summary, { stateless: true });
    } catch (err) {
      console.error('[autoLog]', err.message);
    }
  });
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadMemory() {
  if (!fs.existsSync(memoryPath)) return {};
  try { return JSON.parse(fs.readFileSync(memoryPath, 'utf8')); }
  catch { return {}; }
}

function saveMemory(memory) {
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0d0d1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('agent:list', () => loadConfig().agents);
ipcMain.handle('world:info', () => loadConfig().world);

ipcMain.handle('memory:get', (_, agentId) => {
  const memory = loadMemory();
  return memory[agentId] || [];
});

ipcMain.handle('memory:clear', (_, agentId) => {
  const memory = loadMemory();
  memory[agentId] = [];
  saveMemory(memory);
  return true;
});

async function runHermes(event, agent, message, opts = {}) {
  ensureLibrary();
  const memory = loadMemory();
  const history = opts.stateless ? [] : (memory[agent.id] || []);
  let messages = [...history, { role: 'user', content: message }];

  const systemPrompt = `${agent.system_prompt}

You maintain a markdown Library at /library/ structured as an Obsidian vault:
- raw/   — unprocessed observations, captured as they come
- wiki/  — distilled, organized knowledge with [[backlinks]] between notes
- output/ — finished artifacts and deliverables

Workflow: when you notice something worth remembering (decisions, patterns, preferences, project context, recurring themes), FIRST log to raw/. Then synthesize into wiki/ — update existing notes when topics overlap. Save generated deliverables to output/. ALWAYS run list_library before creating to avoid duplicates and find related notes to extend.

Use these tools proactively without asking permission — that is your job. After acting, give the user a brief confirmation of what you logged and where.`;

  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      tools: HERMES_TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!opts.stateless) {
        memory[agent.id] = messages.slice(-40);
        saveMemory(memory);
      }
      return finalText || '(logged)';
    }

    const toolCalls = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const call of toolCalls) {
      try {
        let result;
        if (call.name === 'log_to_raw') {
          result = libraryWrite('raw', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'raw', path: result });
        } else if (call.name === 'update_wiki') {
          result = libraryWrite('wiki', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'wiki', path: result });
        } else if (call.name === 'save_output') {
          result = libraryWrite('output', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'output', path: result });
        } else if (call.name === 'list_library') {
          result = JSON.stringify(libraryList(), null, 2);
        } else if (call.name === 'read_library') {
          result = libraryRead(call.input.folder, call.input.filename);
        } else {
          result = 'Unknown tool';
        }
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: result });
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (!opts.stateless) {
    memory[agent.id] = messages.slice(-40);
    saveMemory(memory);
  }
  return 'Reached tool limit.';
}

ipcMain.handle('chat:send', async (event, { agentId, message }) => {
  const config = loadConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  if (agentId === 'hermes') {
    return await runHermes(event, agent, message);
  }

  const memory = loadMemory();
  const history = memory[agentId] || [];
  const { reply, messages } = await runAgentWithReaders(agent, message, history);
  memory[agentId] = messages.slice(-40);
  saveMemory(memory);

  autoLog(event, `Direct conversation with ${agent.name} (${agent.title}).

User: ${message}

${agent.name}: ${reply}

Log if this contains a decision, preference, pattern, or useful context. Skip if purely conversational.`, message.length + reply.length);

  return reply;
});

const SPECIALIST_TOOL_DESC = {
  smith:      'Forge, a senior software engineer. Use for writing, reviewing, or debugging code.',
  scholar:    'Aria, a researcher. Use for deep research, summarization, structured analysis, fact-finding.',
  strategist: 'Vex, a strategist. Use for planning, task breakdown, decision frameworks, project management.',
  herald:     'Swift, a writer. Use for drafting emails, documents, or polished written communication.',
  hermes:     'Hermes, the historian. Use to recall past context, surface prior decisions, identify recurring patterns, or connect current questions to accumulated history.'
};

ipcMain.handle('chat:route', async (event, { message }) => {
  const config = loadConfig();
  const oracle = config.agents.find(a => a.id === 'oracle');
  const specialists = config.agents.filter(a => !a.isCouncil && a.id !== 'oracle');
  const memory = loadMemory();

  const consultTools = specialists.map(s => ({
    name: `consult_${s.id}`,
    description: `Consult ${s.name}. ${SPECIALIST_TOOL_DESC[s.id] || s.title}`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `What to ask ${s.name}. Provide enough context for a useful response.` }
      },
      required: ['query']
    }
  }));
  const tools = [...consultTools, ...READER_TOOLS];

  const orchestrationSystem = `${oracle.system_prompt}

You can collaborate with specialists when their expertise would meaningfully improve your answer:
${specialists.map(s => `- consult_${s.id}: ${SPECIALIST_TOOL_DESC[s.id]}`).join('\n')}

You also have read-only access to a shared knowledge library at /library/ via list_library and read_library. Check it when prior context might be relevant.

DEFAULT to answering directly — the user is talking to YOU. Only consult a specialist when the task clearly needs their specific expertise. You may consult multiple specialists in sequence or parallel. After consultations, synthesize their input into your final response — don't just relay it.

For casual chat, questions, opinions, brainstorming, explanations — just answer.`;

  const history = memory['oracle'] || [];
  let messages = [...history, { role: 'user', content: message }];
  const consultations = [];

  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: orchestrationSystem,
      tools,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      memory['oracle'] = messages.slice(-40);
      saveMemory(memory);

      const consultSummary = consultations.map(c => `- ${c.agentName}: ${c.reply.slice(0, 400)}`).join('\n');
      autoLog(event, `User asked Oracle:
${message}

Oracle's final answer:
${finalText}
${consultations.length ? `\nConsulted:\n${consultSummary}` : ''}

Log if this captures a decision, recurring theme, useful pattern, project context, or anything worth remembering. Skip if purely conversational.`, message.length + finalText.length + consultations.reduce((n, c) => n + c.reply.length, 0));

      return { finalReply: finalText, consultations };
    }

    const toolCalls = response.content.filter(b => b.type === 'tool_use');

    // Run all tool calls in parallel — independent specialists run concurrently
    const toolResults = await Promise.all(toolCalls.map(async call => {
      if (call.name.startsWith('consult_')) {
        const specialist = specialists.find(s => s.id === call.name.replace('consult_', ''));
        if (!specialist) {
          return { type: 'tool_result', tool_use_id: call.id, content: 'Unknown specialist', is_error: true };
        }
        event.sender.send('chat:consulting', {
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          query: call.input.query
        });
        const specReply = await runConsultation(specialist, call.input.query, oracle, message, event);
        event.sender.send('chat:consulted', {
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          reply: specReply
        });
        consultations.push({
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          query: call.input.query, reply: specReply
        });
        return { type: 'tool_result', tool_use_id: call.id, content: specReply };
      }
      try {
        const r = handleReaderTool(call);
        return { type: 'tool_result', tool_use_id: call.id, content: r ?? 'Unknown tool' };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true };
      }
    }));

    messages.push({ role: 'user', content: toolResults });
  }

  memory['oracle'] = messages.slice(-40);
  saveMemory(memory);
  return { finalReply: 'Reached consultation limit. Try a more focused question.', consultations };
});

ipcMain.handle('chat:send-all', async (_, { message }) => {
  const config = loadConfig();
  const memory = loadMemory();
  const councillors = config.agents.filter(a => !a.isCouncil);

  const results = await Promise.all(councillors.map(async agent => {
    const history = memory[agent.id] || [];
    const messages = [...history, { role: 'user', content: message }];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: agent.system_prompt + ' You are speaking in the Grand Council Chamber alongside other agents. Be concise — 2-3 sentences max. Speak from your role.',
      messages
    });

    const reply = response.content[0].text;
    memory[agent.id] = [...messages, { role: 'assistant', content: reply }].slice(-40);
    return { agentId: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, reply };
  }));

  saveMemory(memory);
  return results;
});

ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow.close());
