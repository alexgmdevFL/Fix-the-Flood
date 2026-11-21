import './style.css';
import { Sim, S, SURFACE_NAMES } from './sim/grid.ts';
import { buildLevel1, SCENARIOS, type Scenario } from './levels/level1.ts';
import { World } from './render/world.ts';
import { liveNote, resultNote } from './ui/feedback.ts';

type Tool = 'inspect' | 'drain' | 'valve' | 'pump' | 'remove';

const sim = new Sim(buildLevel1());
const world = new World(document.getElementById('app')!, sim);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let scenario: Scenario | null = null;
let playing = false;
let speed = 1;
let tool: Tool = 'drain';
let toast = '';
let toastUntil = 0;

const rainIn = $<HTMLInputElement>('rain');
const tideIn = $<HTMLInputElement>('tide');

function say(msg: string) { toast = msg; toastUntil = performance.now() + 3500; }

function startScenario(s: Scenario) {
  scenario = s;
  sim.gwOffset = s.gwOffset;
  sim.tide = s.tide(0);
  sim.rain = s.rain(0);
  sim.reset();
  playing = true;
  $('modal').classList.add('hidden');
  $('mode').textContent = s.title;
  $('concept').textContent = s.concept;
  updatePlay();
}

function freePlay() {
  if (scenario) { scenario = null; $('mode').textContent = 'Free play'; $('concept').textContent = 'Set rain and tide yourself.'; }
}

function finish() {
  playing = false;
  updatePlay();
  const s = scenario!;
  const w = sim.stats.worst * 12;
  const idx = SCENARIOS.indexOf(s);
  const next = SCENARIOS[idx + 1];
  $('modal').innerHTML = `
    <h2>${s.title}</h2>
    <div class="grade ${w > 0 ? 'bad' : 'good'}">${w > 0 ? `${w.toFixed(1)} in of water inside the worst house` : 'All floors dry'}</div>
    <p>${resultNote(sim)}</p>
    <div class="row">
      <button id="retry">Retry</button>
      ${w <= 0 && next ? '<button id="next" class="primary">Next storm</button>' : ''}
      <button id="close">Keep building</button>
    </div>`;
  $('modal').classList.remove('hidden');
  $('retry').onclick = () => startScenario(s);
  if (w <= 0 && next) $('next').onclick = () => startScenario(next);
  $('close').onclick = () => $('modal').classList.add('hidden');
}

function updatePlay() { $('play').textContent = playing ? 'Pause' : 'Play'; }

// Tool buttons
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => {
  b.onclick = () => {
    tool = b.dataset.tool as Tool;
    document.querySelectorAll('[data-tool]').forEach(o => o.classList.toggle('on', o === b));
  };
});

$('play').onclick = () => {
  if (scenario && sim.time >= scenario.duration) { startScenario(scenario); return; }
  playing = !playing; updatePlay();
};
$('speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speed').textContent = `${speed}x`; };
$('reset').onclick = () => { sim.reset(); if (scenario) startScenario(scenario); };
$('s1').onclick = () => startScenario(SCENARIOS[0]);
$('s2').onclick = () => startScenario(SCENARIOS[1]);
$('lens').onclick = () => {
  world.setLens(world.lens === 'surface' ? 'elevation' : 'surface');
  $('lens').textContent = world.lens === 'surface' ? 'Elevation lens' : 'Surface view';
};
const setPanel = (c: boolean) => { $('panel').classList.toggle('collapsed', c); $('panelToggle').textContent = c ? 'More' : 'Hide'; };
setPanel(innerWidth < 640);
$('panelToggle').onclick = () => setPanel(!$('panel').classList.contains('collapsed'));
rainIn.oninput = () => { freePlay(); sim.rain = +rainIn.value; playing = true; updatePlay(); };
tideIn.oninput = () => { freePlay(); sim.tide = +tideIn.value; playing = true; updatePlay(); };

// Tap vs drag on the map
let down: { x: number; y: number; t: number } | null = null;
const cv = world.renderer.domElement;
cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
cv.addEventListener('pointerup', e => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved < 8 && performance.now() - down.t < 500) applyTool(e.clientX, e.clientY);
  down = null;
});

function applyTool(cx: number, cy: number) {
  const i = world.pick(cx, cy);
  world.showCursor(i);
  if (i === null) return;
  const surf = sim.surface[i];
  if (tool === 'inspect') {
    say(`${SURFACE_NAMES[surf]}. Ground ${sim.elev[i].toFixed(2)} ft, water ${(sim.water[i] * 12).toFixed(1)} in, groundwater ${sim.gw[i].toFixed(2)} ft.`);
    return;
  }
  if (sim.open[i] || surf === S.House || surf === S.Wall) { say("Can't build there."); return; }
  const dr = sim.drainAt(i), pm = sim.pumpAt(i);
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
  } else if (tool === 'remove') {
    if (dr) sim.drains.splice(sim.drains.indexOf(dr), 1);
    else if (pm) sim.pumps.splice(sim.pumps.indexOf(pm), 1);
  }
  world.rebuildProps();
}

// Main loop
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing) {
    for (let k = 0; k < speed; k++) {
      if (scenario) {
        sim.rain = scenario.rain(sim.time);
        sim.tide = scenario.tide(sim.time);
      }
      sim.step(0.25);
      if (scenario && sim.time >= scenario.duration) { finish(); break; }
    }
  }
  if (scenario) { rainIn.value = String(sim.rain); tideIn.value = String(sim.tide); }
  $('rainV').textContent = `${sim.rain.toFixed(1)} in/hr`;
  $('tideV').textContent = `${sim.tide.toFixed(1)} ft`;
  const hrs = Math.floor(sim.time / 60), mins = Math.floor(sim.time % 60);
  const worstNow = Math.max(0, ...sim.houses.map(h => h.depth)) * 12;
  $('stats').textContent = `${hrs}h ${String(mins).padStart(2, '0')}m   Outfall ${sim.outfallElev.toFixed(1)} ft   Worst house ${(sim.stats.worst * 12).toFixed(1)} in${worstNow > 0 ? ' (flooding now)' : ''}`;
  $('note').textContent = now < toastUntil ? toast : liveNote(sim);
  world.update(dt, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

startScenario(SCENARIOS[0]);
playing = false;
updatePlay();
say('Storm 1. Press Play to start the rain, then place drains where water collects.');

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
