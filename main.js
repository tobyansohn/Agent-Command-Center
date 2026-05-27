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

// Shared sanitization for nested paths — used by writeAny and read (for resolution fallback)
function sanitizeRelativePath(safe) {
  const parts = safe.split('/').filter(Boolean);
  return parts.map((part, i) => {
    if (i === parts.length - 1) {
      const m = part.match(/^(.+?)(\.[a-z0-9]+)?$/i);
      const base = (m?.[1] || part).replace(/[^a-z0-9-_]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'untitled';
      const ext = m?.[2] || '.md';
      return base + ext;
    }
    return part.replace(/[^a-z0-9-_]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  }).join('/');
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
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (name === '.gitkeep' || name.startsWith('.')) continue;
      const fp = path.join(dir, name);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) {
        for (const sub of walk(fp)) out.push(`${name}/${sub}`);
      } else {
        out.push(name);
      }
    }
    return out;
  };
  return LIBRARY_FOLDERS.reduce((acc, folder) => {
    acc[folder] = walk(path.join(libraryPath, folder));
    return acc;
  }, {});
}

function libraryRead(folder, filename) {
  if (!LIBRARY_FOLDERS.includes(folder)) throw new Error('Invalid folder');
  const safe = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (safe.includes('..') || !safe) throw new Error('Invalid filename');
  const folderRoot = path.join(libraryPath, folder);

  // Try multiple resolutions — write applies sanitization, read should mirror that
  // so callers don't need to know the on-disk canonical form.
  const candidates = [
    safe,                                          // exact as given
    safe.match(/\.[a-z0-9]+$/i) ? safe : safe + '.md',  // append .md if no extension
    sanitizeRelativePath(safe)                     // fully sanitized (lowercase, hyphenated, .md)
  ];

  for (const candidate of candidates) {
    const filepath = path.resolve(folderRoot, candidate);
    if (!filepath.startsWith(folderRoot + path.sep)) continue;
    if (fs.existsSync(filepath)) return fs.readFileSync(filepath, 'utf8');
  }

  // Last resort: list available files so the model sees what IS there
  const available = fs.existsSync(folderRoot)
    ? fs.readdirSync(folderRoot).filter(f => !f.startsWith('.')).slice(0, 20).join(', ')
    : '(folder empty)';
  throw new Error(`Not found: ${folder}/${safe}. Available files in ${folder}/: ${available}`);
}

// ── Library Auto-Recall ────────────────────────────────────────
// On every Oracle call, scan wiki/ + output/ filenames for word-overlap with the
// user's message. Top 3 hits get injected into the system prompt as background context.
const RECALL_STOPWORDS = new Set([
  'the','and','that','this','with','have','what','when','where','how','why','who','can','will',
  'should','would','could','about','from','into','your','their','them','they','these','those',
  'been','being','just','also','than','then','some','more','most','much','many','such','here',
  'there','want','need','make','made','done','for','are','was','were','its','our','out','not',
  'but','you','yes','his','her','him','she','one','two','three','any','all','get','got','see'
]);

function findRelevantLibraryEntries(userMessage, maxResults = 3) {
  const words = String(userMessage).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !RECALL_STOPWORDS.has(w));
  if (words.length === 0) return [];

  let allFiles;
  try { allFiles = libraryList(); } catch { return []; }

  // Crude stemming so "agents" matches "agent", "running" matches "run", etc.
  const stem = (w) => {
    if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed'))  return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s'))   return w.slice(0, -1);
    return w;
  };

  const matches = [];
  for (const folder of ['wiki', 'output']) {
    for (const file of (allFiles[folder] || [])) {
      const haystack = file.toLowerCase().replace(/\.md$/, '').replace(/[-/_]/g, ' ');
      const score = words.reduce((n, w) => {
        if (haystack.includes(w)) return n + 1;
        if (haystack.includes(stem(w))) return n + 1;
        return n;
      }, 0);
      if (score > 0) matches.push({ folder, file, score });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function buildRecallContext(matches) {
  if (matches.length === 0) return { context: '', files: [] };
  let context = '\n\n## RECALLED LIBRARY CONTEXT\n(Auto-fetched based on the user\'s message. Use as background — reference naturally when relevant, don\'t cite verbatim unless asked.)\n';
  const includedFiles = [];
  for (const m of matches) {
    try {
      let content = libraryRead(m.folder, m.file);
      // Cap each entry at ~1500 chars to control prompt bloat
      if (content.length > 1500) content = content.slice(0, 1500) + '\n... [truncated]';
      context += `\n### library/${m.folder}/${m.file}\n${content}\n`;
      includedFiles.push(`${m.folder}/${m.file}`);
    } catch {}
  }
  return { context, files: includedFiles };
}

function libraryWriteAny(relativePath, content) {
  ensureLibrary();
  const safe = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!safe || safe.includes('..')) throw new Error('Invalid path');
  const sanitized = sanitizeRelativePath(safe);
  const sanitizedFull = path.resolve(libraryPath, sanitized);
  if (!sanitizedFull.startsWith(libraryPath + path.sep)) throw new Error('Path resolution failed');
  fs.mkdirSync(path.dirname(sanitizedFull), { recursive: true });
  fs.writeFileSync(sanitizedFull, content);
  return 'library/' + sanitized;
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
    name: 'create_file',
    description: 'Create a new file anywhere inside library/ — use this when you need a path beyond the three flat folders, e.g. nested subfolders for organization ("wiki/projects/agent-center.md") or non-markdown files ("output/2026-05-26/data.json"). Parent folders are auto-created. Use this instead of log_to_raw/update_wiki/save_output when you want hierarchy.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path under library/. Use forward slashes. Must start with raw/, wiki/, or output/. Example: "wiki/projects/agent-center.md"' },
        content: { type: 'string', description: 'Full file content.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_library',
    description: 'List all files (recursively) across raw/, wiki/, and output/. Use before creating to avoid duplicates and find existing notes to update.',
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
    messages = sanitizeHistory(messages);
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

  // Haiku is plenty for short clarification answers and ~3x faster than Sonnet
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: specialistQuestion }]
  });
  return response.content[0].text;
}

async function runConsultation(specialist, query, oracle, userQuery, event) {
  const memory = loadMemory();
  const priorHistory = memory[specialist.id] || [];
  let messages = [...priorHistory, { role: 'user', content: query }];
  const tools = [...READER_TOOLS, ASK_ORACLE_TOOL];
  const system = specialist.system_prompt + READER_PROMPT_SUFFIX + `

You may use ask_oracle AT MOST ONCE per consultation, only if the request is genuinely ambiguous. Otherwise just answer with what you have.`;
  let askOracleUsed = false;

  for (let turn = 0; turn < 4; turn++) {
    messages = sanitizeHistory(messages);
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      tools,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      memory[specialist.id] = trimByTokenBudget(messages);
      saveMemory(memory);
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
  memory[specialist.id] = trimByTokenBudget(messages);
  saveMemory(memory);
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
      // Stateless + Haiku — background logging doesn't need Sonnet's reasoning depth
      // and the user isn't waiting on this. Library writes still work the same.
      await runHermes(event, hermes, summary, { stateless: true, model: 'claude-haiku-4-5-20251001' });
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
  try {
    const m = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    // Defensive sanitization on every load — protects against any corrupted state
    for (const k of Object.keys(m)) m[k] = sanitizeHistory(m[k]);
    return m;
  } catch { return {}; }
}

// Strip both orphan tool_result (at start) AND orphan tool_use (at end).
// Anthropic API: every tool_use must be followed by a matching tool_result, and
// every tool_result must follow a matching tool_use. Mid-loop saves can leave
// either side dangling; both forms cause 400 errors.
function sanitizeHistory(msgs) {
  if (!Array.isArray(msgs)) return [];

  // First pass: collect all tool_use IDs and all tool_result IDs across the whole history.
  const toolUseIds = new Set();
  const toolResultIds = new Set();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
      if (b && b.type === 'tool_result' && b.tool_use_id) toolResultIds.add(b.tool_use_id);
    }
  }
  // Orphan IDs in either direction
  const orphanUseIds = new Set([...toolUseIds].filter(id => !toolResultIds.has(id)));
  const orphanResultIds = new Set([...toolResultIds].filter(id => !toolUseIds.has(id)));

  // Second pass: rewrite each message, dropping orphan blocks. Drop the whole message
  // if it becomes empty content after filtering.
  const cleaned = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) { cleaned.push(m); continue; }
    const filtered = m.content.filter(b => {
      if (!b) return false;
      if (b.type === 'tool_use' && orphanUseIds.has(b.id)) return false;
      if (b.type === 'tool_result' && orphanResultIds.has(b.tool_use_id)) return false;
      return true;
    });
    if (filtered.length === 0) continue;
    cleaned.push({ ...m, content: filtered });
  }

  // Third pass: trim boundaries — drop leading user(tool_result) and trailing assistant(tool_use)
  // that can still occur if a slice chopped a pair (orphan detection only catches missing partners
  // when at least one of the pair is present in the surviving slice).
  while (cleaned.length > 0) {
    const first = cleaned[0];
    if (first.role === 'user' && Array.isArray(first.content) && first.content.some(b => b.type === 'tool_result')) {
      cleaned.shift(); continue;
    }
    break;
  }
  while (cleaned.length > 0) {
    const last = cleaned[cleaned.length - 1];
    if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some(b => b.type === 'tool_use')) {
      cleaned.pop(); continue;
    }
    break;
  }

  return cleaned;
}

// Trim history to a token budget (rough estimate: 4 chars/token) so we use the
// full Sonnet 4.6 context window (~200K) instead of a fixed message count.
// Leaves headroom for system prompt, tools, and the model's reply.
const HISTORY_TOKEN_BUDGET = 150000;
function trimByTokenBudget(msgs, budget = HISTORY_TOKEN_BUDGET) {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];
  const charBudget = budget * 4;
  let total = 0;
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const size = JSON.stringify(msgs[i]).length;
    if (total + size > charBudget && kept.length > 0) break;
    total += size;
    kept.unshift(msgs[i]);
  }
  return kept;
}

function saveMemory(memory) {
  for (const k of Object.keys(memory)) memory[k] = sanitizeHistory(memory[k]);
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
  mainWindow.maximize();
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

You can also create nested subfolders for organization via create_file (e.g. "wiki/projects/agent-center.md", "raw/conversations/2026-05-26.md", "output/summaries/weekly.md"). Use the simple log_to_raw/update_wiki/save_output for flat files; use create_file when hierarchy helps.

MANDATORY WORKFLOW for capturing knowledge (5 steps — do not skip):

1. **SCAN** — Call list_library to see all existing files.

2. **READ RELATED** — From that list, identify the 2-4 notes (across raw/ and wiki/) most likely to share themes, projects, or entities with the new content. Call read_library on each. This is non-negotiable: backlinks must be grounded in what the linked notes ACTUALLY say, not inferred from filenames. If a name looks related but the contents aren't, do NOT backlink to it.

3. **WRITE RAW** — Save the new observation via log_to_raw or create_file.

4. **SYNTHESIZE WIKI** — Update or create the matching wiki/ entry. Use [[backlinks]] ONLY to notes you read in step 2 and confirmed are genuinely related. In the wiki entry, explicitly note:
   - What patterns this connects to (cite the [[backlinked]] notes by name)
   - Any contradictions or shifts from prior notes (e.g., "Earlier [[pass-1-intake]] said X; this entry refines that to Y")
   - What new questions this raises

5. **REVERSE BACKLINKS** — For each [[backlinked]] wiki note you added in step 4, call update_wiki on THAT note to add a reverse [[backlink]] pointing to the new entry. Connections must be bidirectional — otherwise the graph is broken. If a backlinked note is in raw/ (not wiki/), skip the reverse link for that one (raw is append-only intake; only wiki gets cross-linked).

After all five steps, give the user a brief confirmation: what raw was logged, what wiki was synthesized, which notes you read for context, and which reverse backlinks you added.

Save deliverables to output/ as a separate concern (no workflow obligation).`;

  const model = opts.model || 'claude-sonnet-4-6';

  for (let turn = 0; turn < 14; turn++) {
    messages = sanitizeHistory(messages);
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: HERMES_TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!opts.stateless) {
        memory[agent.id] = trimByTokenBudget(messages);
        saveMemory(memory);
      }
      return finalText || '(logged)';
    }

    const toolCalls = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const call of toolCalls) {
      try {
        let result;
        let isRawWrite = false;
        if (call.name === 'log_to_raw') {
          result = libraryWrite('raw', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'raw', path: result });
          isRawWrite = true;
        } else if (call.name === 'update_wiki') {
          result = libraryWrite('wiki', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'wiki', path: result });
        } else if (call.name === 'save_output') {
          result = libraryWrite('output', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'output', path: result });
        } else if (call.name === 'create_file') {
          result = libraryWriteAny(call.input.path, call.input.content);
          const top = result.split('/')[1];
          event?.sender.send('hermes:file', { action: top || 'create', path: result });
          if (top === 'raw') isRawWrite = true;
        } else if (call.name === 'list_library') {
          result = JSON.stringify(libraryList(), null, 2);
        } else if (call.name === 'read_library') {
          result = libraryRead(call.input.folder, call.input.filename);
        } else {
          result = 'Unknown tool';
        }
        if (isRawWrite) {
          result += '\n\n[WORKFLOW] Steps 4 & 5 remaining: (4) Synthesize the wiki/ entry now with [[backlinks]] ONLY to notes you read in step 2. Note any patterns, contradictions, and new questions. (5) For each [[backlinked]] wiki note, call update_wiki on THAT note to add a reverse [[backlink]] — bidirectional or it doesn\'t count.';
        }
        if (call.name === 'update_wiki') {
          result += '\n\n[WORKFLOW] If this wiki note added new [[backlinks]] to other wiki notes, you must now update_wiki on each of those to add a reverse [[backlink]] pointing to this one. Skip raw/ targets.';
        }
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: result });
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (!opts.stateless) {
    memory[agent.id] = trimByTokenBudget(messages);
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
  memory[agentId] = trimByTokenBudget(messages);
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
  muse:       'Lyra, the creative director. Use for art direction, visual storytelling, mood/color/composition, brand identity, image-generation prompts.',
  analyst:    'Sigma, the data analyst. Use for numerical reasoning, ROI math, spreadsheet logic, metric interpretation, monetization analysis, quantitative patterns.',
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

Your current specialist roster (${specialists.length} agents — ALL are real and available right now via tool use):
${specialists.map(s => `- ${s.emoji} ${s.name} (${s.title}) — call via consult_${s.id} — ${SPECIALIST_TOOL_DESC[s.id]}`).join('\n')}

If the user asks who is in the realm or which agents exist, this list is authoritative. Never tell the user an agent doesn't exist if it's in this list.

You also have read-only access to a shared knowledge library at /library/ via list_library and read_library. Check it when prior context might be relevant.

DEFAULT to answering directly — the user is talking to YOU. Only consult a specialist when the task clearly needs their specific expertise. You may consult multiple specialists in sequence or parallel. After consultations, synthesize their input into your final response — don't just relay it.

For casual chat, questions, opinions, brainstorming, explanations — just answer.

CRITICAL — no promised-but-uncalled tools:
If you tell the user you're going to do something via a tool ("I'll have Hermes log this", "let me check the library", "I'll consult Forge"), you MUST make that tool call in the SAME turn, BEFORE your reply ends. Never describe an action in past or future tense unless the tool call is actually being made or has already been made in this conversation.

Specifically: if your reply mentions documenting, logging, archiving, or having Hermes save anything, call consult_hermes in the same turn with the documentation request. Don't say "Hermes will document this" and then stop — that's a hallucination, not an action. If you don't intend to actually call Hermes, don't mention him.

A background auto-logging system exists but it's invisible to you and to the user. Don't reference it. Don't credit it. If documentation matters enough to mention, do it yourself via consult_hermes.`;

  // Auto-recall: pull relevant wiki entries based on the user's message
  const recalled = findRelevantLibraryEntries(message);
  const { context: recallContext, files: recalledFiles } = buildRecallContext(recalled);
  if (recalledFiles.length > 0) {
    event.sender.send('chat:recall', { files: recalledFiles });
  }
  const orchestrationSystemWithRecall = orchestrationSystem + recallContext;

  const history = memory['oracle'] || [];
  let messages = [...history, { role: 'user', content: message }];
  const consultations = [];

  // One transparent retry on transient API errors (connection drops, 429, 5xx).
  // Skips retry if we already started streaming text — the user has seen partial output.
  const shouldRetry = (err) => {
    const status = err?.status || err?.statusCode;
    if (status === 400 || status === 401 || status === 403) return false;
    return true;
  };

  for (let turn = 0; turn < 7; turn++) {
    event.sender.send('chat:stream-start', { turn });

    let response;
    let textEmitted = false;
    // Defensive: sanitize before every API call so a mid-loop orphan tool_use/tool_result
    // pair can't reach the API and trigger a 400. Mutates `messages` in place via reassignment.
    messages = sanitizeHistory(messages);
    const runStream = async () => {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: orchestrationSystemWithRecall,
        tools,
        messages
      });
      stream.on('text', (delta) => {
        textEmitted = true;
        event.sender.send('chat:stream-delta', { delta });
      });
      return await stream.finalMessage();
    };

    try {
      response = await runStream();
    } catch (err) {
      if (shouldRetry(err) && !textEmitted) {
        await new Promise(r => setTimeout(r, 800));
        response = await runStream();
      } else {
        throw err;
      }
    }

    event.sender.send('chat:stream-end', { turn });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      let finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

      // Enforcement: if Oracle's text promises a Hermes/documentation action in future/present tense
      // but didn't actually call consult_hermes this turn, fire Hermes from the backend so the
      // promise actually happens. No loop-back — that caused runaway iterations.
      const promisesHermes = /\b(hermes\b|documenting|logging|archiving|committ\w*|hand\w+ (off|to|over) to)\b/i.test(finalText)
        && /\b(will|i'?ll|going to|let me|about to|now|asking|sending|handing)\b/i.test(finalText);
      const calledHermes = consultations.some(c => c.agentId === 'hermes');
      if (promisesHermes && !calledHermes) {
        const hermes = specialists.find(s => s.id === 'hermes');
        if (hermes) {
          event.sender.send('chat:consulting', {
            agentId: hermes.id, agentName: hermes.name,
            agentEmoji: hermes.emoji, agentColor: hermes.color,
            query: '[auto-dispatch] documenting Oracle\'s promised action'
          });
          try {
            const docQuery = `Oracle just told the user: "${finalText}"\n\nUser had asked: ${message}\n\nConsultations this turn:\n${consultations.map(c => `- ${c.agentName}: ${c.reply.slice(0, 500)}`).join('\n') || '(none)'}\n\nRun your full 5-step workflow to document this exchange.`;
            const hermesReply = await runHermes(event, hermes, docQuery, { stateless: false });
            event.sender.send('chat:consulted', {
              agentId: hermes.id, agentName: hermes.name,
              agentEmoji: hermes.emoji, agentColor: hermes.color,
              reply: hermesReply
            });
            consultations.push({
              agentId: hermes.id, agentName: hermes.name,
              agentEmoji: hermes.emoji, agentColor: hermes.color,
              query: docQuery, reply: hermesReply
            });
          } catch (err) {
            console.error('[auto-hermes]', err.message);
          }
        }
      }

      memory['oracle'] = trimByTokenBudget(messages);
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
        // Hermes needs his full toolkit (write access to library) when consulted — others get reader-only
        const specReply = specialist.id === 'hermes'
          ? await runHermes(event, specialist, call.input.query, { stateless: true })
          : await runConsultation(specialist, call.input.query, oracle, message, event);
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

  memory['oracle'] = trimByTokenBudget(messages);
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
    memory[agent.id] = trimByTokenBudget([...messages, { role: 'assistant', content: reply }]);
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
