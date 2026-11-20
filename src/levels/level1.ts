// Level 1: "One Street, One Storm". Fictional barrier-island block. Bay to the west, ocean to the east.
import { S, type LevelData, type House } from '../sim/grid.ts';

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
      houses.push({ cells, floor: mx + 0.4, ground: mn, depth: 0, maxDepth: 0 });
    }
  }
  return { n: N, elev, surface, open, houses, outfallElev: 1.2 };
}

export interface Scenario {
  id: string;
  title: string;
  concept: string;
  duration: number; // minutes
  rain: (t: number) => number; // in/hr
  tide: (t: number) => number; // ft
  gwOffset: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'storm1', title: 'Storm 1: Heavy rain',
    concept: 'Water flows downhill. Drains need somewhere to go.',
    duration: 240, rain: t => (t < 150 ? 4 : 0), tide: () => 1.0, gwOffset: 0,
  },
  {
    id: 'storm2', title: 'Storm 2: Rain plus king tide',
    concept: 'When the bay is higher than the outfall, drains run backward.',
    duration: 300, rain: t => (t >= 60 && t < 200 ? 3 : 0),
    tide: t => 1.0 + 1.9 * Math.max(0, Math.sin(Math.PI * t / 300)), gwOffset: 0,
  },
];
