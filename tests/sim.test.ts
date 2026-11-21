// Headless storm runs that pin down the lessons of Level 1. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim/grid.ts';
import { buildLevel1, SCENARIOS, N } from '../src/levels/level1.ts';
import { computeWatershed } from '../src/sim/watershed.ts';

function run(k: number, setup: (s: Sim) => void = () => {}) {
  const s = new Sim(buildLevel1());
  setup(s);
  const sc = SCENARIOS[k];
  s.gwOffset = sc.gwOffset; s.tide = sc.tide(0); s.reset();
  while (s.time < sc.duration) { s.rain = sc.rain(s.time); s.tide = sc.tide(s.time); s.step(0.25); }
  return s;
}
const six = (s: Sim, valve = false) => { for (const y of [4, 12, 20, 27, 35, 43]) s.drains.push({ i: y * N + 19, valve, flow: 0 }); };
const two = (s: Sim) => { for (const y of [12, 35]) s.pumps.push({ i: y * N + 21, flow: 0 }); };

test('storm 1 floods houses when nothing is built', () => { assert.ok(run(0).stats.worst > 0); });
test('storm 1: six street drains keep every floor dry', () => { assert.equal(run(0, six).stats.worst, 0); });
test('storm 2: plain drains run backward at king tide', () => {
  const s = run(1, six);
  assert.ok(s.stats.backflow > 1);
  assert.ok(s.stats.worst > 0);
});
test('storm 2: check valves plus two pumps keep floors dry', () => { assert.equal(run(1, s => { six(s, true); two(s); }).stats.worst, 0); });
test('storm 3: drains alone fail in the wet season, pumps fix it', () => {
  assert.ok(run(2, six).stats.worst > 0);
  assert.equal(run(2, s => { six(s); two(s); }).stats.worst, 0);
});
test('drains pipe into a pond within reach', () => {
  const s = new Sim(buildLevel1());
  s.drains.push({ i: 10 * N + 19, valve: false, flow: 0 });
  s.modify(10 * N + 12, 'pond');
  s.connectDrains();
  assert.equal(s.drains[0].to, 10 * N + 12);
});
test('earthworks undo cleanly', () => {
  const s = new Sim(buildLevel1());
  const i = 10 * N + 12;
  s.modify(i, 'pond');
  assert.notEqual(s.elev[i], s.elev0[i]);
  s.modify(i, 'restore');
  assert.equal(s.elev[i], s.elev0[i]);
});
test('watershed: the street sits in a bowl behind the seawall', () => {
  const w = computeWatershed(new Sim(buildLevel1()));
  assert.ok(w.fill[23 * N + 19] > 1);
});

function runSeptic(setup: (s: Sim) => void = () => {}) {
  const s = new Sim(buildLevel1());
  setup(s);
  const sc = SCENARIOS[3];
  s.septicOn = true; s.gwOffset = sc.gwOffset; s.tide = sc.tide(0); s.reset();
  while (s.time < sc.duration) { s.rain = sc.rain(s.time); s.tide = sc.tide(s.time); s.step(0.25); }
  return s;
}
const sewerAll = (s: Sim) => { s.connectSewer(0); s.connectSewer(8); s.connectSewer(16); };
test('level 2: septic tanks fail in the wet season', () => { assert.ok(runSeptic().stats.septicFails > 0); });
test('level 2: sewer alone overflows when the street floods', () => { const s = runSeptic(sewerAll); assert.equal(s.stats.septicFails, 0); assert.ok(s.stats.overflow > 0); });
test('level 2: sewer plus drains and pumps keeps sewage out', () => { const s = runSeptic(x => { sewerAll(x); six(x); two(x); }); assert.equal(s.stats.sewage, 0); assert.equal(s.stats.worst, 0); });
