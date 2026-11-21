import './style.css';
import { Sim, S, SURFACE_NAMES, type Earthwork } from './sim/grid.ts';
import { buildLevel1, SCENARIOS, N, type Scenario } from './levels/level1.ts';
import { World, type Lens, type View, type Zoom } from './render/world.ts';
import { liveNote, resultNote } from './ui/feedback.ts';

type Tool = 'inspect' | 'drain' | 'valve' | 'pump' | 'swale' | 'pond' | 'raise' | 'remove';
interface Frame { t: number; water: Float32Array; vx: Float32Array; vy: Float32Array; tide: number; rain: number }

const TIPS: Record<Tool, string> = {
  inspect: 'Inspect: tap any spot to see its height, water and groundwater.',
  drain: 'Storm drain: collects water and pipes it to the outfall in the bay.',
  valve: 'Check valve: a flap that lets water out but stops the bay pushing back in.',
  pump: 'Pump: lifts water into the bay, even when the tide is high.',
  swale: 'Swale: a shallow grassy strip that holds runoff and lets it soak in. Best beside a road, in lighter storms.',
  pond: 'Retention pond: a basin that stores water until it soaks away. Only works if water can flow into it.',
  raise: 'Raise road: lifts a road tile 6 inches. Tap again for a full foot.',
  remove: 'Remove: tap to undo a drain, pump, swale, pond or raised road.',
};
const LENS_TIPS: Partial<Record<Lens, string>> = {
  elevation: 'Elevation: blue is low ground, brown is high. Lines mark every half foot.',
  groundwater: 'Groundwater: blue means the soil is full and rain cannot soak in. Tan means room to absorb.',
  flow: 'Flow arrows: which way water is moving right now.',
  tide: 'High tide: red ground sits below the current tide. Only the seawall and check valves keep the bay out.',
  watershed: 'Watershed: orange land drains toward the bay, green toward the ocean. Blue is the bowl behind the seawall where water pools if nothing drains it.',
  pipes: 'Pipes: underground drain lines to the outfall. Cyan is flowing out, red is running backward.',
};

const sim = new Sim(buildLevel1());
const world = new World(document.getElementById('app')!, sim);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let scenario: Scenario | null = null;
let playing = false;
let speed = 1;
let tool: Tool = 'drain';
let toast = '';
let toastUntil = 0;
let frames: Frame[] = [];
let replay: { k: number; playing: boolean; note: string } | null = null;
const liveVx = new Float32Array(N * N), liveVy = new Float32Array(N * N);

const rainIn = $<HTMLInputElement>('rain');
const tideIn = $<HTMLInputElement>('tide');

function say(msg: string) { toast = msg; toastUntil = performance.now() + 4000; }

function startScenario(s: Scenario) {
  exitReplay();
  scenario = s;
  sim.gwOffset = s.gwOffset;
  sim.tide = s.tide(0);
  sim.rain = s.rain(0);
  sim.reset();
  frames = [];
  playing = true;
  $('modal').classList.add('hidden');
  $('mode').textContent = s.title;
  $('concept').textContent = s.concept;
  if (world.lens === 'groundwater') world.paintColors();
  updatePlay();
}

function freePlay() {
  if (scenario) { scenario = null; $('mode').textContent = 'Free play'; $('concept').textContent = 'Set rain and tide yourself.'; }
}

function record() {
  const vx = new Float32Array(N * N), vy = new Float32Array(N * N);
  sim.computeFlow(vx, vy);
  frames.push({ t: sim.time, water: sim.water.slice(), vx, vy, tide: sim.tide, rain: sim.rain });
}

function finish() {
  playing = false;
  updatePlay();
  const s = scenario!;
  const w = sim.stats.worst * 12;
  const next = SCENARIOS[SCENARIOS.indexOf(s) + 1];
  const note = resultNote(sim);
  $('modal').innerHTML = `
    <h2>${s.title}</h2>
    <div class="grade ${w > 0 ? 'bad' : 'good'}">${w > 0 ? `${w.toFixed(1)} in of water inside the worst house` : 'All floors dry'}</div>
    <p>${note}</p>
    <div class="row">
      <button id="watch" class="${w > 0 ? 'primary' : ''}">Watch replay</button>
      <button id="retry">Retry</button>
      ${w <= 0 && next ? '<button id="next" class="primary">Next storm</button>' : ''}
      <button id="close">Keep building</button>
    </div>`;
  $('modal').classList.remove('hidden');
  $('watch').onclick = () => startReplay(note);
  $('retry').onclick = () => startScenario(s);
  if (w <= 0 && next) $('next').onclick = () => startScenario(next);
  $('close').onclick = () => $('modal').classList.add('hidden');
}

function startReplay(note: string) {
  if (frames.length < 2) return;
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

// Tools
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => {
  b.onclick = () => {
    tool = b.dataset.tool as Tool;
    document.querySelectorAll('[data-tool]').forEach(o => o.classList.toggle('on', o === b));
    say(TIPS[tool]);
  };
});

$('play').onclick = () => {
  exitReplay();
  if (scenario && sim.time >= scenario.duration) { startScenario(scenario); return; }
  playing = !playing; updatePlay();
};
$('speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speed').textContent = `${speed}x`; };
$('reset').onclick = () => { if (scenario) startScenario(scenario); else sim.reset(); };
SCENARIOS.forEach((s, k) => { $(`s${k + 1}`).onclick = () => startScenario(s); });
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
    if (z === 'region') say('Region: your neighborhood is one block on a long, low barrier island between the bay and the ocean.');
  };
});
const setPanel = (c: boolean) => { $('panel').classList.toggle('collapsed', c); $('panelToggle').textContent = c ? 'More' : 'Hide'; };
setPanel(innerWidth < 640);
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
  if (i === null) return;
  const surf = sim.surface[i];
  if (tool === 'inspect') {
    say(`${SURFACE_NAMES[surf]}. Ground ${sim.elev[i].toFixed(2)} ft, water ${(sim.water[i] * 12).toFixed(1)} in, water table ${sim.gw[i].toFixed(2)} ft (${Math.max(0, (sim.elev[i] - sim.gw[i]) * 12).toFixed(0)} in below ground).${world.watershed.fill[i] > 0 ? ` If nothing drained, water would pool ${(world.watershed.fill[i] * 12).toFixed(0)} in deep here.` : ''}`);
    return;
  }
  if (tool === 'swale' || tool === 'pond' || tool === 'raise') { earthwork(i, tool); return; }
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
    view = { water: f.water, vx: f.vx, vy: f.vy, tide: f.tide, rain: f.rain, live: false };
    $('rpTime').textContent = `${Math.floor(f.t / 60)}h ${String(Math.floor(f.t % 60)).padStart(2, '0')}m  tide ${f.tide.toFixed(1)} ft`;
    $('note').textContent = `Replay. ${replay.note}`;
  } else {
    if (world.lens === 'flow') sim.computeFlow(liveVx, liveVy);
    view = { water: sim.water, vx: liveVx, vy: liveVy, tide: sim.tide, rain: sim.rain, live: true };
    $('note').textContent = now < toastUntil ? toast : liveNote(sim);
  }
  if (scenario) { rainIn.value = String(sim.rain); tideIn.value = String(sim.tide); }
  $('rainV').textContent = `${sim.rain.toFixed(1)} in/hr`;
  $('tideV').textContent = `${sim.tide.toFixed(1)} ft`;
  const hrs = Math.floor(sim.time / 60), mins = Math.floor(sim.time % 60);
  const worstNow = Math.max(0, ...sim.houses.map(h => h.depth)) * 12;
  $('stats').textContent = `${hrs}h ${String(mins).padStart(2, '0')}m   Tide ${sim.tide.toFixed(1)} ft   Worst house ${(sim.stats.worst * 12).toFixed(1)} in${worstNow > 0 ? ' (flooding now)' : ''}`;
  world.update(dt, now / 1000, view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

startScenario(SCENARIOS[0]);
playing = false;
updatePlay();
say('Storm 1. Press Play to start the rain, then place drains where water collects.');

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
