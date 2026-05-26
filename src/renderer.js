let agents = [];

// World map roaming
let worldRoamers    = [];
let worldFrameTimer = null;
let worldRoamTimers = [];

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [agentList, worldInfo] = await Promise.all([
    window.api.getAgents(),
    window.api.getWorldInfo()
  ]);
  agents = agentList;
  document.getElementById('world-title').textContent = worldInfo.name.toUpperCase();
  renderWorldMap();
  renderSidebar();
  setupWindowControls();
  setupSidebarResize();
  setupFullscreenToggle();
  setupTabs();
  window.api.onConsulting(handleConsulting);
  window.api.onConsulted(handleConsulted);
  window.api.onClarifyQ(handleClarifyQ);
  window.api.onClarifyA(handleClarifyA);
  window.api.onStreamStart(handleStreamStart);
  window.api.onStreamDelta(handleStreamDelta);
  window.api.onStreamEnd(handleStreamEnd);
  window.api.onHermesFile(handleHermesFile);
}

// ── Oracle Streaming ──────────────────────────────────────────
let streamingBubble = null;
let streamingBuffer = '';
let streamedAnyText = false;

function handleStreamStart() {
  // New Oracle turn — close any prior bubble so next delta opens a fresh one
  streamingBubble = null;
  streamingBuffer = '';
}

function handleStreamDelta(data) {
  streamedAnyText = true;
  if (!streamingBubble) {
    // First delta of this turn — drop the typing indicator and create the bubble
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    const oracle = agents.find(a => a.id === 'oracle');
    const container = document.getElementById('gc-messages');
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.innerHTML = `
      <div class="msg-sender" style="color:${oracle.color}">${oracle.emoji} ${oracle.name}</div>
      <div class="msg-bubble" style="--msg-color:${oracle.color}"></div>`;
    container.appendChild(wrap);
    streamingBubble = wrap.querySelector('.msg-bubble');
  }
  streamingBuffer += data.delta;
  streamingBubble.innerHTML = formatContent(streamingBuffer);
  const container = document.getElementById('gc-messages');
  container.scrollTop = container.scrollHeight;
}

function handleStreamEnd() {
  streamingBubble = null;
}

function handleClarifyQ(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  appendGCClarifyQ(data);
  activeIndicator = appendGCTyping('#9b59b6');
}

function handleClarifyA(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const agent = agents.find(a => a.id === data.agentId);
  appendGCClarifyA(agent, data.answer);
  activeIndicator = appendGCTyping(agent?.color);
}

function appendGCClarifyQ(data) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="msg-sender" style="color:${data.agentColor}">${data.agentEmoji} ${data.agentName} asks Oracle</div>
    <div class="msg-bubble" style="--msg-color:${data.agentColor};font-style:italic">${formatContent(data.question)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendGCClarifyA(agent, answer) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="msg-sender" style="color:#9b59b6">🔮 Oracle answers ${agent?.emoji || ''} ${agent?.name || ''}</div>
    <div class="msg-bubble" style="--msg-color:#9b59b6">${formatContent(answer)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function handleHermesFile(data) {
  // Hermes auto-logging surfaces in the general chat as a subtle system note
  const icon = { raw: '📥', wiki: '📚', output: '📤' }[data.action] || '📄';
  appendGCSystemMsg(`📜 ${icon} ${data.path}`);
}

// ── World Map ─────────────────────────────────────────────────
function renderWorldMap() {
  stopWorldRoaming();
  const container = document.getElementById('locations-container');
  container.innerHTML = '';

  agents.forEach(agent => {
    const box = document.createElement('div');
    box.className = `room-box${agent.isCouncil ? ' council-box' : ''}`;
    box.id = `room-box-${agent.id}`;
    box.style.setProperty('--rb-color', agent.color);
    box.style.setProperty('--rb-glow', agent.glow);
    box.style.gridArea = agent.id;

    box.innerHTML = agent.isCouncil
      ? `<div class="room-box-label">
           <div class="room-box-name">${agent.name}</div>
           <div class="room-box-loc">${agent.location}</div>
         </div>
         <div class="council-map-hint">All agents gather here</div>`
      : `<div class="room-box-label">
           <div class="room-box-name">${agent.name}</div>
           <div class="room-box-loc">${agent.location}</div>
         </div>`;

    container.appendChild(box);
  });

  startWorldRoaming();
}

// ── World Map Roaming ─────────────────────────────────────────
function startWorldRoaming() {
  stopWorldRoaming();
  const councillors = agents.filter(a => !a.isCouncil);

  worldRoamers = councillors.map((agent) => {
    const roomEl = document.getElementById(`room-box-${agent.id}`);
    if (!roomEl) return null;
    const el = document.createElement('img');
    el.className = 'map-sprite';
    el.style.left = '50%';
    el.style.top  = '45%';
    roomEl.appendChild(el);
    const sprite = { agentId: agent.id, el, x: 50, y: 45, dir: 'south', frame: 0 };
    updateMapFrame(sprite);
    return sprite;
  }).filter(Boolean);

  worldFrameTimer = setInterval(() => {
    worldRoamers.forEach(s => { s.frame = (s.frame + 1) % 6; updateMapFrame(s); });
  }, 220);

  const intervals = [4000, 4300, 3800, 4600, 4200];
  const delays    = [200, 800, 1400, 500, 1100];
  worldRoamers.forEach((roamer, i) => {
    // Modulo so any number of agents stays staggered (was crashing past index 4)
    setTimeout(() => {
      moveMapSprite(roamer);
      const t = setInterval(() => moveMapSprite(roamer), intervals[i % intervals.length]);
      worldRoamTimers.push(t);
    }, delays[i % delays.length] + i * 200);
  });
}

// Track agents whose sprites are completely missing — skip future frame loads for them
const brokenSpriteAgents = new Set();

function stopWorldRoaming() {
  if (worldFrameTimer) { clearInterval(worldFrameTimer); worldFrameTimer = null; }
  worldRoamTimers.forEach(t => clearInterval(t));
  worldRoamTimers = [];
  worldRoamers.forEach(s => { if (s.el.isConnected) s.el.remove(); });
  worldRoamers = [];
}

function moveMapSprite(sprite) {
  if (!sprite.el.isConnected) return;
  const newX = 15 + Math.random() * 65;
  const newY = 18 + Math.random() * 52;
  const angle = Math.atan2(newY - sprite.y, newX - sprite.x) * (180 / Math.PI);
  sprite.dir = angleTo8Dir(angle);
  sprite.frame = 0;
  sprite.x = newX; sprite.y = newY;
  sprite.el.style.left = newX + '%';
  sprite.el.style.top  = newY + '%';
}

function updateMapFrame(sprite) {
  // Once we know an agent has no sprite assets, stop trying
  if (brokenSpriteAgents.has(sprite.agentId)) {
    if (sprite.el.style.display !== 'none') sprite.el.style.display = 'none';
    return;
  }
  const pad = String(sprite.frame).padStart(3, '0');
  const tryPaths = [
    `../assets/sprites/${sprite.agentId}/${sprite.dir}/frame_${pad}.png`,
    `../assets/sprites/${sprite.agentId}/${sprite.dir}.png`,
    `../assets/sprites/${sprite.agentId}.png`
  ];
  let idx = 0;
  const tryNext = () => {
    idx++;
    if (idx >= tryPaths.length) {
      // All fallbacks failed — mark agent as broken and stop hammering
      brokenSpriteAgents.add(sprite.agentId);
      sprite.el.style.display = 'none';
      sprite.el.onerror = null;
      return;
    }
    sprite.el.src = tryPaths[idx];
  };
  sprite.el.onerror = tryNext;
  sprite.el.src = tryPaths[0];
}

function angleTo8Dir(deg) {
  if (deg > -22.5  && deg <=  22.5)  return 'east';
  if (deg >  22.5  && deg <=  67.5)  return 'south-east';
  if (deg >  67.5  && deg <= 112.5)  return 'south';
  if (deg > 112.5  && deg <= 157.5)  return 'south-west';
  if (deg > 157.5  || deg <= -157.5) return 'west';
  if (deg > -157.5 && deg <= -112.5) return 'north-west';
  if (deg > -112.5 && deg <=  -67.5) return 'north';
  return 'north-east';
}

// ── Sidebar ───────────────────────────────────────────────────
function renderSidebar() {
  const agentList = document.getElementById('agent-list');
  agentList.innerHTML = '';

  const councillors = agents.filter(a => !a.isCouncil);
  councillors.forEach(agent => {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.id = `card-${agent.id}`;
    card.style.setProperty('--ac-color', agent.color);
    card.style.setProperty('--ac-glow', agent.glow);

    card.innerHTML = `
      <div class="ac-header">
        <span class="ac-emoji">${agent.emoji}</span>
        <div class="ac-info">
          <div class="ac-name">${agent.name}</div>
          <div class="ac-title">${agent.title}${agent.location ? ' · ' + agent.location : ''}</div>
          ${agent.pokemon ? `<div class="ac-pokemon">#${agent.pokemon}</div>` : ''}
        </div>
      </div>
      <div class="ac-description">${agent.description || ''}</div>`;

    agentList.appendChild(card);
  });

  // General chat setup
  const gcInput = document.getElementById('gc-input');
  gcInput.addEventListener('input', () => {
    gcInput.style.height = 'auto';
    gcInput.style.height = Math.min(gcInput.scrollHeight, 100) + 'px';
  });
  gcInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGeneralMessage(); }
  });
  document.getElementById('btn-gc-send').addEventListener('click', sendGeneralMessage);
  document.getElementById('btn-gc-clear').addEventListener('click', clearGeneralChat);

  appendGCSystemMsg('Claude is here. Ask anything.');
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      tabs.forEach(t => t.classList.toggle('active', t === btn));
      panes.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    });
  });
}

// ── General Chat ──────────────────────────────────────────────
let activeIndicator = null;

async function sendGeneralMessage() {
  const input = document.getElementById('gc-input');
  const sendBtn = document.getElementById('btn-gc-send');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  appendGCUserMsg(text);
  activeIndicator = appendGCTyping();
  streamedAnyText = false;

  try {
    const result = await window.api.routeMessage(text);
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    // If streaming painted text, the bubble's already there — skip duplicate render
    if (!streamedAnyText && result.finalReply) {
      const oracle = agents.find(a => a.id === 'oracle');
      appendGCAgentMsg(oracle, result.finalReply);
    }
  } catch (err) {
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    appendGCSystemMsg(`Error: ${err.message}`);
  }

  sendBtn.disabled = false;
  input.focus();
}

function handleConsulting(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const oracle = agents.find(a => a.id === 'oracle');
  appendGCConsultNote(oracle, data);
  activeIndicator = appendGCTyping(data.agentColor);
}

function handleConsulted(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const agent = agents.find(a => a.id === data.agentId);
  appendGCAgentMsg(agent, data.reply);
  activeIndicator = appendGCTyping();
}

function clearGeneralChat() {
  document.getElementById('gc-messages').innerHTML = '';
  appendGCSystemMsg('Claude is here. Ask anything.');
}

// ── General Chat DOM Helpers ──────────────────────────────────
function appendGCUserMsg(text) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `
    <div class="msg-sender">You</div>
    <div class="msg-bubble">${formatContent(text)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendGCAgentMsg(agent, content) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="msg-sender" style="color:${agent.color}">${agent.emoji} ${agent.name}</div>
    <div class="msg-bubble" style="--msg-color:${agent.color}">${formatContent(content)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendGCConsultNote(oracle, data) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'system-note';
  el.innerHTML = `— ${oracle.emoji} consulting <span style="color:${data.agentColor}">${data.agentEmoji} ${data.agentName}</span> —`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendGCSystemMsg(text) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'system-note';
  el.textContent = `— ${text} —`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendGCTyping(color) {
  const container = document.getElementById('gc-messages');
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.style.setProperty('--room-color', color || '#9b59b6');
  el.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// ── Content Formatting ────────────────────────────────────────
function formatContent(text) {
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\n/g, '<br>');
  return text;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Sidebar Horizontal Resize ─────────────────────────────────
function setupSidebarResize() {
  const handle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  const app = document.getElementById('app');
  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener('mousedown', e => {
    if (app.classList.contains('sidebar-full')) return;
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Sidebar is on the right, so dragging LEFT increases width
    const newW = startW + (startX - e.clientX);
    const max = window.innerWidth - 200;
    sidebar.style.width = Math.max(260, Math.min(max, newW)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Double-click handle to reset to default width
  handle.addEventListener('dblclick', () => {
    if (app.classList.contains('sidebar-full')) return;
    sidebar.style.width = '340px';
  });
}

// ── Fullscreen Toggle ─────────────────────────────────────────
function setupFullscreenToggle() {
  const btn = document.getElementById('btn-gc-expand');
  const app = document.getElementById('app');
  if (!btn || !app) return;
  btn.addEventListener('click', () => {
    const isFull = app.classList.toggle('sidebar-full');
    btn.textContent = isFull ? '⤢' : '⛶';
    btn.title = isFull ? 'Exit fullscreen' : 'Toggle fullscreen';
  });
}

// ── Window Controls ───────────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());
}

document.addEventListener('DOMContentLoaded', init);
