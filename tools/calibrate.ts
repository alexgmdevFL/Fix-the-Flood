// Picks each real place's storms from its own NOAA Atlas 14 rainfall: the smallest real storm that floods
// homes when nothing is built, as long as a reasonable set of drains and pumps can still keep every floor dry.
// Writes calib into each place file and lists the playable places in public/places/index.json.
// Run: node --experimental-strip-types --no-warnings tools/calibrate.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Sim } from '../src/sim/grid.ts';
import { placeData, placeScenarios, type PlaceJSON } from '../src/levels/places.ts';
import { finalize, autoSolution } from '../src/levels/finalize.ts';

const DIR = new URL('../public/places/', import.meta.url).pathname;
const SOLUTIONS: [number, number][] = [[6, 1], [10, 2], [14, 3], [20, 5]];

function run(js: PlaceJSON, sc: number, setup: (s: Sim) => void = () => {}) {
  const d = placeData(js);
  finalize(d);
  const s = new Sim(d);
  setup(s);
  const S = placeScenarios(js)[sc];
  s.septicOn = !!S.septic; s.gwOffset = S.gwOffset; s.tide = S.tide(0); s.reset();
  while (s.time < S.duration) { s.rain = S.rain(s.time); s.tide = S.tide(s.time); s.step(0.25); }
  return s;
}
const build = (js: PlaceJSON, k: number, p: number, valve: boolean) => (s: Sim) => {
  const sol = autoSolution(placeData(js), k, p);
  for (const i of sol.drains) s.drains.push({ i, valve, flow: 0 });
  for (const i of sol.pumps) s.pumps.push({ i, flow: 0 });
};
const solves = (js: PlaceJSON, sc: number, valve: boolean) => SOLUTIONS.find(([k, p]) => run(js, sc, build(js, k, p, valve)).stats.worst === 0);

const index: { id: string; name: string; county: string }[] = [];
for (const f of readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json').sort()) {
  const js: PlaceJSON = JSON.parse(readFileSync(DIR + f, 'utf8'));
  if (js.houses.length < 6) { console.log(js.id.padEnd(18), 'skipped: only', js.houses.length, 'homes'); continue; }
  const max = js.rain.ari.findIndex(a => a > 100);
  const top = max < 0 ? js.rain.ari.length : max;
  let found: { s1: number; floor: number; sol: [number, number] } | null = null;
  for (const floor of [0.8, 0.5, 0.3]) {
    for (let k = 0; k < top && !found; k++) {
      js.calib = { s1: k, s2: 1, s3: Math.max(0, k - 1), sep: 1, floorOffset: floor, solvable: false };
      if (run(js, 0).stats.worst <= 0) continue;
      const sol = solves(js, 0, false);
      if (sol) found = { s1: k, floor, sol };
      else break; // bigger storms will not get easier
    }
    if (found) break;
  }
  if (!found) { console.log(js.id.padEnd(18), 'skipped: no real storm floods homes here and can still be won'); continue; }
  let s3 = found.s1;
  js.calib = { s1: found.s1, s2: 1, s3, sep: 1, floorOffset: found.floor, solvable: true };
  while (s3 > 0 && !solves(js, 2, false)) { s3--; js.calib.s3 = s3; }
  const s2ok = !!solves(js, 1, true);
  js.calib.solvable = s2ok;
  writeFileSync(DIR + f, JSON.stringify(js));
  index.push({ id: js.id, name: js.name, county: js.county });
  const a = js.rain.ari;
  console.log(js.id.padEnd(18), `homes ${js.houses.length}  floor +${found.floor} ft  storm1 ${a[found.s1]}-yr (${js.rain.h2[found.s1]} in/2h)  storm3 ${a[s3]}-yr  solution ${found.sol.join('/')}  king tide ${s2ok ? 'ok' : 'hard'}`);
}
index.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(DIR + 'index.json', JSON.stringify(index));
console.log('playable places:', index.length);
