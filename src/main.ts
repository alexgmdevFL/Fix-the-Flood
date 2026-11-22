import './style.css';
import { Sim, S, SURFACE_NAMES, type Earthwork } from './sim/grid.ts';
import type { Scenario } from './levels/types.ts';
import { loadLevel, PLACE_INDEX } from './levels/load.ts';
import { World, type Lens, type View, type Zoom } from './render/world.ts';
import { liveNote, resultNote } from './ui/feedback.ts';
import { Tutorial } from './ui/tutorial.ts';
import { Sound } from './ui/audio.ts';
import { Callout, Pins, type Info, type Act, type Alert } from './ui/callout.ts';
import { LIFT_CAP, SEPTIC_SEP } from './sim/grid.ts';

const level = await loadLevel();
const SCENARIOS = level.scenarios;
const N = level.n;
const WATER = level.waterName ?? 'the river';

type Tool = 'inspect' | 'drain' | 'valve' | 'pump' | 'sewer' | 'swale' | 'pond' | 'wall' | 'raise' | 'remove';
interface Frame { t: number; water: Float32Array; conc: Float32Array; vx: Float32Array; vy: Float32Array; tide: number; rain: number }

const TIPS: Record<Tool, string> = {
  inspect: 'Inspect: tap any spot to see its height, water and groundwater.',
  drain: `Storm drain: collects water and pipes it to the outfall in ${WATER}, or to a pond if one is close.`,
  valve: 'Check valve: a flap that lets water out but stops the river pushing back in.',
  pump: 'Pump: lifts water into the river, even when the tide is high.',
  sewer: 'Sewer: tap a house to connect its whole row to the city sewer. Septic tanks retire, but floodwater leaking in can overload the lift station.',
  swale: 'Swale: a shallow grassy strip that holds runoff and lets it soak in. Best beside a road, in lighter storms.',
  pond: 'Retention pond: stores water. Drains within 12 tiles pipe into it, and it empties to the river when the tide allows.',
  wall: 'Wall: a 1 ft wall that blocks water. The water still goes somewhere, often next door.',
  raise: 'Raise road: lifts a road tile 6 inches. Tap again for a full foot.',
  remove: 'Remove: tap to undo a drain, pump, swale, pond, wall or raised road.',
};
const LENS_TIPS: Partial<Record<Lens, string>> = {
  elevation: 'Elevation: blue is low ground, brown is high. Lines mark every half foot.',
  groundwater: 'Groundwater: blue means the soil is full and rain cannot soak in. Tan means room to absorb.',
  flow: 'Flow arrows: which way water is moving right now.',
  tide: 'High tide: red ground sits below the current tide. Only the seawall and check valves keep the river out.',
  watershed: 'Watershed: orange and green tint show which way the land drains. Blue is the bowl behind the seawall where water pools if nothing drains it.',
  pipes: 'Pipes: underground drain lines to the outfall. Cyan is flowing out, red is running backward.',
};

const sim = new Sim(level);
const sound = new Sound();
const tutorial = new Tutorial(document.getElementById('tut')!, level.suggest);
const world = new World(document.getElementById('app')!, sim, level);
const callout = new Callout(world, i => buildInfo(i));
const pins = new Pins(world, cell => { callout.show(cell); world.showCursor(cell); });
world.onLightning = () => sound.thunder();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let scenario: Scenario | null = null;
let playing = false;
let speed = 1;
let tool: Tool = 'inspect';
let toast = '';
let toastUntil = 0;
let frames: Frame[] = [];
let replay: { k: number; playing: boolean; note: string } | null = null;
const liveVx = new Float32Array(N * N), liveVy = new Float32Array(N * N);

const rainIn = $<HTMLInputElement>('rain');
const tideIn = $<HTMLInputElement>('tide');

let toastLabel = 'TIP';
function say(msg: string, label = 'TIP') { toast = msg; toastLabel = label; toastUntil = performance.now() + 4000; }

// Hint strip: a colored label chip, and a quick pop whenever the text changes
let noteText = '';
const NOTE_COLORS: Record<string, string> = { PLACE: '#1b7a3d', TIP: '#145a7a', REPLAY: '#5b4a9a', TOOL: '#145a7a', 'WET SEASON': '#2b6f8f', TIDE: '#c77700' };
function setNote(text: string, label: string) {
  const el = $('note');
  if (text === noteText) return;
  noteText = text;
  if (!text) { el.innerHTML = ''; return; }
  el.style.setProperty('--k', NOTE_COLORS[label] ?? '#145a7a');
  el.innerHTML = `<span class="nchip">${label}</span><span>${text}</span>`;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

// ---------- Info cards (tap with Inspect) and map pins
const C = { tip: '#145a7a', warn: '#c77700', alert: '#c62828', sewage: '#7a5410', good: '#1b7a3d', muted: '#5b6b75' };
const inch = (ft: number) => `${(ft * 12).toFixed(ft * 12 < 10 ? 1 : 0)} in`;

function buildInfo(i: number): Info | null {
  const e = sim.elev[i], w = sim.open[i] ? 0 : sim.water[i], pool = world.watershed.fill[i];
  const col = { ground: e, water: w, table: Math.min(sim.gw[i], e), pool };
  const act = (label: string, t: Tool, primary = false): Act => ({ label, primary, run: () => applyAt(i, t) });
  const dr = sim.drainAt(i), pm = sim.pumpAt(i);
  if (dr) {
    const to = dr.to ?? -1;
    const back = dr.flow < -0.01, out = dr.flow > 0.01;
    return {
      title: dr.valve ? 'Drain with check valve' : 'Storm drain', badge: back ? 'Running backward' : out ? 'Draining' : 'Idle', k: back ? C.warn : out ? C.good : C.muted, col,
      rows: [['Pipes to', to >= 0 ? 'pond' : 'river', ''], ['Pipe end', `${sim.outfallElev.toFixed(1)} ft`, ''], ['River now', `${sim.tide.toFixed(1)} ft`, sim.tide > sim.outfallElev ? 'bad' : 'ok'], ['Water here', inch(w), w > 0.1 ? 'warn' : '']],
      why: back ? 'The river is higher than the end of the pipe, so river water is pushing up into the street.' : dr.valve && sim.tide > sim.outfallElev ? 'The valve is holding the river out. Rain here waits until the tide drops.' : out ? 'Water is flowing out through the pipe.' : 'Nothing to drain right now.',
      acts: [...(!dr.valve ? [act('Add check valve', 'valve', true)] : []), act('Swap for pump', 'pump'), act('Remove', 'remove')],
    };
  }
  if (pm) {
    return {
      title: 'Pump', badge: pm.flow > 0.02 ? 'Pumping' : 'Idle', k: pm.flow > 0.02 ? C.good : C.muted, col,
      rows: [['Sends to', 'river', ''], ['At high tide', 'works', 'ok'], ['Water here', inch(w), '']],
      why: 'Pumps work at any tide, but everything on the street goes into the river with the water.',
      acts: [act('Remove', 'remove')],
    };
  }
  const hk = sim.houseAt(i);
  if (hk >= 0) {
    const h = sim.houses[hk];
    let lvl = 0;
    for (const c of h.cells) lvl = Math.max(lvl, sim.elev[c] + sim.water[c]);
    const gap = h.floor - lvl;
    const rows: Info['rows'] = [['Floor height', `${h.floor.toFixed(2)} ft`, ''], h.depth > 0 ? ['Water inside', inch(h.depth), 'bad'] : ['Water below floor', inch(Math.max(0, gap)), gap < 0.25 ? 'warn' : 'ok']];
    if (sim.septicOn) rows.push(['Wastewater', h.sewer ? 'city sewer' : h.septicFail ? 'septic failing' : 'septic working', h.sewer ? 'ok' : h.septicFail ? 'bad' : '']);
    return {
      title: world.houseLabel(hk), badge: h.depth > 0 ? 'Flooding' : 'Dry', k: h.depth > 0 ? C.alert : C.good, lift: 1.2,
      col: { ground: h.ground, water: Math.max(0, lvl - h.ground), table: Math.min(sim.gw[h.cells[0]], h.ground), pool: world.watershed.fill[h.cells[0]], floor: h.floor },
      rows,
      why: h.depth > 0 ? 'Water is above the floor. Lower the water outside with drains or pumps.' : gap < 0.25 ? `Only ${inch(Math.max(0, gap))} to spare before water gets inside.` : 'The floor is safely above the water outside.',
      acts: sim.septicOn && !h.sewer ? [{ label: 'Connect row to sewer', primary: true, run: () => { sim.connectSewer(hk); world.rebuildProps(); } }] : [],
    };
  }
  const septic = sim.septicOn ? sim.houses.findIndex(h => h.septic === i && !h.sewer) : -1;
  if (septic >= 0) {
    const h = sim.houses[septic], dry = sim.elev[i] - sim.gw[i];
    return {
      title: 'Septic drainfield', badge: h.septicFail ? 'Failing' : 'Working', k: h.septicFail ? C.sewage : C.good, col,
      rows: [['Needs dry soil', inch(SEPTIC_SEP), ''], ['Dry soil now', inch(Math.max(0, dry)), dry < SEPTIC_SEP ? 'bad' : 'ok'], ['Sewage', sim.conc[i] > 0.05 ? 'in yard' : 'none', sim.conc[i] > 0.05 ? 'bad' : 'ok']],
      why: h.septicFail ? 'The water table is too close. Wastewater cannot soak in, so it comes up into the yard.' : 'Enough dry soil under it for now.',
      acts: [{ label: 'Connect row to sewer', primary: true, run: () => { sim.connectSewer(septic); world.rebuildProps(); } }],
    };
  }
  if (sim.septicOn && i === sim.liftCell && sim.houses.some(h => h.sewer)) {
    const over = sim.liftLoad > LIFT_CAP;
    return {
      title: 'Sewer lift station', badge: over ? 'Overflowing' : 'OK', k: over ? C.alert : C.good, col, lift: 0.8,
      rows: [['Load', `${Math.round((sim.liftLoad / LIFT_CAP) * 100)}%`, over ? 'bad' : 'ok'], ['Homes', String(sim.houses.filter(h => h.sewer).length), '']],
      why: over ? 'Floodwater is leaking in through manhole lids. Keep the street dry to protect the sewer.' : 'Pumping the neighborhood\'s sewage to the treatment plant.',
      acts: [],
    };
  }
  const surf = sim.surface[i];
  const changed = sim.elev[i] !== sim.elev0[i] || surf !== sim.surface0[i];
  const open = surf === S.Grass || surf === S.Sand;
  const acts: Act[] = [];
  if (!sim.open[i] && surf !== S.Wall) {
    if (changed) acts.push(act('Undo', 'remove'));
    acts.push(act('Place drain', 'drain', !changed));
    if (surf === S.Pavement) acts.push(act('Raise road', 'raise'));
    else if (open) acts.push(act('Dig swale', 'swale'));
  }
  const dryIn = Math.max(0, e - sim.gw[i]);
  return {
    title: SURFACE_NAMES[surf], badge: sim.open[i] ? 'Open water' : w > 0.05 ? 'Flooded' : 'Dry', k: w > 0.05 ? C.warn : C.tip, col,
    rows: [['Height', `${e.toFixed(2)} ft`, ''], ['Water on top', inch(w), w > 0.1 ? 'warn' : ''], ['Dry soil', dryIn < 0.03 ? 'none' : inch(dryIn), dryIn < 0.25 ? 'warn' : ''], ['Could pool', pool > 0 ? inch(pool) : 'no', pool > 0 ? 'bad' : 'ok']],
    why: sim.open[i] ? `${WATER[0].toUpperCase() + WATER.slice(1)} rises and falls with the tide.` : pool > 0.5 ? 'This spot sits in the low bowl behind the seawall, so water from all around ends up here.' : pool > 0 ? 'A shallow low spot. Water collects here before it can run off.' : 'Water runs off this spot toward lower ground.',
    acts,
  };
}

function alerts(): Alert[] {
  const out: Alert[] = [];
  sim.houses.forEach((h, k) => { if (h.depth > 0.001) out.push({ key: `f${k}`, cell: h.cells[0], label: `FLOODING ${inch(h.depth)}`, k: C.alert, lift: 1.2 }); });
  sim.drains.forEach(d => { if (d.flow < -0.01) out.push({ key: `b${d.i}`, cell: d.i, label: 'BACKFLOW', k: C.warn }); });
  if (sim.septicOn) {
    if (sim.liftLoad > LIFT_CAP) out.push({ key: 'lift', cell: sim.liftCell, label: 'SEWER OVERFLOW', k: C.alert, lift: 0.8 });
    sim.houses.forEach((h, k) => { if (h.septicFail) out.push({ key: `s${k}`, cell: h.septic, label: 'SEPTIC FAILING', k: C.sewage }); });
  }
  return out.slice(0, 8);
}

function startScenario(s: Scenario) {
  exitReplay();
  scenario = s;
  sim.gwOffset = s.gwOffset;
  sim.septicOn = !!s.septic;
  sim.tide = s.tide(0);
  sim.rain = s.rain(0);
  sim.reset();
  frames = [];
  playing = true;
  $('modal').classList.add('hidden');
  $('mode').textContent = s.title;
  $('concept').textContent = s.concept;
  if (world.lens === 'groundwater') world.paintColors();
  world.rebuildProps();
  updatePlay();
}

function freePlay() {
  if (scenario) { scenario = null; $('mode').textContent = 'Free play'; $('concept').textContent = 'Set rain and tide yourself.'; }
}

function record() {
  const vx = new Float32Array(N * N), vy = new Float32Array(N * N);
  sim.computeFlow(vx, vy);
  frames.push({ t: sim.time, water: sim.water.slice(), conc: sim.conc.slice(), vx, vy, tide: sim.tide, rain: sim.rain });
}

const STAR_KEY = 'hw-stars';
function loadStars(): Record<string, number> { try { return JSON.parse(localStorage.getItem(STAR_KEY) || '{}'); } catch { return {}; } }
function saveStars(v: Record<string, number>) { try { localStorage.setItem(STAR_KEY, JSON.stringify(v)); } catch { /* private mode */ } }
const starsFor = (inches: number) => (inches <= 0 ? 3 : inches < 1 ? 2 : inches < 3 ? 1 : 0);
const starStr = (k: number) => '\u2605'.repeat(k) + '\u2606'.repeat(3 - k);

function finish() {
  playing = false;
  updatePlay();
  const s = scenario!;
  const w = sim.stats.worst * 12;
  let st = starsFor(w);
  if (s.septic && sim.stats.septicFails > 0) st = Math.min(st, 1);
  if (s.septic && sim.stats.overflow > 0.01) st = Math.min(st, 2);
  const best = loadStars();
  const key = (x: Scenario) => `${level.id}:${x.id}`;
  best[key(s)] = Math.max(best[key(s)] ?? 0, st);
  saveStars(best);
  const next = SCENARIOS[SCENARIOS.indexOf(s) + 1];
  const total = SCENARIOS.reduce((a, x) => a + (best[key(x)] ?? 0), 0);
  const note = resultNote(sim);
  const canNext = next && st >= 1;
  $('modal').innerHTML = `
    <h2>${s.title}</h2>
    <div class="stars" aria-label="${st} of 3 stars">${starStr(st)}</div>
    <div class="grade ${w > 0 ? 'bad' : 'good'}">${w > 0 ? `${w.toFixed(1)} in of water inside the worst house` : 'All floors dry'}</div>
    <p>${note}</p>
    <p class="fact"><b>Did you know?</b> ${s.fact}</p>
    ${s.id === 'storm3' && st >= 1 ? `<div class="complete">Level 1 complete: ${SCENARIOS.slice(0, 3).reduce((a, x) => a + (best[key(x)] ?? 0), 0)} of 9 stars. ${level.name} made it through heavy rain, a king tide and the wet season. Next up: sewage.</div>` : ''}
    ${s.id === 'septic' && st >= 1 ? `<div class="complete">Level 2 complete. Total: ${total} of ${SCENARIOS.length * 3} stars.</div>` : ''}
    <div class="row">
      <button id="watch" class="${w > 0 ? 'primary' : ''}">Watch replay</button>
      <button id="retry">Retry</button>
      ${canNext ? '<button id="next" class="primary">Next storm</button>' : ''}
      <button id="close">Keep building</button>
    </div>`;
  $('modal').classList.remove('hidden');
  $('watch').onclick = () => startReplay(note);
  $('retry').onclick = () => startScenario(s);
  if (canNext) $('next').onclick = () => startScenario(next);
  $('close').onclick = () => $('modal').classList.add('hidden');
}

function startReplay(note: string) {
  if (frames.length < 2) return;
  callout.close();
  replay = { k: 0, playing: true, note };
  playing = false;
  updatePlay();
  world.forceArrows = true;
  $('modal').classList.add('hidden');
  $('replay').classList.remove('hidden');
  $('panel').classList.add('hidden');
  const sl = $<HTMLInputElement>('rpSlider');
  sl.max = String(frames.length - 1);
  sl.value = '0';
  $('rpPlay').textContent = 'Pause';
}

function exitReplay() {
  if (!replay) return;
  replay = null;
  world.forceArrows = false;
  $('replay').classList.add('hidden');
  $('panel').classList.remove('hidden');
}

function updatePlay() { $('play').textContent = playing ? 'Pause' : 'Play'; }

function selectTool(t: string) {
  tool = t as Tool;
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(o => o.classList.toggle('on', o.dataset.tool === t));
}

// Tools
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => {
  b.onclick = () => {
    tool = b.dataset.tool as Tool;
    document.querySelectorAll('[data-tool]').forEach(o => o.classList.toggle('on', o === b));
    say(TIPS[tool]);
    sound.click();
  };
});

$('play').onclick = () => {
  exitReplay();
  if (scenario && sim.time >= scenario.duration) { startScenario(scenario); return; }
  playing = !playing; updatePlay();
};
$('speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speed').textContent = `${speed}x`; };
$('reset').onclick = () => { if (scenario) startScenario(scenario); else sim.reset(); setPanel(true); };
SCENARIOS.forEach((s, k) => { $(`s${k + 1}`).onclick = () => { startScenario(s); setPanel(true); }; });
const lensSel = $<HTMLSelectElement>('lens');
function setLens(l: Lens) { world.setLens(l); lensSel.value = l; const tip = LENS_TIPS[l]; if (tip) say(tip); }
lensSel.onchange = () => setLens(lensSel.value as Lens);
document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(b => {
  b.onclick = () => {
    const z = b.dataset.zoom as Zoom;
    world.flyTo(z);
    document.querySelectorAll('[data-zoom]').forEach(o => o.classList.toggle('on', o === b));
    if (z === 'watershed') setLens('watershed');
    else if (world.lens === 'watershed') setLens('surface');
    if (z === 'region') say(level.regionNote, 'PLACE');
  };
});
const setPanel = (c: boolean) => { $('panel').classList.toggle('collapsed', c); $('panelToggle').textContent = c ? 'More' : 'Close'; };
setPanel(true);
$('panelToggle').onclick = () => setPanel(!$('panel').classList.contains('collapsed'));
rainIn.oninput = () => { exitReplay(); freePlay(); sim.rain = +rainIn.value; playing = true; updatePlay(); };
tideIn.oninput = () => { exitReplay(); freePlay(); sim.tide = +tideIn.value; playing = true; updatePlay(); };
$('rpPlay').onclick = () => { if (!replay) return; replay.playing = !replay.playing; $('rpPlay').textContent = replay.playing ? 'Pause' : 'Play'; };
$<HTMLInputElement>('rpSlider').oninput = e => { if (replay) { replay.k = +(e.target as HTMLInputElement).value; replay.playing = false; $('rpPlay').textContent = 'Play'; } };
$('rpExit').onclick = exitReplay;

// Tap vs drag
let down: { x: number; y: number; t: number } | null = null;
const cv = world.renderer.domElement;
cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
document.addEventListener('pointerdown', () => sound.start());
const setSoundLabel = () => { $('sound').textContent = sound.muted ? 'Sound: off' : 'Sound: on'; };
setSoundLabel();
$('sound').onclick = () => { sound.toggle(); setSoundLabel(); };
cv.addEventListener('pointerup', e => {
  if (!down) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 500) applyTool(e.clientX, e.clientY);
  down = null;
});

function footprint(i: number, t: Tool): number[] {
  const x = i % N, y = Math.floor(i / N), out: number[] = [];
  const add = (cx: number, cy: number) => { if (cx >= 0 && cy >= 0 && cx < N && cy < N) out.push(cy * N + cx); };
  if (t === 'pond' || t === 'remove') { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(x + dx, y + dy); }
  else if (t === 'swale') { for (let dy = -2; dy <= 2; dy++) add(x, y + dy); }
  else if (t === 'wall') { for (let dy = -1; dy <= 1; dy++) add(x, y + dy); }
  else add(x, y);
  return out;
}

function earthwork(i: number, kind: Earthwork) {
  const cells = footprint(i, kind === 'restore' ? 'remove' : kind as Tool);
  const changed: number[] = [];
  let reason = '';
  for (const c of cells) {
    if (kind === 'restore' && sim.elev[c] === sim.elev0[c] && sim.surface[c] === sim.surface0[c]) continue;
    const r = sim.modify(c, kind);
    if (r) { if (c === i) reason = r; } else changed.push(c);
  }
  if (changed.length) world.refreshCells(changed);
  else say(reason || 'Nothing changed here.');
}

function applyTool(cx: number, cy: number) {
  if (replay) return;
  const i = world.pick(cx, cy);
  world.showCursor(i);
  if (i === null) { callout.close(); return; }
  if (tool === 'inspect') { callout.show(i); return; }
  callout.close();
  applyAt(i, tool);
}

/** Use a tool on a cell (from a tap or from an info card button). */
function applyAt(i: number, t: Tool) {
  const prev = tool;
  tool = t;
  try { applyCell(i); } finally { tool = prev; }
}

function applyCell(i: number) {
  const surf = sim.surface[i];
  if (tool === 'sewer') {
    if (!sim.septicOn) { say('No septic tanks in this storm. Open More and pick Level 2: Septic season.'); return; }
    const h = sim.houseAt(i);
    if (h < 0) { say('Tap a house to connect its row to the sewer.'); return; }
    const k = sim.connectSewer(h);
    say(k ? `Connected ${k} homes to the sewer. Their septic tanks are retired.` : 'This row is already on sewer.');
    world.rebuildProps();
    return;
  }
  if (tool === 'swale' || tool === 'pond' || tool === 'wall' || tool === 'raise') { earthwork(i, tool); return; }
  const dr = sim.drainAt(i), pm = sim.pumpAt(i);
  if (tool === 'remove') {
    if (dr) sim.drains.splice(sim.drains.indexOf(dr), 1);
    else if (pm) sim.pumps.splice(sim.pumps.indexOf(pm), 1);
    else { earthwork(i, 'restore'); return; }
    world.rebuildProps();
    return;
  }
  if (sim.open[i] || surf === S.House || surf === S.Wall) { say("Can't build there."); return; }
  if (tool === 'drain') {
    if (dr || pm) { say('Something is already here.'); return; }
    sim.drains.push({ i, valve: false, flow: 0 });
  } else if (tool === 'valve') {
    if (pm) { say('A pump is here.'); return; }
    if (dr) dr.valve = true; else sim.drains.push({ i, valve: true, flow: 0 });
  } else if (tool === 'pump') {
    if (pm) { say('A pump is already here.'); return; }
    if (dr) sim.drains.splice(sim.drains.indexOf(dr), 1);
    sim.pumps.push({ i, flow: 0 });
  }
  world.rebuildProps();
}

// Main loop
let last = performance.now();
let replayAcc = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing) {
    for (let k = 0; k < speed; k++) {
      if (scenario) { sim.rain = scenario.rain(sim.time); sim.tide = scenario.tide(sim.time); }
      sim.step(0.25);
      if (scenario && sim.time - (frames.length ? frames[frames.length - 1].t : -99) >= 2) record();
      if (scenario && sim.time >= scenario.duration) { finish(); break; }
    }
  }
  let view: View;
  if (replay) {
    if (replay.playing) {
      replayAcc += dt * 8 * speed;
      while (replayAcc >= 1) { replayAcc--; replay.k++; }
      if (replay.k >= frames.length - 1) { replay.k = frames.length - 1; replay.playing = false; $('rpPlay').textContent = 'Play'; }
      $<HTMLInputElement>('rpSlider').value = String(replay.k);
    }
    const f = frames[replay.k];
    view = { water: f.water, conc: f.conc, vx: f.vx, vy: f.vy, tide: f.tide, rain: f.rain, live: false };
    $('rpTime').textContent = `${Math.floor(f.t / 60)}h ${String(Math.floor(f.t % 60)).padStart(2, '0')}m  tide ${f.tide.toFixed(1)} ft`;
    setNote(replay.note, 'REPLAY');
  } else {
    sim.computeFlow(liveVx, liveVy);
    view = { water: sim.water, conc: sim.conc, vx: liveVx, vy: liveVy, tide: sim.tide, rain: sim.rain, live: true };
    setNote(now < toastUntil ? toast : liveNote(sim), now < toastUntil ? toastLabel : 'TIP');
  }
  if (scenario) { rainIn.value = String(sim.rain); tideIn.value = String(sim.tide); }
  $('rainV').textContent = `${sim.rain.toFixed(1)} in/hr`;
  $('tideV').textContent = `${sim.tide.toFixed(1)} ft`;
  const hrs = Math.floor(sim.time / 60), mins = Math.floor(sim.time % 60);
  const worstNow = Math.max(0, ...sim.houses.map(h => h.depth)) * 12;
  const sewerTxt = sim.septicOn ? `   Septic failing ${sim.houses.filter(h => h.septicFail).length}${sim.liftLoad > 0.12 ? '   Sewer OVERFLOWING' : ''}` : '';
  $('stats').textContent = `${hrs}h ${String(mins).padStart(2, '0')}m   Tide ${sim.tide.toFixed(1)} ft   Worst house ${(sim.stats.worst * 12).toFixed(1)} in${worstNow > 0 ? ' (flooding now)' : ''}${sewerTxt}`;
  tutorial.update({ playing, time: sim.time, drains: sim.drains.length, finished: !!scenario && sim.time >= scenario.duration, tool, pause: () => { playing = false; updatePlay(); }, hint: cells => world.setHints(cells), selectTool });
  sound.update(view.rain, view.live ? sim.drains.reduce((a, d) => a + Math.max(0, -d.flow), 0) : 0, view.live && playing && sim.pumps.some(p => p.flow > 0.02));
  world.update(dt, now / 1000, view);
  callout.update(dt);
  if (!replay) pins.set(alerts()); else pins.set([]);
  pins.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

startScenario(SCENARIOS[0]);
playing = false;
updatePlay();
say('Storm 1. Press Play to start the rain, then place drains where water collects.');
if (!Tutorial.done() && level.id === 'halifax') tutorial.start();

// Header and place picker
$('placeName').textContent = level.name;
const placeSel = $<HTMLSelectElement>('placeSel');
placeSel.innerHTML = [{ id: 'halifax', name: 'Halifax Shores (practice town)', county: 'Volusia' }, ...PLACE_INDEX].map(p => `<option value="${p.id}">${p.name}${p.id === 'halifax' ? '' : `, ${p.county} County`}</option>`).join('');
placeSel.value = level.id;
placeSel.onchange = () => { location.search = `?place=${placeSel.value}`; };
$('randomPlace').onclick = () => { const others = PLACE_INDEX.filter(p => p.id !== level.id); if (others.length) location.search = `?place=${others[Math.floor(Math.random() * others.length)].id}`; };

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
