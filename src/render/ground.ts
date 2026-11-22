// Terrain padding and the painted ground texture (grass, sand, roads, markings, pads, driveways).
import * as THREE from 'three';
import { S, type Sim } from '../sim/grid.ts';
import type { Road } from '../levels/types.ts';

export const PAD = 16; // extra cells of scenery around the sim grid
export interface Padded { m: number; elev: Float32Array; surf: Uint8Array }
export interface Rect { x0: number; y0: number; x1: number; y1: number; color: string }

export function padTerrain(sim: Sim): Padded {
  const n = sim.n, m = n + 2 * PAD;
  const elev = new Float32Array(m * m), surf = new Uint8Array(m * m);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const gx = x - PAD, gy = y - PAD;
      const cx = Math.min(n - 1, Math.max(0, gx)), cy = Math.min(n - 1, Math.max(0, gy));
      let e = sim.elev[cy * n + cx];
      let s: number = sim.surface[cy * n + cx];
      if (s === S.House) s = S.Grass;
      if (gx < 0) e -= 0.3 * -gx;
      if (gx >= n) e -= 0.3 * (gx - n + 1);
      if ((gy < 0 || gy >= n) && s === S.Grass) e += 0.12 * Math.sin(x * 0.7) * Math.cos(y * 0.6);
      elev[y * m + x] = Math.max(-7, e);
      surf[y * m + x] = s;
    }
  }
  return { m, elev, surf };
}

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function paintGround(p: Padded, n: number, extras: Rect[], SIZE = 2048, roads: Road[] = [], big: { pts: [number, number][] }[] = []): THREE.CanvasTexture {
  const { m, elev, surf } = p;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d')!;
  const k = SIZE / (m - 1);
  const r = rng(11);
  const X = (gx: number) => (gx + PAD) * k; // grid coord to pixel
  const rect = (x0: number, y0: number, x1: number, y1: number, col: string) => { g.fillStyle = col; g.fillRect(X(x0), X(y0), (x1 - x0) * k, (y1 - y0) * k); };
  const rgb = (a: number[]) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

  // Base colors per cell
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const i = y * m + x, e = elev[i], s = surf[i];
      const j = 0.94 + r() * 0.1;
      let c: number[];
      if (s === S.Water) c = lerp([196, 182, 140], [28, 78, 92], Math.min(1, Math.max(0, (0.5 - e) / 4)));
      else if (s === S.Sand) c = e < 1.7 ? [200, 184, 142] : [230, 216, 172];
      else if (s === S.Grass) c = [104 * j, 146 * j, 70 * j];
      else if (s === S.Wall) c = [180, 176, 166];
      else c = [104 * j, 146 * j, 70 * j]; // streets are drawn from their real paths below, so the tile itself stays lawn
      g.fillStyle = rgb(c);
      g.fillRect((x - 0.5) * k, (y - 0.5) * k, k + 1, k + 1);
    }
  }
  g.filter = `blur(${SIZE / 340}px)`;
  g.drawImage(cv, 0, 0);
  g.filter = 'none';

  const cellAt = (px: number, py: number) => surf[Math.min(m - 1, Math.round(py / k)) * m + Math.min(m - 1, Math.round(px / k))];
  // Soft mottling, then fine speckle
  for (let t = 0; t < 700; t++) {
    const px = r() * SIZE, py = r() * SIZE, s = cellAt(px, py);
    if (s !== S.Grass && s !== S.Sand) continue;
    g.fillStyle = s === S.Grass ? (r() < 0.5 ? 'rgba(60,95,40,0.10)' : 'rgba(170,180,90,0.08)') : 'rgba(150,130,90,0.07)';
    g.beginPath(); g.arc(px, py, 15 + r() * 45, 0, 6.283); g.fill();
  }
  const greens = ['rgba(70,110,45,0.5)', 'rgba(130,170,85,0.45)', 'rgba(95,135,55,0.5)', 'rgba(160,165,90,0.35)'];
  const sands = ['rgba(200,185,145,0.5)', 'rgba(245,235,205,0.5)', 'rgba(170,155,120,0.35)'];
  for (let t = 0; t < (SIZE * SIZE) / 46; t++) {
    const px = r() * SIZE, py = r() * SIZE, s = cellAt(px, py);
    if (s === S.Grass) g.fillStyle = greens[(r() * 4) | 0];
    else if (s === S.Sand) g.fillStyle = sands[(r() * 3) | 0];
    else continue;
    const sz = 1 + r() * 2.5;
    g.fillRect(px, py, sz, sz * (s === S.Grass ? 2 : 1));
  }

  // Roads from their real paths: sidewalk, curb shadow, asphalt, then a center line on bigger roads
  g.lineCap = 'round'; g.lineJoin = 'round';
  const stroke = (pts: [number, number][], width: number, color: string, dash?: number[]) => {
    g.strokeStyle = color; g.lineWidth = width * k;
    g.setLineDash(dash ? dash.map(d => d * k) : []);
    g.beginPath();
    pts.forEach(([x, y], j) => { if (j) g.lineTo(X(x), X(y)); else g.moveTo(X(x), X(y)); });
    g.stroke();
  };
  for (const r of roads) if (r.w >= 1.4) stroke(r.pts, r.w + 0.9, '#cfcbc1');
  for (const r of roads) stroke(r.pts, r.w + 0.14, '#3d4044');
  for (const r of roads) stroke(r.pts, r.w, r.w >= 1.4 ? '#505357' : '#66696d');
  for (let t = 0; t < 16000; t++) {
    const px = r() * SIZE, py = r() * SIZE;
    if (cellAt(px, py) !== S.Pavement) continue;
    g.fillStyle = r() < 0.5 ? 'rgba(30,32,35,0.3)' : 'rgba(150,150,150,0.2)';
    g.fillRect(px, py, SIZE / 1024, SIZE / 1024);
  }
  for (const r of roads) if (r.w >= 2.3) { stroke(r.pts, 0.06, '#e5c04a'); } else if (r.w >= 2) stroke(r.pts, 0.06, '#e8e8e4', [0.5, 0.5]);
  g.setLineDash([]);
  // Larger buildings (shops, condos) as flat roofs
  // Concrete pads under larger buildings (the buildings themselves are 3D)
  g.fillStyle = '#c4c0b8';
  for (const b of big) { g.beginPath(); b.pts.forEach(([x, y], j) => { if (j) g.lineTo(X(x), X(y)); else g.moveTo(X(x), X(y)); }); g.closePath(); g.fill(); }

  for (const e of extras) rect(e.x0, e.y0, e.x1, e.y1, e.color);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
