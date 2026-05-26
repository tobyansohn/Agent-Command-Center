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
  setupResizeHandle();
  window.api.onConsulting(handleConsulting);
  window.api.onConsulted(handleConsulted);
  window.api.onClarifyQ(handleClarifyQ);
  window.api.onClarifyA(handleClarifyA);
  window.api.onHermesFile(handleHermesFile);
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
  const card = document.getElementById('card-hermes');
  if (!card) return;
  const msgs = card.querySelector('.ac-messages');
  if (!msgs) return;
  const icon = { raw: '📥', wiki: '📚', output: '📤' }[data.action] || '📄';
  appendACSystemMsg(msgs, `${icon} ${data.path}`);
  msgs.scrollTop = msgs.scrollHeight;
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
    setTimeout(() => {
      moveMapSprite(roamer);
      const t = setInterval(() => moveMapSprite(roamer), intervals[i]);
      worldRoamTimers.push(t);
    }, delays[i]);
  });
}

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
  const pad = String(sprite.frame).padStart(3, '0');
  const animPath = `../assets/sprites/${sprite.agentId}/${sprite.dir}/frame_${pad}.png`;
  const fallback = `../assets/sprites/${sprite.agentId}/${sprite.dir}.png`;
  sprite.el.onerror = () => { sprite.el.onerror = null; sprite.el.src = fallback; };
  sprite.el.src = animPath;
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
  agentList.innerHTML = '<div class="section-header"><span class="section-title">AGENTS</span></div>';

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
          <div class="ac-title">${agent.title}</div>
        </div>
        <button class="ac-toggle">▼</button>
      </div>
      <div class="ac-chat hidden">
        <div class="ac-messages"></div>
        <div class="chat-input-area">
          <textarea class="ac-input chat-textarea" placeholder="Ask ${agent.name}..." rows="1"></textarea>
          <button class="ac-send chat-send">→</button>
        </div>
      </div>`;

    card.querySelector('.ac-header').addEventListener('click', () => toggleAgentCard(agent, card));

    const input = card.querySelector('.ac-input');
    const sendBtn = card.querySelector('.ac-send');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 80) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMiniMessage(agent, card); }
    });
    sendBtn.addEventListener('click', () => sendMiniMessage(agent, card));

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

async function toggleAgentCard(agent, card) {
  const chat = card.querySelector('.ac-chat');
  const isHidden = chat.classList.contains('hidden');

  if (isHidden) {
    chat.classList.remove('hidden');
    card.classList.add('expanded');
    const msgs = card.querySelector('.ac-messages');
    if (msgs.children.length === 0) {
      const history = await window.api.getMemory(agent.id);
      if (history.length === 0) {
        appendACSystemMsg(msgs, `${agent.emoji} ${agent.name} ready`);
      } else {
        history.forEach(m => appendACMsg(msgs, m.role, m.content, agent));
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
    card.querySelector('.ac-input').focus();
  } else {
    chat.classList.add('hidden');
    card.classList.remove('expanded');
  }
}

async function sendMiniMessage(agent, card) {
  const input = card.querySelector('.ac-input');
  const sendBtn = card.querySelector('.ac-send');
  const msgs = card.querySelector('.ac-messages');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  appendACMsg(msgs, 'user', text, agent);
  const indicator = appendACTyping(msgs, agent);

  try {
    const reply = await window.api.sendMessage(agent.id, text);
    indicator.remove();
    appendACMsg(msgs, 'assistant', reply, agent);
  } catch (err) {
    indicator.remove();
    appendACSystemMsg(msgs, `Error: ${err.message}`);
  }

  sendBtn.disabled = false;
  input.focus();
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

  try {
    const result = await window.api.routeMessage(text);
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    const oracle = agents.find(a => a.id === 'oracle');
    if (result.finalReply) appendGCAgentMsg(oracle, result.finalReply);
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

// ── Mini Chat DOM Helpers ─────────────────────────────────────
function appendACMsg(container, role, content, agent) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const senderStyle = role === 'assistant' ? `style="color:${agent.color}"` : '';
  const bubbleStyle = role === 'assistant' ? `style="--msg-color:${agent.color}"` : '';
  el.innerHTML = `
    <div class="msg-sender" ${senderStyle}>${role === 'user' ? 'You' : `${agent.emoji} ${agent.name}`}</div>
    <div class="msg-bubble" ${bubbleStyle}>${formatContent(content)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendACSystemMsg(container, text) {
  const el = document.createElement('div');
  el.className = 'system-note';
  el.textContent = `— ${text} —`;
  container.appendChild(el);
}

function appendACTyping(container, agent) {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.style.setProperty('--room-color', agent.color);
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

// ── Resize Handle ─────────────────────────────────────────────
function setupResizeHandle() {
  const handle = document.getElementById('gc-resize');
  const chat = document.getElementById('general-chat');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !chat || !sidebar) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = chat.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const sidebarH = sidebar.getBoundingClientRect().height;
    const newH = startH + (e.clientY - startY);
    const clamped = Math.max(120, Math.min(sidebarH - 140, newH));
    chat.style.height = clamped + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Double-click to maximize the chat (with toggle back)
  let savedH = null;
  handle.addEventListener('dblclick', () => {
    const sidebarH = sidebar.getBoundingClientRect().height;
    const current = chat.getBoundingClientRect().height;
    if (savedH !== null) {
      chat.style.height = savedH + 'px';
      savedH = null;
    } else {
      savedH = current;
      chat.style.height = (sidebarH - 140) + 'px';
    }
  });
}

// ── Window Controls ───────────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());
}

document.addEventListener('DOMContentLoaded', init);
