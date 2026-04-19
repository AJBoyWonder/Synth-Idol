// ============================================================
//  SYNTH IDOL — game.js
//  Portal protocol integrated for the game jam
// ============================================================

// ------------------------------------------------------------------
// Portal protocol setup (required for the jam — do not remove)
// ------------------------------------------------------------------

const incoming = Portal.readPortalParams();
const nextTarget = await Portal.pickPortalTarget();

// ------------------------------------------------------------------
// Constants & config
// ------------------------------------------------------------------

const LANE_DEFS = [
  { key: 'a', label: 'SCRATCH', color: '#7f77dd' },
  { key: 's', label: 'LOW',     color: '#d4537e' },
  { key: 'd', label: 'MID',     color: '#1d9e75' },
  { key: 'f', label: 'HIGH',    color: '#d85a30' },
  { key: 'g', label: 'FX',      color: '#ef9f27' },
];

const SCROLL_SPEED       = 300;  // px per second
const HIT_WINDOW_PERFECT = 60;   // ms
const HIT_WINDOW_GOOD    = 120;  // ms
const NOTE_SPAWN_AHEAD   = 2000; // ms

// ------------------------------------------------------------------
// Beatmap generator (128 BPM demo pattern)
// ------------------------------------------------------------------

function generateBeatmap() {
  const beat = 60000 / 128;
  const map = [];
  const patterns = [
    [0,2,4], [0,1,3], [1,2,3,4], [0,2],
    [0,1,2,3,4], [0,3], [2,4], [1,3],
  ];
  let t = 2000;
  for (let bar = 0; bar < 32; bar++) {
    const pat = patterns[bar % patterns.length];
    pat.forEach((lane, i) => {
      const type = (lane === 0 && bar % 4 === 0) ? 'scratch'
                 : (lane === 4 && bar % 3 === 0) ? 'fader'
                 : 'tap';
      map.push({ time: t + i * (beat / pat.length), lane, type });
    });
    t += beat * 2;
  }
  return map.sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------------------
// Game state
// ------------------------------------------------------------------

let state = {
  running: false,
  score: 0,
  combo: 0,
  life: 100,
  startTime: 0,
  beatmap: [],
  spawnIndex: 0,
  activeNotes: [],
  lastFrame: 0,
  ttAngle: { left: 0, right: 0 },
  faderPositions: { cross: 0.5, vol: 0.7 },
  keyHeld: {},
  songEnded: false,
};

// ------------------------------------------------------------------
// DOM refs (populated in startGame)
// ------------------------------------------------------------------

let lanesEl, judgmentEl, scoreEl, comboEl, lifeEl;
let ttLeft, ttRight, ttLineLeft, ttLineRight;
let faderCross, faderVol, faderCrossThumb, faderVolThumb;

// ------------------------------------------------------------------
// Build lane elements
// ------------------------------------------------------------------

function buildLanes() {
  lanesEl = document.getElementById('lanes');
  lanesEl.querySelectorAll('.lane').forEach(l => l.remove());

  LANE_DEFS.forEach((def, i) => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.id = `lane-${i}`;

    const lbl = document.createElement('div');
    lbl.className = 'lane-label';
    lbl.textContent = def.label;
    lane.appendChild(lbl);

    const hz = document.createElement('div');
    hz.className = 'hit-zone';
    const key = document.createElement('div');
    key.className = 'hit-key';
    key.id = `key-${i}`;
    key.style.setProperty('--key-color', def.color);
    key.textContent = def.key.toUpperCase();
    hz.appendChild(key);
    lane.appendChild(hz);

    lanesEl.appendChild(lane);
  });
}

// ------------------------------------------------------------------
// Spawn a note element
// ------------------------------------------------------------------

function spawnNote(noteDef) {
  const laneEl = document.getElementById(`lane-${noteDef.lane}`);
  if (!laneEl) return;

  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.left = '50%';
  el.style.transform = 'translateX(-50%)';
  el.style.top = '-60px';
  el.style.pointerEvents = 'none';

  const color = LANE_DEFS[noteDef.lane].color;

  if (noteDef.type === 'scratch') {
    el.style.cssText += `width:52px;height:52px;border-radius:50%;border:3px solid ${color};background:${color}33;`;
  } else if (noteDef.type === 'fader') {
    el.style.cssText += `width:52px;height:12px;border-radius:2px;background:${color};box-shadow:0 0 10px ${color}88;`;
  } else {
    el.style.cssText += `width:52px;height:20px;border-radius:4px;background:${color};box-shadow:0 0 8px ${color}66;`;
  }

  laneEl.appendChild(el);

  state.activeNotes.push({
    el, lane: noteDef.lane, type: noteDef.type,
    time: noteDef.time, hit: false, missed: false,
  });
}

// ------------------------------------------------------------------
// Game loop
// ------------------------------------------------------------------

function gameLoop(ts) {
  if (!state.running) return;

  const elapsed = ts - state.startTime;
  state.lastFrame = ts;

  // Spawn upcoming notes
  while (state.spawnIndex < state.beatmap.length) {
    const next = state.beatmap[state.spawnIndex];
    if (next.time - elapsed <= NOTE_SPAWN_AHEAD) {
      spawnNote(next);
      state.spawnIndex++;
    } else break;
  }

  const laneHeight = lanesEl.clientHeight;
  const hitY = 80;

  // Move notes
  for (let i = state.activeNotes.length - 1; i >= 0; i--) {
    const n = state.activeNotes[i];
    if (n.hit || n.missed) {
      n.el.remove();
      state.activeNotes.splice(i, 1);
      continue;
    }
    const timeUntilHit = n.time - elapsed;
    const topPos = laneHeight - hitY - (timeUntilHit / 1000) * SCROLL_SPEED - 10;
    n.el.style.top = topPos + 'px';

    if (timeUntilHit < -HIT_WINDOW_GOOD) {
      n.missed = true;
      miss();
    }
  }

  // Animate turntable lines
  if (ttLineLeft)  ttLineLeft.style.transform  = `translateX(-50%) rotate(${state.ttAngle.left}deg)`;
  if (ttLineRight) ttLineRight.style.transform = `translateX(-50%) rotate(${state.ttAngle.right}deg)`;

  // Song over?
  if (!state.songEnded && state.spawnIndex >= state.beatmap.length && state.activeNotes.length === 0) {
    state.songEnded = true;
    setTimeout(endGame, 800);
  }

  requestAnimationFrame(gameLoop);
}

// ------------------------------------------------------------------
// Hit detection
// ------------------------------------------------------------------

function tryHitLane(laneIndex) {
  const elapsed = performance.now() - state.startTime;
  let best = null, bestDiff = Infinity;
  for (const n of state.activeNotes) {
    if (n.lane !== laneIndex || n.hit || n.missed) continue;
    if (n.type === 'scratch' || n.type === 'fader') continue;
    const diff = Math.abs(n.time - elapsed);
    if (diff < bestDiff) { bestDiff = diff; best = n; }
  }
  if (!best) return;
  if (bestDiff <= HIT_WINDOW_PERFECT) hitNote(best, 'PERFECT', 300);
  else if (bestDiff <= HIT_WINDOW_GOOD) hitNote(best, 'GOOD', 100);
}

function tryHitByType(type) {
  const elapsed = performance.now() - state.startTime;
  for (const n of state.activeNotes) {
    if (n.type !== type || n.hit || n.missed) continue;
    const diff = Math.abs(n.time - elapsed);
    if (diff <= HIT_WINDOW_GOOD) {
      hitNote(n, diff <= HIT_WINDOW_PERFECT ? 'PERFECT' : 'GOOD',
                 diff <= HIT_WINDOW_PERFECT ? 300 : 100);
      return;
    }
  }
}

function hitNote(n, judgment, points) {
  n.hit = true;
  state.combo++;
  state.score += points + Math.floor(state.combo / 10) * 10;
  updateHUD();
  showJudgment(judgment, judgment === 'PERFECT' ? '#7f77dd' : '#1d9e75');
  flashKey(n.lane);
}

function miss() {
  state.combo = 0;
  state.life = Math.max(0, state.life - 8);
  updateHUD();
  showJudgment('MISS', '#d85a30');
  if (state.life <= 0) endGame();
}

// ------------------------------------------------------------------
// HUD updates
// ------------------------------------------------------------------

function updateHUD() {
  if (scoreEl) scoreEl.textContent = String(state.score).padStart(6, '0');
  if (comboEl) comboEl.textContent = state.combo;
  if (lifeEl) {
    lifeEl.style.width = state.life + '%';
    lifeEl.style.background = state.life > 50 ? '#d4537e'
                             : state.life > 25 ? '#ef9f27' : '#e24b4a';
  }
}

function showJudgment(text, color) {
  if (!judgmentEl) return;
  judgmentEl.textContent = text;
  judgmentEl.style.color = color;
  judgmentEl.style.opacity = '1';
  clearTimeout(judgmentEl._t);
  judgmentEl._t = setTimeout(() => { judgmentEl.style.opacity = '0'; }, 400);
}

function flashKey(laneIndex) {
  const k = document.getElementById(`key-${laneIndex}`);
  if (!k) return;
  k.classList.add('pressed');
  setTimeout(() => k.classList.remove('pressed'), 100);
}

// ------------------------------------------------------------------
// Keyboard input
// ------------------------------------------------------------------

document.addEventListener('keydown', e => {
  if (!state.running) return;
  const key = e.key.toLowerCase();
  if (state.keyHeld[key]) return;
  state.keyHeld[key] = true;
  LANE_DEFS.forEach((def, i) => {
    if (def.key === key) { flashKey(i); tryHitLane(i); }
  });
});

document.addEventListener('keyup', e => {
  state.keyHeld[e.key.toLowerCase()] = false;
});

// ------------------------------------------------------------------
// Turntable drag
// ------------------------------------------------------------------

function setupTurntable(el, lineEl, side) {
  let dragging = false, startY = 0;

  el.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY;
    el.classList.add('active'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY; startY = e.clientY;
    state.ttAngle[side] += dy * 2;
    if (Math.abs(dy) > 3 && state.running) tryHitByType('scratch');
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; el.classList.remove('active'); }
  });
  el.addEventListener('touchstart', e => {
    dragging = true; startY = e.touches[0].clientY;
    el.classList.add('active'); e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY; startY = e.touches[0].clientY;
    state.ttAngle[side] += dy * 2;
    if (Math.abs(dy) > 3 && state.running) tryHitByType('scratch');
  });
  document.addEventListener('touchend', () => {
    dragging = false; el.classList.remove('active');
  });
}

// ------------------------------------------------------------------
// Fader drag
// ------------------------------------------------------------------

function setupFader(trackEl, thumbEl, key) {
  let dragging = false;
  const update = (clientX) => {
    const rect = trackEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    state.faderPositions[key] = pct;
    thumbEl.style.left = (pct * 100) + '%';
    if (state.running) tryHitByType('fader');
  };
  trackEl.addEventListener('mousedown', e => {
    dragging = true; thumbEl.classList.add('active'); update(e.clientX); e.preventDefault();
  });
  document.addEventListener('mousemove', e => { if (dragging) update(e.clientX); });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; thumbEl.classList.remove('active'); }
  });
  trackEl.addEventListener('touchstart', e => {
    dragging = true; thumbEl.classList.add('active'); update(e.touches[0].clientX); e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', e => { if (dragging) update(e.touches[0].clientX); });
  document.addEventListener('touchend', () => { dragging = false; thumbEl.classList.remove('active'); });
}

// ------------------------------------------------------------------
// Start / end
// ------------------------------------------------------------------

function startGame() {
  document.getElementById('screen-title').style.display = 'none';
  document.getElementById('screen-gameover').style.display = 'none';
  document.getElementById('game-container').style.display = 'flex';

  buildLanes();

  judgmentEl      = document.getElementById('judgment-text');
  scoreEl         = document.getElementById('score-display');
  comboEl         = document.getElementById('combo-display');
  lifeEl          = document.getElementById('life-bar-fill');
  ttLeft          = document.getElementById('turntable-left');
  ttRight         = document.getElementById('turntable-right');
  ttLineLeft      = document.getElementById('tt-line-left');
  ttLineRight     = document.getElementById('tt-line-right');
  faderCross      = document.getElementById('fader-cross');
  faderVol        = document.getElementById('fader-vol');
  faderCrossThumb = document.getElementById('fader-cross-thumb');
  faderVolThumb   = document.getElementById('fader-vol-thumb');

  setupTurntable(ttLeft,  ttLineLeft,  'left');
  setupTurntable(ttRight, ttLineRight, 'right');
  setupFader(faderCross, faderCrossThumb, 'cross');
  setupFader(faderVol,   faderVolThumb,   'vol');

  // Show player name from Portal if available
  const nameEl = document.getElementById('player-name');
  if (nameEl && incoming.username) nameEl.textContent = incoming.username;

  Object.assign(state, {
    running: true,
    score: 0, combo: 0, life: 100,
    startTime: performance.now(),
    beatmap: generateBeatmap(),
    spawnIndex: 0,
    activeNotes: [],
    lastFrame: performance.now(),
    keyHeld: {},
    songEnded: false,
  });

  updateHUD();
  requestAnimationFrame(gameLoop);
}

function endGame() {
  state.running = false;
  document.getElementById('game-container').style.display = 'none';

  // Portal exit — send player to next game in the jam if available
  const goEl = document.getElementById('portal-next');
  if (goEl && nextTarget) {
    goEl.style.display = 'block';
    goEl.textContent = `ENTER PORTAL → ${nextTarget.title}`;
    goEl.onclick = () => {
      Portal.sendPlayerThroughPortal(nextTarget.url, {
        username: incoming.username,
        color: incoming.color,
        score: state.score,
      });
    };
  }

  document.getElementById('final-score').textContent = String(state.score).padStart(6, '0');
  document.getElementById('screen-gameover').style.display = 'flex';
}

function restartGame() {
  document.querySelectorAll('.note').forEach(n => n.remove());
  startGame();
}
