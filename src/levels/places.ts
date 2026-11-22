// Turns a baked real-place file (public/places/<id>.json) into a playable level with storms built from its own data.
import { S, type House, type LevelData } from '../sim/grid.ts';
import { finalize } from './finalize.ts';
import type { Level, Scenario, MapLabel } from './types.ts';

export interface PlaceJSON {
  id: string; name: string; county: string; waterName: string; lat: number; lon: number;
  n: number; cellMeters: number; elev: number[]; surface: number[]; open: number[]; houses: number[][];
  roads: { w: number; pts: [number, number][] }[]; bigBuildings: { a: number; pts: [number, number][] }[];
  tide: { station: string; stationName: string; distMi: number; mhhw: number; msl: number; hat: number; hatEstimated: boolean };
  rain: { ari: number[]; h1: number[]; h2: number[]; h3: number[]; h24: number[] };
  calib?: { s1: number; s2: number; s3: number; sep: number; floorOffset: number; solvable: boolean; solution?: { drains: number[]; pumps: number[] } };
}

export const DEFAULT_FLOOR = 0.8; // ft from ground to finished floor (a typical slab)

/** The elevation tiles sometimes catch buildings, bridges or tree canopy. Pull any cell that sticks up far above
 * its neighbors back to the local typical height, and cap everything just above the area's normal high ground. */
function despike(raw: number[], open: number[], n: number) {
  const out = Float32Array.from(raw);
  const land = raw.filter((_, i) => !open[i]).sort((a, b) => a - b);
  if (!land.length) return out;
  const cap = land[Math.floor(land.length * 0.9)] + 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (open[i]) continue;
    const nb: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < n && Y < n && !open[Y * n + X]) nb.push(raw[Y * n + X]);
    }
    nb.sort((a, b) => a - b);
    const med = nb[Math.floor(nb.length / 2)];
    out[i] = Math.min(raw[i] > med + 2 ? med : raw[i], cap);
  }
  return out;
}

export function placeData(js: PlaceJSON, floorOffset = js.calib?.floorOffset ?? DEFAULT_FLOOR): LevelData {
  const n = js.n;
  const elev = despike(js.elev, js.open, n);
  const houses: House[] = js.houses.map(cells => {
    let mx = -99, mn = 99;
    for (const c of cells) { mx = Math.max(mx, elev[c]); mn = Math.min(mn, elev[c]); }
    return { cells, floor: mx + floorOffset, ground: mn, depth: 0, maxDepth: 0, septic: -1, manhole: -1, sewer: false, septicFail: false };
  });
  return {
    n, elev, surface: Uint8Array.from(js.surface), open: Uint8Array.from(js.open), houses,
    outfallElev: js.tide.mhhw - 0.2, // game assumption: outfall pipes sit just under normal high tide
    liftCell: -1, tideNormal: js.tide.mhhw, gw0: js.tide.mhhw + 0.4, waterName: js.waterName,
  };
}

const f1 = (v: number) => v.toFixed(1);

export function placeScenarios(js: PlaceJSON): Scenario[] {
  const c = js.calib ?? { s1: 3, s2: 1, s3: 2, sep: 1 };
  const { ari, h2, h3 } = js.rain;
  const t = js.tide;
  const pct = (k: number) => Math.max(1, Math.round(100 / ari[k]));
  const high = (v: number) => v >= 0 ? `${f1(v)} ft above` : `${f1(-v)} ft below`;
  const hatTxt = t.hatEstimated ? `about ${f1(t.hat)} ft (estimated)` : `${f1(t.hat)} ft`;
  return [
    {
      id: 'storm1', title: `Storm 1: ${ari[c.s1]}-year downpour`,
      concept: 'Water flows downhill. Drains need somewhere to go.',
      duration: 240, rain: m => (m < 120 ? h2[c.s1] / 2 : 0), tide: () => t.mhhw, gwOffset: 0,
      fact: `NOAA Atlas 14 says a ${ari[c.s1]}-year storm here drops ${f1(h2[c.s1])} inches of rain in 2 hours. That size of storm has about a ${pct(c.s1)}% chance of happening in any year.`,
    },
    {
      id: 'storm2', title: 'Storm 2: Rain plus king tide',
      concept: `When ${js.waterName} is higher than the outfall, drains run backward.`,
      duration: 300, rain: m => (m >= 60 && m < 180 ? h2[c.s2] / 2 : 0),
      tide: m => t.mhhw - 0.3 + (t.hat - t.mhhw + 0.3) * Math.max(0, Math.sin(Math.PI * m / 300)), gwOffset: 0,
      fact: `NOAA's tide gauge at ${t.stationName}, ${t.distMi} miles away, puts normal high tide here at ${high(t.mhhw)} the NAVD88 reference level, and the highest predicted tides at ${hatTxt}.`,
    },
    {
      id: 'storm3', title: 'Storm 3: Wet season',
      concept: 'When the ground is already full, rain cannot soak in, and water rises from below.',
      duration: 240, rain: m => (m < 180 ? h3[c.s3] / 3 : 0), tide: () => t.mhhw, gwOffset: 0.8,
      fact: `Most of Florida's rain falls in the wet season, June through October. This storm is a ${ari[c.s3]}-year, 3-hour rain here: ${f1(h3[c.s3])} inches, onto ground that is already soaked.`,
    },
    {
      id: 'septic', title: 'Level 2: Septic season', septic: true,
      concept: 'A septic tank needs dry soil under it. When the water table rises, sewage comes up instead of soaking in.',
      duration: 240, rain: m => (m < 120 ? h2[c.sep] / 2 : 0), tide: () => t.mhhw, gwOffset: 0.6,
      fact: `Florida has more than 2 million septic tanks. Many counties, including ${js.county}, are paying to move neighborhoods from septic to sewer to protect rivers and bays.`,
    },
  ];
}

export function placeLevel(js: PlaceJSON): Level {
  const d = placeData(js);
  const lay = finalize(d);
  const n = js.n;
  let ox = 0, oy = 0, oc = 0;
  for (let i = 0; i < n * n; i++) if (d.open[i]) { ox += i % n; oy += Math.floor(i / n); oc++; }
  const labels: MapLabel[] = [
    { text: 'Outfall pipe', gx: lay.outfallCell % n, gy: Math.floor(lay.outfallCell / n) + 1.4, y: 0.5, min: 50, max: 110 },
    { text: 'Your neighborhood', gx: n / 2, gy: -3, y: 1.5, min: 90 },
    { text: `${js.name}, ${js.county} County`, gx: n / 2, gy: -30, y: 1, min: 90 },
  ];
  if (oc) labels.unshift({ text: js.waterName, gx: ox / oc, gy: oy / oc, y: 0.5, min: 50 });
  if (lay.suggest.length) labels.push({ text: 'If nothing drained, water pools here', gx: lay.suggest[0] % n, gy: Math.floor(lay.suggest[0] / n), y: 1.5, min: 0, max: 999, lens: 'watershed' });
  const houses = d.houses.length;
  return {
    ...d, ...lay, id: js.id, name: js.name, county: js.county, real: true,
    roads: js.roads, bigBuildings: js.bigBuildings, labels, scenarios: placeScenarios(js),
    regionNote: `${js.name} in ${js.county} County. This ${Math.round(n * js.cellMeters)} meter square is built from real elevation, streets and ${houses} real homes, with tides from the NOAA gauge at ${js.tide.stationName}.`,
  };
}

export { S };
