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

// Self-referential failure-pattern wiki entries. Recalling these into the system
// prompt primes Oracle to model the bug rather than avoid it (see analysis 2026-05-26).
// Filter them out of auto-recall — they remain readable via the read_library tool.
const RECALL_BLOCKLIST = new Set([
  'wiki/oracle-execution-vs-description-pattern.md',
  'wiki/oracle-hermes-workflow-handoff.md',
  'wiki/verification-failure-and-remedy.md',
  'wiki/oracle-empty-handoff-pattern.md',
  'wiki/oracle-framework-vs-reality-gap-2025-07-14.md'
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
      if (score > 0 && !RECALL_BLOCKLIST.has(`${folder}/${file}`)) matches.push({ folder, file, score });
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
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

  // Fourth pass: enforce role alternation. When tool_use orphan removal drops an
  // assistant turn, the surrounding messages of the same role become adjacent —
  // the API rejects that. Merge consecutive same-role messages by concatenating
  // their content blocks. This preserves tool_result blocks that must stay
  // adjacent to their tool_use.
  const toBlocks = (c) => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
  const alternated = [];
  for (const m of cleaned) {
    if (alternated.length > 0 && alternated[alternated.length - 1].role === m.role) {
      const prev = alternated[alternated.length - 1];
      alternated[alternated.length - 1] = {
        ...prev,
        content: [...toBlocks(prev.content), ...toBlocks(m.content)]
      };
    } else {
      alternated.push(m);
    }
  }

  return alternated;
}

// Trim history to a token budget (rough estimate: 4 chars/token) so we use the
// full Sonnet 4.6 context window (~200K) instead of a fixed message count.
// Leaves headroom for system prompt, tools, and the model's reply.
const HISTORY_TOKEN_BUDGET = 40000;
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

// Build a substantive Hermes reply summarizing what he actually did. Replaces
// the old "(logged)" stub so Oracle has real content to synthesize from.
function formatHermesReturn(finalText, actions) {
  const lines = [];
  if (finalText) lines.push(finalText);
  const writes = actions.wrote || [];
  const reads = actions.read || [];
  if (writes.length === 0 && reads.length === 0) {
    return finalText || '(no action taken)';
  }
  const summary = [];
  const raws = writes.filter(p => p.startsWith('library/raw/'));
  const wikis = writes.filter(p => p.startsWith('library/wiki/'));
  const outputs = writes.filter(p => p.startsWith('library/output/'));
  const otherWrites = writes.filter(p => !raws.includes(p) && !wikis.includes(p) && !outputs.includes(p));
  if (raws.length)    summary.push(`Logged ${raws.length} raw note(s): ${raws.join(', ')}`);
  if (wikis.length)   summary.push(`Synthesized ${wikis.length} wiki entry/entries: ${wikis.join(', ')}`);
  if (outputs.length) summary.push(`Saved ${outputs.length} output file(s): ${outputs.join(', ')}`);
  if (otherWrites.length) summary.push(`Wrote: ${otherWrites.join(', ')}`);
  if (reads.length)   summary.push(`Read for context: ${reads.join(', ')}`);
  if (lines.length === 0) lines.push(summary.join('\n'));
  else lines.push('\n— actions —\n' + summary.join('\n'));
  return lines.join('\n');
}

async function runHermes(event, agent, message, opts = {}) {
  ensureLibrary();
  const memory = loadMemory();
  const history = opts.stateless ? [] : (memory[agent.id] || []);
  let messages = [...history, { role: 'user', content: message }];

  // Track Hermes's actions across the run so the return value is substantive
  // even when his final text is brief. Lets Oracle synthesize a real reply.
  const actions = { wrote: [], read: [] };

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

  const model = opts.model || 'claude-haiku-4-5-20251001';

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
      return formatHermesReturn(finalText, actions);
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
          actions.wrote.push(result);
          isRawWrite = true;
        } else if (call.name === 'update_wiki') {
          result = libraryWrite('wiki', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'wiki', path: result });
          actions.wrote.push(result);
        } else if (call.name === 'save_output') {
          result = libraryWrite('output', call.input.filename, call.input.content);
          event?.sender.send('hermes:file', { action: 'output', path: result });
          actions.wrote.push(result);
        } else if (call.name === 'create_file') {
          result = libraryWriteAny(call.input.path, call.input.content);
          const top = result.split('/')[1];
          event?.sender.send('hermes:file', { action: top || 'create', path: result });
          actions.wrote.push(result);
          if (top === 'raw') isRawWrite = true;
        } else if (call.name === 'list_library') {
          result = JSON.stringify(libraryList(), null, 2);
        } else if (call.name === 'read_library') {
          result = libraryRead(call.input.folder, call.input.filename);
          actions.read.push(`${call.input.folder}/${call.input.filename}`);
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
  return formatHermesReturn('Reached tool limit before completing the workflow.', actions);
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

  const orchestrationSystem = `### ABSOLUTE RULE — READ FIRST, APPLIES TO EVERY TURN ###

You are a tool-using agent. The ONLY way to consult a specialist or check the library is via tool_use blocks. Describing an action in text does NOT execute it. The user cannot see your intent — only your tool calls.

Text and tool_use coexist in the same response. When you want to consult a specialist, you emit the tool_use block in the SAME response as any text — they are not sequential turns. A response that intends to act has both: a brief sentence (if useful) AND the tool_use block.

If the user gives a direct instruction like "consult hermes", "ask forge", "check the library", emit the matching tool_use block immediately.

If you previously promised an action and didn't make the call, the recovery is to emit the tool_use NOW with no preamble — not to apologize and re-promise.

### END ABSOLUTE RULE ###

${oracle.system_prompt}

Your current specialist roster (${specialists.length} agents — ALL are real and available right now via tool use):
${specialists.map(s => `- ${s.emoji} ${s.name} (${s.title}) — call via consult_${s.id} — ${SPECIALIST_TOOL_DESC[s.id]}`).join('\n')}

If the user asks who is in the realm or which agents exist, this list is authoritative. Never tell the user an agent doesn't exist if it's in this list.

You also have read-only access to a shared knowledge library at /library/ via list_library and read_library. Check it when prior context might be relevant.

DEFAULT to answering directly — the user is talking to YOU. Only consult a specialist when the task clearly needs their specific expertise. You may consult multiple specialists in sequence or parallel. After consultations, synthesize their input into your final response — don't just relay it.

For casual chat, questions, opinions, brainstorming, explanations — just answer.

Logging is YOUR judgment call. There is no background auto-logger. After answering, decide whether this exchange contains something worth preserving — a decision, preference, recurring pattern, project context, named entity, or anything the user would want to recall later. If yes, call consult_hermes in the same turn with a clear documentation request. If the exchange is purely conversational, casual, or trivial, do not call Hermes. Err on the side of NOT logging unless there's a concrete reason to.`;

  // Skip auto-recall for trivial messages — saves ~1100 input tokens per call when
  // the user is just acknowledging or saying hi. Recall adds zero value here.
  const trivial = /^\s*(hi|hello|hey|yo|sup|ok|okay|yes|yeah|yep|no|nope|thanks|thx|ty|got it|cool|nice|great|wow|lol|haha)\s*[.!?]?\s*$/i;
  const recalled = trivial.test(message) ? [] : findRelevantLibraryEntries(message);
  const { context: recallContext, files: recalledFiles } = buildRecallContext(recalled);
  if (recalledFiles.length > 0) {
    event.sender.send('chat:recall', { files: recalledFiles });
  }
  // System prompt structured for prompt caching: orchestrationSystem is stable across
  // turns within a conversation (cacheable @ 90% discount); recallContext varies per
  // message and goes after the cache breakpoint.
  const systemBlocks = [
    { type: 'text', text: orchestrationSystem, cache_control: { type: 'ephemeral' } },
    ...(recallContext ? [{ type: 'text', text: recallContext }] : [])
  ];

  const history = memory['oracle'] || [];
  let messages = [...history, { role: 'user', content: message }];
  const consultations = [];

  // Detect explicit user commands like "consult hermes", "ask forge", "call lyra".
  // Match against agent id, name (first word, lowercased), or pokemon name.
  // When matched, force tool_choice on the first turn so the API refuses to let
  // the model end without making the promised tool call.
  const forcedToolName = (() => {
    const m = String(message).trim().toLowerCase()
      .match(/^(?:consult|ask|call|send to|message|use|talk to|run|invoke|summon)\s+(\w+)/);
    if (!m) return null;
    const term = m[1];
    const target = specialists.find(s =>
      s.id === term ||
      s.name?.toLowerCase().split(/\s+/)[0] === term ||
      s.pokemon?.toLowerCase() === term
    );
    return target ? `consult_${target.id}` : null;
  })();
  if (forcedToolName) console.log('[chat:route] forcing tool_choice:', forcedToolName);

  // Post-response enforcement state. Flipped to true after one enforcement re-roll
  // so we never recurse infinitely.
  let enforcementUsed = false;
  let forceAnyNextTurn = false;
  const promiseRe = /\b(calling|consulting|asking|sending\s+to|handing.*to|i'?ll\s+(call|consult|ask|send|hand|have)|let\s+me\s+(call|consult|ask|send|hand)|right\s+now|on\s+it|doing\s+it\s+now|mid[-\s]operation)\b/i;

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
    // Tool-choice forcing:
    //  - Turn 0 + explicit user command ("consult hermes") → force that specific tool
    //  - forceAnyNextTurn (post-promise enforcement) → force any tool call
    const toolChoice = (turn === 0 && forcedToolName)
      ? { type: 'tool', name: forcedToolName }
      : forceAnyNextTurn
        ? { type: 'any' }
        : undefined;
    if (forceAnyNextTurn) {
      console.log('[chat:route] enforcement re-roll with tool_choice: any');
      forceAnyNextTurn = false;
    }
    const runStream = async () => {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemBlocks,
        tools,
        messages,
        ...(toolChoice ? { tool_choice: toolChoice } : {})
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
      console.error('[chat:route] API error turn', turn, err?.status, err?.message);
      if (shouldRetry(err) && !textEmitted) {
        await new Promise(r => setTimeout(r, 800));
        try {
          response = await runStream();
        } catch (err2) {
          console.error('[chat:route] retry failed:', err2?.status, err2?.message);
          throw err2;
        }
      } else {
        throw err;
      }
    }

    event.sender.send('chat:stream-end', { turn });
    console.log('[chat:route] turn', turn, 'stop_reason:', response.stop_reason,
      'blocks:', response.content.map(b => b.type).join(','),
      'tool_names:', response.content.filter(b => b.type === 'tool_use').map(b => b.name).join(','));

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

      // Post-response enforcement: if Oracle's text promises a tool action but no tool
      // was actually called this entire route, re-roll the turn with tool_choice: any.
      // One attempt only — prevents infinite loops if the model resists.
      if (!enforcementUsed && consultations.length === 0 && promiseRe.test(finalText)) {
        console.log('[chat:route] promise detected without tool call — enforcing');
        enforcementUsed = true;
        forceAnyNextTurn = true;
        messages.push({
          role: 'user',
          content: 'You just promised to make a tool call in your last reply but didn\'t actually call any tool. Make the call you promised NOW. Emit only the tool_use block — no preamble text, no apology.'
        });
        continue;
      }

      memory['oracle'] = trimByTokenBudget(messages);
      saveMemory(memory);

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
        const query = call.input?.query || `(no query — direct command from user: "${message}")`;
        console.log('[chat:route] running consultation:', specialist.id, 'query:', query.slice(0, 80));
        event.sender.send('chat:consulting', {
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          query
        });
        // Hermes needs his full toolkit (write access to library) when consulted — others get reader-only
        const specReply = specialist.id === 'hermes'
          ? await runHermes(event, specialist, query, { stateless: true })
          : await runConsultation(specialist, query, oracle, message, event);
        console.log('[chat:route] consultation complete:', specialist.id, 'reply length:', specReply?.length);
        event.sender.send('chat:consulted', {
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          reply: specReply
        });
        consultations.push({
          agentId: specialist.id, agentName: specialist.name,
          agentEmoji: specialist.emoji, agentColor: specialist.color,
          query, reply: specReply
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

    // Short-circuit: if the user explicitly commanded "consult X", the specialist's reply
    // IS the answer. Skip the synthesis turn — otherwise the model often emits end_turn
    // with empty text and the chat appears blank.
    if (turn === 0 && forcedToolName) {
      const direct = consultations.find(c => `consult_${c.agentId}` === forcedToolName);
      if (direct) {
        memory['oracle'] = trimByTokenBudget(messages);
        saveMemory(memory);
        return { finalReply: '', consultations };
      }
    }
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
      model: 'claude-haiku-4-5-20251001',
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
