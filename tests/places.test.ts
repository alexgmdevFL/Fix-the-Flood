// Every playable real place must flood with nothing built and be winnable with drains and pumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Sim } from '../src/sim/grid.ts';
import { placeData, placeScenarios, placeLevel, type PlaceJSON } from '../src/levels/places.ts';
import { finalize, autoSolution } from '../src/levels/finalize.ts';

const DIR = new URL('../public/places/', import.meta.url).pathname;
const index: { id: string }[] = existsSync(DIR + 'index.json') ? JSON.parse(readFileSync(DIR + 'index.json', 'utf8')) : [];

function storm1(js: PlaceJSON, setup: (s: Sim) => void = () => {}) {
  const d = placeData(js); finalize(d);
  const s = new Sim(d); setup(s);
  const sc = placeScenarios(js)[0];
  s.tide = sc.tide(0); s.reset();
  while (s.time < sc.duration) { s.rain = sc.rain(s.time); s.tide = sc.tide(s.time); s.step(0.25); }
  return s;
}

for (const { id } of index) {
  const js: PlaceJSON = JSON.parse(readFileSync(DIR + id + '.json', 'utf8'));
  test(`${id}: loads as a level with homes, roads and an outfall`, () => {
    const L = placeLevel(js);
    assert.ok(L.houses.length >= 6);
    assert.ok(L.roads.length > 0);
    assert.ok(L.outfallCell >= 0);
    assert.equal(L.scenarios.length, 4);
  });
  test(`${id}: storm 1 floods homes when nothing is built`, () => { assert.ok(storm1(js).stats.worst > 0); });
  test(`${id}: storm 1 can be won with drains and pumps`, () => {
    const won = [[6, 1], [10, 2], [14, 3], [20, 5]].some(([k, p]) => storm1(js, s => {
      const sol = autoSolution(placeData(js), k, p);
      for (const i of sol.drains) s.drains.push({ i, valve: false, flow: 0 });
      for (const i of sol.pumps) s.pumps.push({ i, flow: 0 });
    }).stats.worst === 0);
    assert.ok(won);
  });
}
