let agents = [];

// World map roaming
let worldRoamers       = [];
let worldRafId         = null;
let worldResizeHandler = null;

// Preloaded sprite frames: agentId -> { dir: [src, ...] }. Built once at init so
// the animation loop never triggers a network fetch or image re-decode.
const spriteFrames = {};
// Agents whose sprite assets are entirely missing — skip them in the loop.
const brokenSpriteAgents = new Set();

const SPRITE_SCALE = { smith: 3.8, analyst: 3.8, hermes: 3.8, muse: 3.8 };
const MOVE_DUR_MS   = 3500;  // matches the CSS transition duration
const WALK_FRAME_MS = 160;   // walk-cycle frame cadence (only while moving)
const FRAME_CAP     = 16;    // max frames probed per direction
const DIRS_8 = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [agentList, worldInfo] = await Promise.all([
    window.api.getAgents(),
    window.api.getWorldInfo()
  ]);
  agents = agentList;
  document.getElementById('world-title').textContent = worldInfo.name.toUpperCase();
  await preloadAllSprites();
  renderWorldMap();
  renderSidebar();
  setupWindowControls();
  setupSidebarResize();
  setupFullscreenToggle();
  setupTabs();
  window.api.onConsulting(handleConsulting);
  window.api.onConsultDelta(handleConsultDelta);
  window.api.onConsulted(handleConsulted);
  window.api.onClarifyQ(handleClarifyQ);
  window.api.onClarifyA(handleClarifyA);
  window.api.onRecall(handleRecall);
  window.api.onStreamStart(handleStreamStart);
  window.api.onStreamDelta(handleStreamDelta);
  window.api.onStreamEnd(handleStreamEnd);
  window.api.onHermesFile(handleHermesFile);
  setupLibrary();
  setupArtifacts();
  setupAgentChat();
  setupCommandPalette();
  setupSound();
  setInterval(updateDayNight, 10 * 60 * 1000);
}

function handleRecall(data) {
  // Subtle note in the chat so user can see what context Oracle pulled in
  if (!data.files || data.files.length === 0) return;
  appendGCSystemMsg(`📖 recalling: ${data.files.join(', ')}`);
}

// ── Oracle Streaming ──────────────────────────────────────────
let streamingBubble = null;
let streamingBuffer = '';
let streamedAnyText = false;

function handleStreamStart() {
  // New Oracle turn — close any prior bubble so next delta opens a fresh one
  streamingBubble = null;
  streamingBuffer = '';
  const oracle = agents.find(a => a.id === 'oracle');
  setChatBleed(oracle?.color || '#9b59b6');
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
  // If Oracle's still going (tool call coming next, or final synthesis), keep an
  // indicator up so the user knows the request didn't die between turns.
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  activeIndicator = appendGCTyping('#9b59b6', 'Claude is thinking…');
}

function handleClarifyQ(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  appendGCClarifyQ(data);
  activeIndicator = appendGCTyping('#9b59b6', `Claude is answering ${data.agentName}…`);
}

function handleClarifyA(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const agent = agents.find(a => a.id === data.agentId);
  appendGCClarifyA(agent, data.answer);
  activeIndicator = appendGCTyping(agent?.color, `${agent?.name || 'Specialist'} is continuing…`);
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
  // Hermes filesystem operations surface in the general chat as subtle system notes
  const verbs = {
    raw:    { icon: '📥', verb: 'logged' },
    wiki:   { icon: '📚', verb: 'wrote'  },
    output: { icon: '📤', verb: 'saved'  },
    create: { icon: '✨', verb: 'created'},
    move:   { icon: '🔀', verb: 'moved'  },
    delete: { icon: '🗑️', verb: 'deleted'},
    read:   { icon: '👁️', verb: 'read'   }
  };
  const m = verbs[data.action] || { icon: '📄', verb: data.action };
  let body;
  if (data.action === 'move' && data.from) body = `${data.from} → ${data.path}`;
  else body = data.path;
  appendGCSystemMsg(`📜 ${m.icon} ${m.verb} ${body}`);
  // Refresh library tree on any write/move/delete so the sidebar stays current,
  // and briefly light up the affected folder (Lyra: "the Library breathes")
  if (data.action !== 'read') {
    const folder = ['raw', 'wiki', 'output'].includes(data.action)
      ? data.action
      : (String(data.path || '').match(/(?:library\/)?(raw|wiki|output)\//)?.[1] || null);
    refreshLibrary(folder);
  }
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
    if (agent.background) {
      box.style.backgroundImage = `url('../assets/${agent.background}')`;
    }

    box.innerHTML = agent.isCouncil
      ? ''
      : `<div class="room-box-label">
           <div class="room-box-name">${agent.name}</div>
           <div class="room-box-loc">${agent.location}</div>
         </div>`;

    // Ambient reactive glow (all rooms) + floating particles (specialist rooms)
    const glow = document.createElement('div');
    glow.className = 'room-glow';
    glow.style.setProperty('--g-color', agent.color);
    box.appendChild(glow);
    if (!agent.isCouncil) addRoomParticles(box, agent);

    container.appendChild(box);
  });

  updateDayNight();
  startWorldRoaming();
}

// Embers for the hot/martial rooms, gentle motes elsewhere. Pure CSS animation
// once created — no per-frame JS.
function addRoomParticles(box, agent) {
  const layer = document.createElement('div');
  layer.className = 'room-particles';
  layer.style.setProperty('--p-color', agent.color);
  const ember = agent.id === 'smith' || agent.id === 'strategist';
  const count = ember ? 9 : 6;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const rise = ember ? -(140 + Math.random() * 80) : -(90 + Math.random() * 90);
    p.style.left = `${8 + Math.random() * 84}%`;
    p.style.setProperty('--p-rise', `${rise}px`);
    p.style.setProperty('--p-drift', `${(Math.random() - 0.5) * 24}px`);
    p.style.setProperty('--p-dur', `${(ember ? 3.5 : 6) + Math.random() * 4}s`);
    p.style.setProperty('--p-delay', `${Math.random() * 6}s`);
    p.style.setProperty('--p-max', `${ember ? 0.85 : 0.5}`);
    layer.appendChild(p);
  }
  box.appendChild(layer);
}

// Tints the whole scene by real-world hour via a soft-light overlay.
function updateDayNight() {
  const el = document.getElementById('day-night');
  if (!el) return;
  const h = new Date().getHours();
  let color;
  if (h >= 6 && h < 9)        color = 'rgba(255, 180, 120, 0.22)'; // dawn — warm
  else if (h >= 9 && h < 17)  color = 'rgba(180, 200, 255, 0.06)'; // day — faint cool
  else if (h >= 17 && h < 20) color = 'rgba(255, 140, 80, 0.22)';  // dusk — orange
  else                        color = 'rgba(40, 50, 100, 0.40)';   // night — deep blue
  el.style.background = color;
}

function setRoomActive(id, on) {
  document.getElementById(`room-box-${id}`)?.classList.toggle('is-active', on);
}

// Lyra: the conversation panel tints ~4% toward whoever is currently speaking.
function setChatBleed(color) {
  const el = document.getElementById('gc-messages');
  if (!el) return;
  el.style.background = color ? `color-mix(in srgb, ${color} 5%, transparent)` : '';
}

// Safety net run at the end of every turn: clears any world-activity state that a
// failed/aborted consultation might have left dangling (stuck council glow, beams,
// thinking auras, sprites stranded in the council).
function resetWorldActivity() {
  activeConsults = 0;
  setRoomActive('council', false);
  const svg = document.getElementById('map-beams');
  if (svg) svg.innerHTML = '';
  worldRoamers.forEach(s => {
    s.el.classList.remove('is-thinking');
    if (s.currentRoom === 'council') sendSpriteHome(s.agentId);
  });
}

// ── Sprite Frame Preloading ───────────────────────────────────
function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Probe + cache every frame an agent has. Tries per-direction frame folders
// first, then a single per-direction png, then a single per-agent png.
async function preloadSpriteFrames(agentId) {
  const cache = {};
  await Promise.all(DIRS_8.map(async dir => {
    const probes = await Promise.all(
      Array.from({ length: FRAME_CAP }, (_, i) =>
        loadImage(`../assets/sprites/${agentId}/${dir}/frame_${String(i).padStart(3, '0')}.png`))
    );
    const frames = [];
    for (const src of probes) { if (!src) break; frames.push(src); } // keep contiguous run from 0
    if (frames.length) { cache[dir] = frames; return; }
    const single = await loadImage(`../assets/sprites/${agentId}/${dir}.png`);
    if (single) cache[dir] = [single];
  }));
  if (Object.keys(cache).length === 0) {
    const fallback = await loadImage(`../assets/sprites/${agentId}.png`);
    if (fallback) cache['*'] = [fallback];
  }
  return Object.keys(cache).length ? cache : null;
}

async function preloadAllSprites() {
  await Promise.all(agents.filter(a => !a.isCouncil).map(async a => {
    const cache = await preloadSpriteFrames(a.id);
    if (cache) spriteFrames[a.id] = cache;
    else brokenSpriteAgents.add(a.id);
  }));
}

function frameSrc(agentId, dir, frame) {
  const cache = spriteFrames[agentId];
  if (!cache) return null;
  const frames = cache[dir] || cache['south'] || cache['*'] || Object.values(cache)[0];
  if (!frames || !frames.length) return null;
  return frames[frame % frames.length];
}

function scaleFor(agentId) { return SPRITE_SCALE[agentId] || 3; }

// ── World Map Roaming ─────────────────────────────────────────
function startWorldRoaming() {
  stopWorldRoaming();
  const councillors = agents.filter(a => !a.isCouncil);
  const now = performance.now();

  worldRoamers = councillors.map((agent, i) => {
    const roomEl = document.getElementById(`room-box-${agent.id}`);
    if (!roomEl) return null;
    const band = FLOOR_BANDS[agent.id] || { xMin: 40, xMax: 60, yMin: 70, yMax: 80 };

    const el = document.createElement('div');
    el.className = 'map-sprite';
    el.style.setProperty('--sprite-color', agent.color || '#9b59b6');
    const img = document.createElement('img');
    img.className = 'map-sprite-img';
    img.alt = '';
    el.appendChild(img);
    roomEl.appendChild(el);

    const sprite = {
      agentId: agent.id, el, img,
      x: (band.xMin + band.xMax) / 2,
      y: (band.yMin + band.yMax) / 2,
      dir: 'south', frame: 0, curSrc: null,
      scale: scaleFor(agent.id),
      moving: false, moveEndsAt: 0,
      nextMoveAt: now + 200 + i * 220,  // staggered first step
      lastFrameAt: 0,
      currentRoom: agent.id, homeRoom: agent.id
    };
    applySpriteTransform(sprite, true);
    setSpriteFrame(sprite);
    return sprite;
  }).filter(Boolean);

  worldResizeHandler = () => worldRoamers.forEach(s => applySpriteTransform(s, true));
  window.addEventListener('resize', worldResizeHandler);

  // Re-snap once after layout settles — grid aspect-ratio sizing isn't final on
  // the first synchronous pass, so initial px positions can be off by a frame.
  requestAnimationFrame(() => worldRoamers.forEach(s => applySpriteTransform(s, true)));

  worldRafId = requestAnimationFrame(worldTick);
}

// Single rAF loop drives both movement scheduling and walk-cycle frames for
// every sprite — replaces the previous bank of setInterval timers.
function worldTick(now) {
  for (const s of worldRoamers) {
    if (!s.el.isConnected) continue;
    if (now >= s.nextMoveAt && !s.moving) moveMapSprite(s, now);
    if (s.moving && now >= s.moveEndsAt) {
      s.moving = false;
      s.el.classList.remove('is-moving');
      s.frame = 0;
      setSpriteFrame(s);   // settle onto the standing frame; idle bob takes over
    }
    if (s.moving && now - s.lastFrameAt >= WALK_FRAME_MS) {
      s.frame++;
      s.lastFrameAt = now;
      setSpriteFrame(s);
    }
  }
  worldRafId = requestAnimationFrame(worldTick);
}

function stopWorldRoaming() {
  if (worldRafId) { cancelAnimationFrame(worldRafId); worldRafId = null; }
  if (worldResizeHandler) { window.removeEventListener('resize', worldResizeHandler); worldResizeHandler = null; }
  worldRoamers.forEach(s => { if (s.el.isConnected) s.el.remove(); });
  worldRoamers = [];
}

// Position the sprite via a compositor-friendly transform (translate + scale)
// instead of animating left/top. Pass snap=true for instant placement (init,
// resize, room changes); omit it so travel animates via the CSS transition.
function applySpriteTransform(sprite, snap = false) {
  const parent = sprite.el.parentElement;
  if (!parent) return;
  const s  = sprite.scale;
  const px = (parent.clientWidth  * sprite.x / 100) - 24 * s;
  const py = (parent.clientHeight * sprite.y / 100) - 24 * s;
  if (snap) {
    sprite.el.classList.add('snapping');
    sprite.el.style.transform = `translate(${px}px, ${py}px) scale(${s})`;
    void sprite.el.offsetWidth; // flush so the snap lands before transitions resume
    sprite.el.classList.remove('snapping');
  } else {
    sprite.el.style.transform = `translate(${px}px, ${py}px) scale(${s})`;
  }
}

function setSpriteFrame(sprite) {
  if (brokenSpriteAgents.has(sprite.agentId)) {
    if (sprite.el.style.display !== 'none') sprite.el.style.display = 'none';
    return;
  }
  const src = frameSrc(sprite.agentId, sprite.dir, sprite.frame);
  if (!src) { sprite.el.style.display = 'none'; return; }
  if (sprite.curSrc !== src) { sprite.img.src = src; sprite.curSrc = src; }
}

// ── Consultation Beams & Thinking State ───────────────────────
// Draw an animated energy beam between two rooms' centers. Keyed by agentId so
// concurrent consultations each get their own removable beam.
function drawBeam(fromId, toId, color, key) {
  const svg = document.getElementById('map-beams');
  const map = document.getElementById('world-map');
  const fromEl = document.getElementById(`room-box-${fromId}`);
  const toEl   = document.getElementById(`room-box-${toId}`);
  if (!svg || !map || !fromEl || !toEl) return;

  const m = map.getBoundingClientRect();
  svg.setAttribute('width', m.width);
  svg.setAttribute('height', m.height);
  svg.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);

  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('class', 'map-beam');
  line.setAttribute('x1', a.left + a.width / 2 - m.left);
  line.setAttribute('y1', a.top + a.height / 2 - m.top);
  line.setAttribute('x2', b.left + b.width / 2 - m.left);
  line.setAttribute('y2', b.top + b.height / 2 - m.top);
  line.setAttribute('stroke', color || '#9b59b6');
  line.style.setProperty('--beam-color', color || '#9b59b6');
  line.dataset.beamKey = key;

  clearBeam(key);
  svg.appendChild(line);
}

function clearBeam(key) {
  const svg = document.getElementById('map-beams');
  if (!svg) return;
  svg.querySelectorAll(`[data-beam-key="${key}"]`).forEach(n => {
    n.classList.add('beam-out');
    setTimeout(() => n.remove(), 300);
  });
}

function setThinking(agentId, on) {
  const sprite = worldRoamers.find(s => s.agentId === agentId);
  if (sprite) sprite.el.classList.toggle('is-thinking', on);
}

// Per-room walkable floor bands (% of room cell). Tuned to each background's
// floor area so sprites don't clip through furniture/walls.
const FLOOR_BANDS = {
  oracle:     { xMin: 28, xMax: 72, yMin: 58, yMax: 88 },
  scholar:    { xMin: 28, xMax: 72, yMin: 62, yMax: 88 },
  smith:      { xMin: 22, xMax: 78, yMin: 58, yMax: 88 },
  strategist: { xMin: 28, xMax: 72, yMin: 60, yMax: 88 },
  herald:     { xMin: 22, xMax: 78, yMin: 58, yMax: 90 },
  muse:       { xMin: 32, xMax: 68, yMin: 58, yMax: 86 },
  analyst:    { xMin: 32, xMax: 75, yMin: 58, yMax: 88 },
  hermes:     { xMin: 22, xMax: 75, yMin: 60, yMax: 88 },
  council:    { xMin: 18, xMax: 82, yMin: 58, yMax: 90 }
};

// Distinct council floor slots so multiple visiting agents don't stack on top of each other
const COUNCIL_VISITOR_SLOTS = [
  { x: 28, y: 78 }, { x: 42, y: 82 }, { x: 58, y: 82 }, { x: 72, y: 78 },
  { x: 32, y: 66 }, { x: 68, y: 66 }, { x: 50, y: 86 }, { x: 22, y: 70 }
];
let nextVisitorSlot = 0;

function sendSpriteToCouncil(agentId) {
  const sprite = worldRoamers.find(s => s.agentId === agentId);
  const council = document.getElementById('room-box-council');
  if (!sprite || !council) return;
  if (!sprite.homeRoom) sprite.homeRoom = sprite.agentId;
  sprite.currentRoom = 'council';
  council.appendChild(sprite.el);
  const slot = COUNCIL_VISITOR_SLOTS[nextVisitorSlot++ % COUNCIL_VISITOR_SLOTS.length];
  sprite.x = slot.x; sprite.y = slot.y;
  sprite.moving = false;
  sprite.el.classList.remove('is-moving');
  sprite.frame = 0;
  sprite.nextMoveAt = performance.now() + 1500 + Math.random() * 1500;
  applySpriteTransform(sprite, true); // snap into the new room's coordinate space
  setSpriteFrame(sprite);
}

function sendSpriteHome(agentId) {
  const sprite = worldRoamers.find(s => s.agentId === agentId);
  if (!sprite) return;
  const homeId = sprite.homeRoom || sprite.agentId;
  const home = document.getElementById(`room-box-${homeId}`);
  if (!home) return;
  sprite.currentRoom = homeId;
  home.appendChild(sprite.el);
  const band = FLOOR_BANDS[homeId] || { xMin: 40, xMax: 60, yMin: 70, yMax: 80 };
  sprite.x = (band.xMin + band.xMax) / 2;
  sprite.y = (band.yMin + band.yMax) / 2;
  sprite.moving = false;
  sprite.el.classList.remove('is-moving');
  sprite.frame = 0;
  sprite.nextMoveAt = performance.now() + 800 + Math.random() * 1500;
  applySpriteTransform(sprite, true);
  setSpriteFrame(sprite);
}

function moveMapSprite(sprite, now) {
  if (!sprite.el.isConnected) return;
  const roomId = sprite.currentRoom || sprite.agentId;
  const b = FLOOR_BANDS[roomId] || { xMin: 15, xMax: 80, yMin: 18, yMax: 70 };
  const newX = b.xMin + Math.random() * (b.xMax - b.xMin);
  const newY = b.yMin + Math.random() * (b.yMax - b.yMin);
  const angle = Math.atan2(newY - sprite.y, newX - sprite.x) * (180 / Math.PI);
  sprite.dir = angleTo8Dir(angle);
  sprite.x = newX; sprite.y = newY;
  sprite.moving = true;
  sprite.moveEndsAt = now + MOVE_DUR_MS;
  sprite.nextMoveAt = sprite.moveEndsAt + 600 + Math.random() * 2200; // pause, then wander again
  sprite.lastFrameAt = now;
  sprite.el.classList.add('is-moving');
  applySpriteTransform(sprite);  // animates via CSS transition
  setSpriteFrame(sprite);
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
      <div class="ac-description">${agent.description || ''}</div>
      <div class="ac-chat-hint">▸ CLICK TO CHAT DIRECTLY</div>`;

    card.addEventListener('click', () => openAgentChat(agent.id));
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

function findAgentByToken(token) {
  const t = token.toLowerCase();
  return agents.find(a => !a.isCouncil && a.id !== 'oracle' && (
    a.id === t ||
    a.name?.toLowerCase().split(/\s+/)[0] === t ||
    a.pokemon?.toLowerCase() === t
  ));
}

// Rewrite "@forge ..." or "/forge ..." into a command the backend's forced-tool
// router understands, so the user can address a specialist directly.
function resolveMention(text) {
  const m = text.match(/^[@/](\w+)\s+([\s\S]+)$/);
  if (!m) return text;
  const agent = findAgentByToken(m[1]);
  return agent ? `ask ${agent.id} ${m[2]}` : text;
}

async function sendGeneralMessage() {
  const input = document.getElementById('gc-input');
  const sendBtn = document.getElementById('btn-gc-send');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  appendGCUserMsg(text);
  activeIndicator = appendGCTyping('#9b59b6', 'Claude is thinking…');
  streamedAnyText = false;
  setRoomActive('oracle', true);
  document.getElementById('app').classList.add('processing');
  const turnStart = performance.now();

  try {
    const result = await window.api.routeMessage(resolveMention(text));
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    // If streaming painted text, the bubble's already there — skip duplicate render
    if (!streamedAnyText && result.finalReply) {
      const oracle = agents.find(a => a.id === 'oracle');
      appendGCAgentMsg(oracle, result.finalReply);
    }
    // Capture Oracle's final reply as an artifact if it's substantive.
    // Consultations already captured in handleConsulted as they arrive.
    if (result?.finalReply) addArtifact('oracle', result.finalReply);
    appendGCDoneMarker(turnStart, result?.consultations?.length || 0);
  } catch (err) {
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    appendGCSystemMsg(`Error: ${err.message}`);
    appendGCDoneMarker(turnStart, 0, true);
  }

  setRoomActive('oracle', false);
  document.getElementById('app').classList.remove('processing');
  setChatBleed(null);
  resetWorldActivity();
  sendBtn.disabled = false;
  input.focus();
}

function appendGCDoneMarker(startMs, consultCount, errored=false) {
  const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);
  const symbol = errored ? '✕' : '✓';
  const verb = errored ? 'failed' : 'done';
  const parts = [`${symbol} ${verb} in ${elapsed}s`];
  if (!errored && consultCount > 0) {
    parts.push(`${consultCount} consultation${consultCount === 1 ? '' : 's'}`);
  }
  appendGCSystemMsg(parts.join(' · '));
}

let activeConsults = 0;

function handleConsulting(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const oracle = agents.find(a => a.id === 'oracle');
  appendGCConsultNote(oracle, data);
  activeIndicator = appendGCTyping(data.agentColor, `${data.agentName} is thinking…`);
  sendSpriteToCouncil(data.agentId);
  drawBeam(data.agentId, 'council', data.agentColor, data.agentId);
  setThinking(data.agentId, true);
  activeConsults++;
  setRoomActive('council', true);
  sfxConsultStart();
}

// Live specialist streaming — one bubble per agent, keyed so parallel
// consultations don't clobber each other.
const consultBubbles = {};

function handleConsultDelta(data) {
  let entry = consultBubbles[data.agentId];
  if (!entry) {
    if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
    const agent = agents.find(a => a.id === data.agentId);
    const container = document.getElementById('gc-messages');
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.innerHTML = `
      <div class="msg-sender" style="color:${agent?.color}">${agent?.emoji || ''} ${agent?.name || ''}</div>
      <div class="msg-bubble" style="--msg-color:${agent?.color}"></div>`;
    container.appendChild(wrap);
    entry = consultBubbles[data.agentId] = { bubble: wrap.querySelector('.msg-bubble'), buffer: '' };
    setChatBleed(agent?.color);
  }
  entry.buffer += data.delta;
  entry.bubble.innerHTML = formatContent(entry.buffer);
  const container = document.getElementById('gc-messages');
  container.scrollTop = container.scrollHeight;
}

function handleConsulted(data) {
  if (activeIndicator) { activeIndicator.remove(); activeIndicator = null; }
  const agent = agents.find(a => a.id === data.agentId);
  const entry = consultBubbles[data.agentId];
  if (entry) {
    // Replace the streamed buffer with the authoritative final reply
    entry.bubble.innerHTML = formatContent(data.reply);
    delete consultBubbles[data.agentId];
  } else {
    appendGCAgentMsg(agent, data.reply);
  }
  addArtifact(data.agentId, data.reply);
  activeIndicator = appendGCTyping('#9b59b6', 'Claude is synthesizing…');
  setChatBleed('#9b59b6'); // back to the Oracle's hue while she synthesizes
  setThinking(data.agentId, false);
  clearBeam(data.agentId);
  sendSpriteHome(data.agentId);
  activeConsults = Math.max(0, activeConsults - 1);
  if (activeConsults === 0) setRoomActive('council', false);
  sfxConsultDone();
}

function clearGeneralChat() {
  document.getElementById('gc-messages').innerHTML = '';
  for (const k of Object.keys(consultBubbles)) delete consultBubbles[k];
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

function buildTypingIndicator(color, label) {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.style.setProperty('--room-color', color || '#9b59b6');
  const dots = '<div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  const text = label ? `<span class="typing-label">${escapeHtml(label)}</span>` : '';
  el.innerHTML = dots + text;
  return el;
}

function appendGCTyping(color, label) {
  const container = document.getElementById('gc-messages');
  const el = buildTypingIndicator(color, label);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// ── Content Formatting ────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline formatting on an already-HTML-escaped string: code, links, bold, italic.
function renderInline(text) {
  let t = text;
  // Protect inline code first so its contents aren't touched by other rules
  const code = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { code.push(c); return `\x00${code.length - 1}\x00`; });
  // Links [label](url) — only safe schemes, otherwise render label as plain text
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = /^(https?:|mailto:)/i.test(url) ? url : null;
    return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Single * italic (underscores left alone so snake_case survives)
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => `<code>${code[+i]}</code>`);
  return t;
}

// Lightweight block-level markdown → HTML. Handles fenced code, headings, lists,
// blockquotes, horizontal rules, and paragraphs. Safe for streaming: re-running
// on a growing buffer just reflows.
function formatContent(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const isBlockStart = l =>
    /^```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) ||
    /^\s*[-*+]\s/.test(l) || /^\s*\d+\.\s/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l) ||
    /^\s*\|.*\|\s*$/.test(l);
  const tableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const splitRow = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  let html = '';
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }

    // GFM table: a pipe row followed by a |---|---| separator
    if (tableRow(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeList();
      const headers = splitRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && tableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const thead = '<thead><tr>' + headers.map(c => `<th>${renderInline(escapeHtml(c))}</th>`).join('') + '</tr></thead>';
      const tbody = '<tbody>' + rows.map(r => '<tr>' + r.map(c => `<td>${renderInline(escapeHtml(c))}</td>`).join('') + '</tr>').join('') + '</tbody>';
      html += `<table class="md-table">${thead}${tbody}</table>`;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${renderInline(escapeHtml(h[2]))}</h${h[1].length}>`; i++; continue; }

    if (/^\s*>/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${buf.map(l => renderInline(escapeHtml(l))).join('<br>')}</blockquote>`;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${renderInline(escapeHtml(ul[1]))}</li>`; i++; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${renderInline(escapeHtml(ol[1]))}</li>`; i++; continue; }

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // Paragraph: gather consecutive non-block lines
    closeList();
    const para = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    html += `<p>${para.map(l => renderInline(escapeHtml(l))).join('<br>')}</p>`;
  }
  closeList();
  return html;
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
    sidebar.style.width = '680px';
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

// ── Library Sidebar ───────────────────────────────────────────
let libraryData = { raw: [], wiki: [], output: [] };
let libraryCollapsed = { raw: false, wiki: false, output: false };
let librarySearch = '';
let libReadingMode = true; // open files as a lit "paper" page by default (Lyra)

function setupLibrary() {
  const refreshBtn = document.getElementById('btn-lib-refresh');
  const searchInput = document.getElementById('lib-search');
  const modalClose = document.getElementById('btn-lib-modal-close');
  const modeBtn = document.getElementById('btn-lib-mode');
  const modal = document.getElementById('lib-modal');

  refreshBtn?.addEventListener('click', () => refreshLibrary());
  searchInput?.addEventListener('input', (e) => {
    librarySearch = e.target.value;
    renderLibraryTree();
  });
  modalClose?.addEventListener('click', closeLibraryModal);
  modeBtn?.addEventListener('click', () => {
    libReadingMode = !libReadingMode;
    applyLibReadingMode();
  });
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeLibraryModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeLibraryModal();
  });

  refreshLibrary();
}

// Flip the loaded file body between dark and paper without re-fetching.
function applyLibReadingMode() {
  const bodyEl = document.getElementById('lib-modal-body');
  const modeBtn = document.getElementById('btn-lib-mode');
  if (bodyEl.classList.contains('loading') || bodyEl.classList.contains('error')) return;
  bodyEl.classList.toggle('reading', libReadingMode);
  if (modeBtn) modeBtn.textContent = libReadingMode ? '🌙 Dark' : '📄 Paper';
}

async function refreshLibrary(flashFolder) {
  try {
    libraryData = await window.api.libraryList() || { raw: [], wiki: [], output: [] };
  } catch {
    libraryData = { raw: [], wiki: [], output: [] };
  }
  renderLibraryTree();
  if (flashFolder) {
    const btn = document.querySelector(`.lib-folder-btn[data-folder="${flashFolder}"]`);
    if (btn) { btn.classList.add('just-updated'); setTimeout(() => btn.classList.remove('just-updated'), 2000); }
  }
}

function renderLibraryTree() {
  const tree = document.getElementById('lib-tree');
  if (!tree) return;
  const folders = ['wiki', 'output', 'raw'];
  const chevrons = { open: '▼', closed: '▶' };
  const folderIcons = { wiki: '📚', output: '📤', raw: '📥' };
  const q = librarySearch.toLowerCase();

  tree.innerHTML = '';
  for (const folder of folders) {
    const all = libraryData[folder] || [];
    const files = q ? all.filter(f => f.toLowerCase().includes(q)) : all;
    const isCollapsed = !!libraryCollapsed[folder];

    const folderEl = document.createElement('div');
    folderEl.className = 'lib-folder';
    folderEl.innerHTML = `
      <button class="lib-folder-btn" data-folder="${folder}">
        <span>${folderIcons[folder]}</span>
        <span class="lib-folder-name">${folder}/</span>
        <span class="lib-folder-count">${files.length}</span>
        <span class="lib-folder-chev">${isCollapsed ? chevrons.closed : chevrons.open}</span>
      </button>
      <ul class="lib-folder-list ${isCollapsed ? 'collapsed' : ''}"></ul>
    `;
    const btn = folderEl.querySelector('.lib-folder-btn');
    btn.addEventListener('click', () => {
      libraryCollapsed[folder] = !libraryCollapsed[folder];
      renderLibraryTree();
    });

    const list = folderEl.querySelector('.lib-folder-list');
    if (files.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'lib-empty';
      empty.textContent = q ? 'No matches' : 'No files';
      list.appendChild(empty);
    } else {
      for (const filename of files) {
        const li = document.createElement('li');
        li.className = 'lib-item';
        const display = filename.replace(/\.md$/, '');
        li.textContent = display;
        li.title = `${folder}/${filename}`;
        li.addEventListener('click', () => openLibraryFile(folder, filename));
        list.appendChild(li);
      }
    }
    tree.appendChild(folderEl);
  }
}

async function openLibraryFile(folder, filename) {
  const modal = document.getElementById('lib-modal');
  const folderEl = document.getElementById('lib-modal-folder');
  const fileEl = document.getElementById('lib-modal-file');
  const bodyEl = document.getElementById('lib-modal-body');
  folderEl.textContent = folder + '/';
  fileEl.textContent = filename;
  bodyEl.className = 'lib-modal-body loading';
  bodyEl.textContent = 'Loading...';
  modal.style.display = 'flex';

  // Strip .md if present — libraryRead handles both with/without extension
  const nameForRead = filename.replace(/\.md$/, '');
  const result = await window.api.libraryRead(folder, nameForRead);
  if (result?.ok) {
    bodyEl.className = 'lib-modal-body';
    bodyEl.innerHTML = formatContent(result.content);
    applyLibReadingMode();
  } else {
    bodyEl.className = 'lib-modal-body error';
    bodyEl.textContent = result?.error || 'Failed to load file';
  }
}

function closeLibraryModal() {
  const modal = document.getElementById('lib-modal');
  if (modal) modal.style.display = 'none';
}

// ── Artifact Output Tab ───────────────────────────────────────
const artifacts = [];          // in-memory list, newest first
const artifactHashes = new Set(); // dedup
let artifactFilter = 'all';
let artifactSearch = '';
const TYPE_ICONS = { plan:'🗺️', code:'⚒️', research:'📚', writeup:'📬', analysis:'📊', other:'📄' };
const FILTER_LIST = ['all', 'plan', 'code', 'research', 'writeup', 'analysis', 'other'];
const ARTIFACT_MIN_LENGTH = 120; // skip trivial acks like "Done." or "OK."

function setupArtifacts() {
  const search = document.getElementById('art-search');
  search?.addEventListener('input', (e) => {
    artifactSearch = e.target.value;
    renderArtifactList();
  });
  document.getElementById('btn-art-close')?.addEventListener('click', closeArtifactModal);
  document.getElementById('art-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'art-modal') closeArtifactModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('art-modal');
      if (m && m.style.display !== 'none') closeArtifactModal();
    }
  });
  renderArtifactFilters();
  renderArtifactList();
}

function detectArtifactType(content) {
  if (/```|<code/.test(content)) return 'code';
  if (/^#{1,2}\s+(plan|roadmap|sprint)/im.test(content)) return 'plan';
  if (/^#{1,2}\s+(analysis|metrics|roi)/im.test(content)) return 'analysis';
  if (/^#{1,2}\s+(research|findings|summary)/im.test(content)) return 'research';
  if (content.length > 400 && content.includes('\n')) return 'writeup';
  return 'other';
}

function extractArtifactTitle(content) {
  const h = content.match(/^#{1,2}\s+(.+)/m);
  if (h) return h[1].trim().slice(0, 80);
  const firstLine = content.split('\n')[0].replace(/[#*`]/g, '').trim();
  return firstLine.slice(0, 80) || '(untitled)';
}

function makeArtifactExcerpt(content, len = 150) {
  return content.replace(/[#*`]/g, '').replace(/\n+/g, ' ').trim().slice(0, len);
}

function hashContent(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function addArtifact(agentId, content) {
  if (!content || content.length < ARTIFACT_MIN_LENGTH) return;
  const hash = hashContent(content);
  if (artifactHashes.has(hash)) return;
  artifactHashes.add(hash);
  const agent = agents.find(a => a.id === agentId);
  artifacts.unshift({
    id: 'art_' + Date.now() + '_' + hash.slice(0, 4),
    agentId,
    agentName: agent?.name || agentId,
    agentEmoji: agent?.emoji || '🔮',
    agentColor: agent?.color || '#9b59b6',
    type: detectArtifactType(content),
    title: extractArtifactTitle(content),
    excerpt: makeArtifactExcerpt(content),
    content,
    createdAt: Date.now()
  });
  document.getElementById('art-count').textContent = artifacts.length;
  renderArtifactList();
  sfxArtifact();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

function renderArtifactFilters() {
  const wrap = document.getElementById('art-filters');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const f of FILTER_LIST) {
    const btn = document.createElement('button');
    btn.className = 'art-filter' + (artifactFilter === f ? ' active' : '');
    btn.textContent = f;
    btn.addEventListener('click', () => {
      artifactFilter = f;
      renderArtifactFilters();
      renderArtifactList();
    });
    wrap.appendChild(btn);
  }
}

function renderArtifactList() {
  const list = document.getElementById('art-list');
  if (!list) return;
  const q = artifactSearch.toLowerCase();
  const visible = artifacts.filter(a => {
    if (artifactFilter !== 'all' && a.type !== artifactFilter) return false;
    if (q && !a.title.toLowerCase().includes(q) && !a.excerpt.toLowerCase().includes(q)) return false;
    return true;
  });

  list.innerHTML = '';
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'art-empty';
    empty.textContent = artifacts.length === 0
      ? 'Outputs from this session will appear here.'
      : 'Nothing matches.';
    list.appendChild(empty);
    return;
  }

  for (const a of visible) {
    const card = document.createElement('div');
    card.className = 'art-card';
    card.innerHTML = `
      <div class="art-card-head">
        <span class="art-card-type-icon">${TYPE_ICONS[a.type] || '📄'}</span>
        <span class="art-card-title">${escapeHtml(a.title)}</span>
        <span class="art-card-agent" style="color:${a.agentColor}" title="${escapeHtml(a.agentName)}">${a.agentEmoji}</span>
      </div>
      <p class="art-card-excerpt">${escapeHtml(a.excerpt)}</p>
      <div class="art-card-meta">
        <span class="type">${a.type}</span>
        <span class="time">${timeAgo(a.createdAt)}</span>
      </div>`;
    card.addEventListener('click', () => openArtifactModal(a));
    list.appendChild(card);
  }
}

let currentArtifact = null;

function openArtifactModal(artifact) {
  currentArtifact = artifact;
  document.getElementById('art-modal-type').textContent = artifact.type + ' · ' + artifact.agentName;
  document.getElementById('art-modal-title').textContent = artifact.title;
  document.getElementById('art-modal-body').textContent = artifact.content;
  document.getElementById('art-modal').style.display = 'flex';

  document.getElementById('btn-art-copy').onclick = () => {
    navigator.clipboard.writeText(artifact.content).then(() => {
      const btn = document.getElementById('btn-art-copy');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  };
  document.getElementById('btn-art-download').onclick = () => {
    const blob = new Blob([artifact.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60) + '.md';
    a.click();
    URL.revokeObjectURL(url);
  };
}

function closeArtifactModal() {
  document.getElementById('art-modal').style.display = 'none';
  currentArtifact = null;
}

// ── Direct Agent Chat ─────────────────────────────────────────
// Session-scoped transcript per agent. The backend persists its own memory via
// memory.json; this just mirrors what's shown while the app is open.
const agentChatHistory = {};
let currentAgentChat = null;

function setupAgentChat() {
  const modal = document.getElementById('agent-chat-modal');
  const input = document.getElementById('ac-modal-input');
  document.getElementById('btn-ac-modal-close')?.addEventListener('click', closeAgentChat);
  document.getElementById('btn-ac-modal-send')?.addEventListener('click', sendAgentChatMessage);
  document.getElementById('btn-ac-clear')?.addEventListener('click', () => {
    if (!currentAgentChat) return;
    agentChatHistory[currentAgentChat] = [];
    renderAgentChatMessages();
  });
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeAgentChat(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeAgentChat();
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentChatMessage(); }
  });
}

function openAgentChat(agentId) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;
  currentAgentChat = agentId;
  document.getElementById('ac-modal-emoji').textContent = agent.emoji;
  const nameEl = document.getElementById('ac-modal-name');
  nameEl.textContent = `${agent.name} · ${agent.title}`;
  nameEl.style.color = agent.color;
  const inner = document.querySelector('.agent-chat-inner');
  inner.style.setProperty('--ac-modal-color', agent.color);
  renderAgentChatMessages();
  document.getElementById('agent-chat-modal').style.display = 'flex';
  document.getElementById('ac-modal-input').focus();
}

function closeAgentChat() {
  document.getElementById('agent-chat-modal').style.display = 'none';
  currentAgentChat = null;
}

function renderAgentChatMessages() {
  const container = document.getElementById('ac-modal-messages');
  const agent = agents.find(a => a.id === currentAgentChat);
  container.innerHTML = '';
  const history = agentChatHistory[currentAgentChat] || [];
  if (history.length === 0) {
    const note = document.createElement('div');
    note.className = 'system-note';
    note.textContent = `— Speaking privately with ${agent?.name || 'agent'} —`;
    container.appendChild(note);
    return;
  }
  for (const m of history) {
    if (m.role === 'user') appendAgentChatUser(container, m.content);
    else appendAgentChatReply(container, agent, m.content);
  }
  container.scrollTop = container.scrollHeight;
}

function appendAgentChatUser(container, text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="msg-sender">You</div><div class="msg-bubble">${formatContent(text)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendAgentChatReply(container, agent, content) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="msg-sender" style="color:${agent?.color || '#9b59b6'}">${agent?.emoji || ''} ${agent?.name || ''}</div>
    <div class="msg-bubble" style="--msg-color:${agent?.color || '#9b59b6'}">${formatContent(content)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

async function sendAgentChatMessage() {
  const agentId = currentAgentChat;
  if (!agentId) return;
  const input = document.getElementById('ac-modal-input');
  const sendBtn = document.getElementById('btn-ac-modal-send');
  const text = input.value.trim();
  if (!text) return;

  const agent = agents.find(a => a.id === agentId);
  const container = document.getElementById('ac-modal-messages');
  if (!agentChatHistory[agentId]) agentChatHistory[agentId] = [];

  // Clear the "speaking privately" placeholder on first message
  if (agentChatHistory[agentId].length === 0) container.innerHTML = '';

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  agentChatHistory[agentId].push({ role: 'user', content: text });
  appendAgentChatUser(container, text);
  const indicator = buildTypingIndicator(agent?.color, `${agent?.name || 'Agent'} is thinking…`);
  container.appendChild(indicator);
  container.scrollTop = container.scrollHeight;

  try {
    const reply = await window.api.sendMessage(agentId, text);
    const replyText = typeof reply === 'string' ? reply : (reply?.reply || reply?.finalText || JSON.stringify(reply));
    indicator.remove();
    agentChatHistory[agentId].push({ role: 'assistant', content: replyText });
    // Guard against the user switching agents mid-request
    if (currentAgentChat === agentId) appendAgentChatReply(container, agent, replyText);
    addArtifact(agentId, replyText);
  } catch (err) {
    indicator.remove();
    const note = document.createElement('div');
    note.className = 'system-note';
    note.textContent = `— Error: ${err.message} —`;
    container.appendChild(note);
  }

  sendBtn.disabled = false;
  input.focus();
}

// ── Command Palette (Cmd/Ctrl+K) ──────────────────────────────
let cmdItems = [];
let cmdActiveIdx = 0;

function setupCommandPalette() {
  const input = document.getElementById('cmd-input');
  const palette = document.getElementById('cmd-palette');

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.style.display === 'flex' ? closeCommandPalette() : openCommandPalette();
    } else if (e.key === 'Escape' && palette.style.display === 'flex') {
      closeCommandPalette();
    }
  });

  input.addEventListener('input', () => renderCommandResults(input.value));
  input.addEventListener('keydown', (e) => {
    const visible = cmdItems.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdActiveIdx = Math.min(cmdActiveIdx + 1, visible - 1); paintCommandActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdActiveIdx = Math.max(cmdActiveIdx - 1, 0); paintCommandActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); cmdItems[cmdActiveIdx]?.run(); }
  });

  palette.addEventListener('click', (e) => { if (e.target === palette) closeCommandPalette(); });
}

function buildCommandItems() {
  const items = [];
  const activateTab = (name) => document.querySelector(`.tab-btn[data-tab="${name}"]`)?.click();

  agents.filter(a => !a.isCouncil && a.id !== 'oracle').forEach(a => {
    items.push({
      icon: a.emoji, kind: 'Chat',
      label: `${a.name} — ${a.title}`,
      search: `${a.name} ${a.title} ${a.id} ${a.pokemon || ''}`.toLowerCase(),
      run: () => { closeCommandPalette(); openAgentChat(a.id); }
    });
  });

  const folderIcons = { wiki: '📚', output: '📤', raw: '📥' };
  for (const folder of ['wiki', 'output', 'raw']) {
    (libraryData[folder] || []).forEach(filename => {
      const display = filename.replace(/\.md$/, '');
      items.push({
        icon: folderIcons[folder], kind: folder,
        label: display,
        search: `${display} ${folder}`.toLowerCase(),
        run: () => { closeCommandPalette(); activateTab('library'); openLibraryFile(folder, filename); }
      });
    });
  }

  const actions = [
    { icon: '💬', label: 'Go to Oracle chat', run: () => { activateTab('chat'); document.getElementById('gc-input').focus(); } },
    { icon: '🧹', label: 'Clear conversation', run: () => { activateTab('chat'); clearGeneralChat(); } },
    { icon: '⛶', label: 'Toggle fullscreen', run: () => document.getElementById('btn-gc-expand').click() },
    { icon: '📚', label: 'Open Library', run: () => activateTab('library') },
    { icon: '📤', label: 'Open Outputs', run: () => activateTab('outputs') },
    { icon: '⟳', label: 'Refresh Library', run: () => { activateTab('library'); refreshLibrary(); } }
  ];
  actions.forEach(a => items.push({ icon: a.icon, kind: 'Action', label: a.label, search: a.label.toLowerCase(), run: () => { closeCommandPalette(); a.run(); } }));

  return items;
}

function openCommandPalette() {
  const palette = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-input');
  palette.style.display = 'flex';
  input.value = '';
  renderCommandResults('');
  input.focus();
}

function closeCommandPalette() {
  document.getElementById('cmd-palette').style.display = 'none';
}

function renderCommandResults(query) {
  const q = query.trim().toLowerCase();
  const all = buildCommandItems();
  cmdItems = q ? all.filter(it => it.search.includes(q)) : all;
  cmdActiveIdx = 0;

  const results = document.getElementById('cmd-results');
  results.innerHTML = '';
  if (cmdItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'No matches';
    results.appendChild(empty);
    return;
  }
  cmdItems.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'cmd-item' + (i === cmdActiveIdx ? ' active' : '');
    el.innerHTML = `
      <span class="cmd-item-icon">${it.icon}</span>
      <span class="cmd-item-label">${escapeHtml(it.label)}</span>
      <span class="cmd-item-kind">${it.kind}</span>`;
    el.addEventListener('click', () => it.run());
    el.addEventListener('mousemove', () => { cmdActiveIdx = i; paintCommandActive(); });
    results.appendChild(el);
  });
}

function paintCommandActive() {
  const nodes = document.querySelectorAll('#cmd-results .cmd-item');
  nodes.forEach((n, i) => n.classList.toggle('active', i === cmdActiveIdx));
  nodes[cmdActiveIdx]?.scrollIntoView({ block: 'nearest' });
}

// ── Ambient Sound (WebAudio synth, default off) ───────────────
let audioCtx = null;
let soundOn = false;

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// One short synthesized tone — no audio assets needed.
function blip(freq, dur = 0.12, type = 'sine', gainVal = 0.05, when = 0) {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gainVal, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function sfxConsultStart() { blip(523.25, 0.10, 'triangle', 0.045); blip(783.99, 0.12, 'triangle', 0.045, 0.08); }
function sfxConsultDone()  { blip(659.25, 0.10, 'sine', 0.05); blip(987.77, 0.14, 'sine', 0.05, 0.09); }
function sfxArtifact()     { blip(1318.51, 0.06, 'square', 0.025); }

function setupSound() {
  const btn = document.getElementById('btn-sound');
  if (!btn) return;
  btn.addEventListener('click', () => {
    soundOn = !soundOn;
    btn.classList.toggle('on', soundOn);
    btn.title = soundOn ? 'Sound on — click to mute' : 'Sound off — click to enable';
    if (soundOn) { ensureAudio(); blip(880, 0.08, 'sine', 0.05); } // unlock ctx on user gesture + confirm
  });
}
