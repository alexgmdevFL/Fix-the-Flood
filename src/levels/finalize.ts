// Works out the per-house and per-map details any level needs from its surface map:
// which way each house faces, its manhole and septic drainfield, the sewer lift station,
// the storm drain outfall, and good first drain spots.
import { S, type LevelData } from '../sim/grid.ts';

export interface Layout { facing: number[]; outfallCell: number; outfallDir: [number, number]; suggest: number[] }

export function finalize(L: LevelData): Layout {
  const { n, surface, open, houses, elev } = L;
  const road = (i: number) => surface[i] === S.Pavement;
  const land = (i: number) => !open[i] && surface[i] !== S.House && surface[i] !== S.Pond && surface[i] !== S.Wall;
  const xy = (i: number) => [i % n, Math.floor(i / n)];
  const nearest = (cx: number, cy: number, ok: (i: number) => boolean, R = 12) => {
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(n - 1, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(n - 1, Math.ceil(cx + R)); x++) {
        const i = y * n + x;
        if (!ok(i)) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    return best;
  };

  const facing: number[] = [];
  for (const h of houses) {
    let cx = 0, cy = 0;
    for (const c of h.cells) { const [x, y] = xy(c); cx += x / h.cells.length; cy += y / h.cells.length; }
    let m = h.manhole >= 0 ? h.manhole : nearest(cx, cy, road);
    if (m < 0) m = nearest(cx, cy, land, n);
    h.manhole = m;
    const [mx, my] = xy(m);
    const dx = mx - cx, dy = my - cy;
    const yaw = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : (dy > 0 ? 0 : Math.PI);
    facing.push(yaw);
    if (h.septic < 0) {
      const bx = cx - Math.sin(yaw) * 2, by = cy - Math.cos(yaw) * 2;
      h.septic = nearest(bx, by, i => land(i) && !road(i), 4);
      if (h.septic < 0) h.septic = nearest(cx, cy, i => land(i) && !road(i), 8);
      if (h.septic < 0) h.septic = h.cells[0];
    }
  }

  if (L.liftCell < 0) {
    let ax = n / 2, ay = n / 2;
    if (houses.length) { ax = 0; ay = 0; for (const h of houses) { const [x, y] = xy(h.manhole); ax += x / houses.length; ay += y / houses.length; } }
    L.liftCell = nearest(ax, ay, i => land(i) && !road(i), n);
    if (L.liftCell < 0) L.liftCell = 0;
  }

  // Outfall: the land cell beside open water closest to the middle of the street network
  let rx = n / 2, ry = n / 2, rc = 0;
  for (let i = 0; i < n * n; i++) if (road(i)) { const [x, y] = xy(i); rx += x; ry += y; rc++; }
  if (rc) { rx = (rx - n / 2) / rc; ry = (ry - n / 2) / rc; }
  let outfallCell = -1, outfallDir: [number, number] = [-1, 0], bd = Infinity;
  for (let i = 0; i < n * n; i++) {
    if (open[i]) continue;
    const [x, y] = xy(i);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= n || Y >= n || !open[Y * n + X]) continue;
      const d = (x - rx) ** 2 + (y - ry) ** 2;
      if (d < bd) { bd = d; outfallCell = i; outfallDir = [dx, dy]; }
    }
  }
  if (outfallCell < 0) outfallCell = 0;

  // First drain spots: the three lowest road cells, spread apart
  const roads: number[] = [];
  for (let i = 0; i < n * n; i++) if (road(i)) roads.push(i);
  roads.sort((a, b) => elev[a] - elev[b]);
  const suggest: number[] = [];
  for (const i of roads) {
    const [x, y] = xy(i);
    if (suggest.every(j => { const [a, b] = xy(j); return Math.hypot(a - x, b - y) >= 8; })) suggest.push(i);
    if (suggest.length === 3) break;
  }
  return { facing, outfallCell, outfallDir, suggest };
}

/** A simple working layout of drains and pumps on the lowest streets (used to check a storm can be won). */
export function autoSolution(L: LevelData, drains: number, pumps: number) {
  const { n, surface, elev } = L;
  const roads: number[] = [];
  for (let i = 0; i < n * n; i++) if (surface[i] === S.Pavement) roads.push(i);
  roads.sort((a, b) => elev[a] - elev[b]);
  const pick = (k: number, gap: number, skip: number[] = []) => {
    const out: number[] = [];
    for (const i of roads) {
      if (skip.includes(i)) continue;
      const x = i % n, y = Math.floor(i / n);
      if (out.every(j => Math.hypot((j % n) - x, Math.floor(j / n) - y) >= gap)) out.push(i);
      if (out.length === k) break;
    }
    return out;
  };
  const d = pick(drains, 4);
  return { drains: d, pumps: pick(pumps, 6, d) };
}
