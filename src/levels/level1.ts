// Level 1: "One Street, One Storm". Halifax Shores, a fictional block on Volusia County's barrier island.
// Halifax River (the Intracoastal lagoon) to the west, Atlantic Ocean to the east.
import { S, type LevelData, type House } from '../sim/grid.ts';
import type { Level, Scenario } from './types.ts';
import { finalize } from './finalize.ts';
export type { Scenario } from './types.ts';

export const N = 48;
export const OUTFALL_ROW = 23;

const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

export function buildLevel1(): LevelData {
  const elev = new Float32Array(N * N);
  const surface = new Uint8Array(N * N);
  const open = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let e: number;
      let s: number = S.Grass;
      const noise = 0.06 * Math.sin(x * 0.9 + y * 0.3) * Math.cos(y * 0.55 - x * 0.2);
      if (x <= 5) { e = -3.5 + x * 0.25; s = S.Water; open[i] = 1; }
      else if (x === 6) { e = 3.2; s = S.Wall; }
      else if (x <= 36) {
        e = x < 20 ? 2.0 + 0.8 * smooth((20 - x) / 13) : 2.0 + 1.6 * smooth((x - 20) / 16);
        e += noise;
        if (x >= 19 && x <= 21) { s = S.Pavement; e = x === 20 ? 2.05 : 1.98; } // crowned road, low gutters
        if (y >= 22 && y <= 24) { s = S.Pavement; e -= 0.1; }
      } else if (x <= 41) {
        const t = (x - 36) / 5;
        e = 3.6 + 2.2 * Math.sin(Math.PI * t) - 0.9 * t; s = S.Sand;
      } else {
        e = 2.7 - (x - 41) * 1.1; s = S.Sand;
        if (e < -0.5) { open[i] = 1; s = S.Water; }
        e = Math.max(e, -4);
      }
      elev[i] = e; surface[i] = s;
    }
  }
  const houses: House[] = [];
  for (const hx of [14, 24, 30]) {
    for (const hy of [2, 7, 12, 17, 27, 32, 37, 42]) {
      const cells = [hy * N + hx, hy * N + hx + 1, (hy + 1) * N + hx, (hy + 1) * N + hx + 1];
      let mx = -99, mn = 99;
      for (const c of cells) { mx = Math.max(mx, elev[c]); mn = Math.min(mn, elev[c]); surface[c] = S.House; }
      const septic = hy * N + (hx === 14 ? hx - 1 : hx + 2);
      const manhole = hy * N + (hx === 14 ? 19 : hx === 24 ? 21 : 28);
      houses.push({ cells, floor: mx + 0.4, ground: mn, depth: 0, maxDepth: 0, septic, manhole, sewer: false, septicFail: false });
    }
  }
  return { n: N, elev, surface, open, houses, outfallElev: 1.2, liftCell: 26 * N + 22 };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'storm1', title: 'Storm 1: Heavy rain',
    concept: 'Water flows downhill. Drains need somewhere to go.',
    duration: 240, rain: t => (t < 120 ? 3 : 0), tide: () => 1.0, gwOffset: 0,
    fact: 'Summer thunderstorms in Volusia County can drop 2 to 3 inches of rain in an hour. Streets are built to carry water to drains, which is why they flood first.',
  },
  {
    id: 'storm2', title: 'Storm 2: Rain plus king tide',
    concept: 'When the river is higher than the outfall, drains run backward.',
    duration: 300, rain: t => (t >= 60 && t < 180 ? 2.5 : 0),
    tide: t => 1.0 + 1.9 * Math.max(0, Math.sin(Math.PI * t / 300)), gwOffset: 0,
    fact: 'King tides along the Volusia coast are highest in the fall, when the sun and moon line up. On those days water can bubble up through street drains with no rain at all.',
  },
  {
    id: 'storm3', title: 'Storm 3: Wet season',
    concept: 'When the ground is already full, rain cannot soak in, and water rises from below.',
    duration: 240, rain: t => (t < 150 ? 3.5 : 0), tide: () => 1.0, gwOffset: 0.8,
    fact: "Most of Volusia County's roughly 50 inches of yearly rain falls in the wet season, June through October. In 2022 Hurricane Ian dropped over a foot of rain on parts of the county, onto ground that was already soaked.",
  },
  {
    id: 'septic', title: 'Level 2: Septic season', septic: true,
    concept: 'A septic tank needs dry soil under it. When the water table rises, sewage comes up instead of soaking in.',
    duration: 240, rain: t => (t < 120 ? 2.5 : 0), tide: () => 1.0, gwOffset: 0.6,
    fact: 'Florida has more than 2 million septic tanks. Many counties, including Volusia, are paying to move neighborhoods from septic to sewer to protect rivers and lagoons from sewage and the algae blooms it feeds.',
  },
];

/** Halifax Shores, the fictional practice town used for the tutorial. */
export function halifaxLevel(): Level {
  const d = buildLevel1();
  const lay = finalize(d);
  return {
    ...d, ...lay, id: 'halifax', name: 'Halifax Shores', county: 'Volusia', real: false,
    tideNormal: 1.0, gw0: 1.4, waterName: 'the Halifax River',
    outfallCell: OUTFALL_ROW * N + 7, outfallDir: [-1, 0],
    suggest: [12 * N + 19, 31 * N + 19, 18 * N + 21],
    roads: [{ w: 3, pts: [[20, -20], [20, N + 20]] }, { w: 3, pts: [[6.6, 23], [36.5, 23]] }],
    bigBuildings: [],
    labels: [
      { text: 'Halifax River', gx: 1, gy: 12, y: 1, min: 50 },
      { text: 'Atlantic Ocean', gx: 47, gy: 32, y: 1, min: 50 },
      { text: 'Seawall', gx: 6, gy: 36, y: 1.2, min: 50, max: 110 },
      { text: 'Outfall pipe', gx: 5, gy: OUTFALL_ROW + 1.6, y: 0.4, min: 50, max: 110 },
      { text: 'Dune', gx: 38.5, gy: 12, y: 2.1, min: 50, max: 110 },
      { text: 'Main St', gx: 20, gy: 8, y: 0.8, min: 50, max: 110 },
      { text: 'Your neighborhood', gx: 24, gy: -3, y: 1.5, min: 90 },
      { text: 'Practice town (fictional)', gx: 24, gy: -40, y: 1, min: 90 },
      { text: 'If nothing drained, water pools here', gx: 20, gy: 30, y: 1.2, min: 0, max: 999, lens: 'watershed' },
    ],
    scenarios: SCENARIOS,
    regionNote: 'Halifax Shores is a made-up practice town modeled on Volusia County\'s barrier island. After the tutorial, the game moves to real Florida places.',
  };
}
