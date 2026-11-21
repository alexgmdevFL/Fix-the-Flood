// Terrain padding and the painted ground texture (grass, sand, roads, markings, pads, driveways).
import * as THREE from 'three';
import { S, type Sim } from '../sim/grid.ts';

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

export function paintGround(p: Padded, n: number, extras: Rect[]): THREE.CanvasTexture {
  const SIZE = 2048;
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
      else c = [88, 91, 96];
      g.fillStyle = rgb(c);
      g.fillRect((x - 0.5) * k, (y - 0.5) * k, k + 1, k + 1);
    }
  }
  g.filter = 'blur(6px)';
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
  for (let t = 0; t < 90000; t++) {
    const px = r() * SIZE, py = r() * SIZE, s = cellAt(px, py);
    if (s === S.Grass) g.fillStyle = greens[(r() * 4) | 0];
    else if (s === S.Sand) g.fillStyle = sands[(r() * 3) | 0];
    else continue;
    const sz = 1 + r() * 2.5;
    g.fillRect(px, py, sz, sz * (s === S.Grass ? 2 : 1));
  }

  const Y0 = -PAD - 1, Y1 = n + PAD;
  // Seawall cap and shell-rock alley
  rect(5.5, Y0, 6.5, Y1, '#bdb8ad');
  for (let y = Y0; y < Y1; y += 2) rect(5.5, y, 6.5, y + 0.04, '#97928a');
  rect(27.6, Y0, 28.4, Y1, '#d4cbb5');

  // Streets
  const asphalt = '#505357';
  rect(18.5, Y0, 21.5, Y1, asphalt);
  rect(6.5, 21.5, 36.5, 24.5, asphalt);
  for (let t = 0; t < 14000; t++) {
    const onMain = r() < 0.6;
    const gx = onMain ? 18.5 + r() * 3 : 6.5 + r() * 30, gy = onMain ? Y0 + r() * (Y1 - Y0) : 21.5 + r() * 3;
    g.fillStyle = r() < 0.5 ? 'rgba(30,32,35,0.35)' : 'rgba(140,140,140,0.25)';
    g.fillRect(X(gx), X(gy), 2, 2);
  }
  // Sidewalks and curbs
  const walk = '#cfcbc1', curb = '#e2ded5';
  for (const [a, b] of [[Y0, 21.5], [24.5, Y1]]) {
    rect(18.0, a, 18.5, b, walk); rect(21.5, a, 22.0, b, walk);
    rect(18.44, a, 18.52, b, curb); rect(21.48, a, 21.56, b, curb);
    for (let y = a; y < b; y += 0.5) { rect(18.0, y, 18.44, y + 0.02, '#b3afa6'); rect(21.56, y, 22.0, y + 0.02, '#b3afa6'); }
  }
  for (const [a, b] of [[6.5, 18.5], [21.5, 36.5]]) {
    rect(a, 21.0, b, 21.5, walk); rect(a, 24.5, b, 25.0, walk);
    rect(a, 21.44, b, 21.52, curb); rect(a, 24.48, b, 24.56, curb);
  }
  // Markings
  for (const [a, b] of [[Y0, 21.3], [24.7, Y1]]) {
    rect(19.9, a, 19.96, b, '#e5c04a'); rect(20.04, a, 20.1, b, '#e5c04a');
    rect(18.72, a, 18.76, b, '#e8e8e4'); rect(21.24, a, 21.28, b, '#e8e8e4');
  }
  for (let x = 7; x < 36; x += 1) if (x < 17.5 || x > 22) rect(x, 22.97, x + 0.5, 23.03, '#e8e8e4');
  for (let t = 0; t < 9; t++) {
    const o = 21.7 + t * 0.3;
    rect(17.85, o, 18.45, o + 0.15, '#ecece8'); rect(21.55, o, 22.15, o + 0.15, '#ecece8');
    const q = 18.7 + t * 0.3;
    rect(q, 20.75, q + 0.15, 21.4, '#ecece8'); rect(q, 24.6, q + 0.15, 25.25, '#ecece8');
  }
  // Park paths
  g.strokeStyle = '#d6c7a0'; g.lineWidth = 0.3 * k;
  for (const cy of [10, 35]) { g.beginPath(); g.ellipse(X(9.5), X(cy), 2.6 * k, 4 * k, 0, 0, 6.283); g.stroke(); }

  for (const e of extras) rect(e.x0, e.y0, e.x1, e.y1, e.color);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
