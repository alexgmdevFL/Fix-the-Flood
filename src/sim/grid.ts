// Grid-based shallow-water sim. Units: feet and minutes. No rendering code here.

export const S = { Water: 0, Sand: 1, Grass: 2, Pavement: 3, House: 4, Wall: 5 } as const;
export const SURFACE_NAMES = ['Open water', 'Sand', 'Grass', 'Pavement', 'House', 'Seawall'];

// Infiltration rate by surface, inches per hour
export const INFIL_IN_HR = [0, 3, 1, 0.05, 0, 0];
export const POROSITY = 0.3;
export const DRAIN_CAP = 0.4; // ft of depth per minute one inlet can pass
export const DRAIN_K = 2.0;
export const PUMP_CAP = 1.0; // ft per minute
const C = 0.1; // virtual pipe conductance per tick
const FRICTION = 0.985;

export interface Drain { i: number; valve: boolean; flow: number } // flow < 0 means backflow
export interface Pump { i: number; flow: number }
export interface House { cells: number[]; floor: number; ground: number; depth: number; maxDepth: number }

export interface LevelData {
  n: number;
  elev: Float32Array;
  surface: Uint8Array;
  open: Uint8Array; // 1 = bay or ocean cell, level held at tide
  houses: House[];
  outfallElev: number;
}

export interface Stats { backflow: number; drained: number; pumped: number; blockedMin: number; worst: number }

export class Sim {
  n: number;
  elev: Float32Array;
  surface: Uint8Array;
  open: Uint8Array;
  water: Float32Array;
  gw: Float32Array;
  fR: Float32Array; fL: Float32Array; fU: Float32Array; fD: Float32Array;
  houses: House[];
  drains: Drain[] = [];
  pumps: Pump[] = [];
  outfallElev: number;
  rain = 0; // in/hr
  tide = 1; // ft
  gwOffset = 0; // wet season raises this
  time = 0; // minutes
  stats: Stats = { backflow: 0, drained: 0, pumped: 0, blockedMin: 0, worst: 0 };

  constructor(l: LevelData) {
    this.n = l.n;
    this.elev = l.elev;
    this.surface = l.surface;
    this.open = l.open;
    this.houses = l.houses;
    this.outfallElev = l.outfallElev;
    const N = l.n * l.n;
    this.water = new Float32Array(N);
    this.gw = new Float32Array(N);
    this.fR = new Float32Array(N); this.fL = new Float32Array(N);
    this.fU = new Float32Array(N); this.fD = new Float32Array(N);
    this.reset();
  }

  gwBase() { return 0.9 + 0.5 * this.tide + this.gwOffset; }

  reset() {
    this.water.fill(0);
    this.fR.fill(0); this.fL.fill(0); this.fU.fill(0); this.fD.fill(0);
    const b = this.gwBase();
    for (let i = 0; i < this.gw.length; i++) this.gw[i] = Math.min(this.elev[i] - 0.05, b);
    for (let i = 0; i < this.water.length; i++) if (this.open[i]) this.water[i] = Math.max(0, this.tide - this.elev[i]);
    this.time = 0;
    this.stats = { backflow: 0, drained: 0, pumped: 0, blockedMin: 0, worst: 0 };
    for (const h of this.houses) { h.depth = 0; h.maxDepth = 0; }
    for (const d of this.drains) d.flow = 0;
    for (const p of this.pumps) p.flow = 0;
  }

  drainAt(i: number) { return this.drains.find(d => d.i === i); }
  pumpAt(i: number) { return this.pumps.find(p => p.i === i); }

  step(dt = 0.25) {
    const { n, elev, water, open, surface, gw, fR, fL, fU, fD } = this;
    const N = n * n;
    const rainFt = this.rain / 12 / 60 * dt;
    const base = this.gwBase();

    // Boundaries, rain, infiltration, groundwater
    for (let i = 0; i < N; i++) {
      if (open[i]) { water[i] = Math.max(0, this.tide - elev[i]); continue; }
      water[i] += rainFt;
      const rate = INFIL_IN_HR[surface[i]] / 12 / 60 * dt;
      if (rate > 0 && water[i] > 0) {
        const room = Math.max(0, (elev[i] - gw[i]) * POROSITY);
        const inf = Math.min(rate, water[i], room);
        water[i] -= inf;
        gw[i] += inf / POROSITY;
      }
      gw[i] += (base - gw[i]) * 0.002 * dt;
      if (gw[i] > elev[i]) { water[i] += (gw[i] - elev[i]) * POROSITY; gw[i] = elev[i]; }
    }

    // Virtual pipes: outflow to lower neighbors proportional to head difference
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const h = elev[i] + water[i];
        let r = x < n - 1 ? Math.max(0, fR[i] * FRICTION + C * (h - elev[i + 1] - water[i + 1])) : 0;
        let l = x > 0 ? Math.max(0, fL[i] * FRICTION + C * (h - elev[i - 1] - water[i - 1])) : 0;
        let d = y < n - 1 ? Math.max(0, fD[i] * FRICTION + C * (h - elev[i + n] - water[i + n])) : 0;
        let u = y > 0 ? Math.max(0, fU[i] * FRICTION + C * (h - elev[i - n] - water[i - n])) : 0;
        const out = r + l + d + u;
        if (out > water[i] && out > 0) { const k = water[i] / out; r *= k; l *= k; d *= k; u *= k; }
        fR[i] = r; fL[i] = l; fD[i] = d; fU[i] = u;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        let w = water[i] - fR[i] - fL[i] - fD[i] - fU[i];
        if (x > 0) w += fR[i - 1];
        if (x < n - 1) w += fL[i + 1];
        if (y > 0) w += fD[i - n];
        if (y < n - 1) w += fU[i + n];
        water[i] = Math.max(0, w);
      }
    }

    // Drains: pipe to the bay outfall. The outlet level is the outfall or the tide, whichever is higher.
    const outlet = Math.max(this.outfallElev, this.tide);
    for (const dr of this.drains) {
      const h = elev[dr.i] + water[dr.i];
      let q = DRAIN_K * (h - outlet) * dt;
      q = Math.max(-DRAIN_CAP * dt, Math.min(DRAIN_CAP * dt, q));
      if (q < 0 && dr.valve) {
        if (water[dr.i] > 0.02) this.stats.blockedMin += dt;
        q = 0;
      }
      if (q > 0) q = Math.min(q, water[dr.i]);
      water[dr.i] -= q;
      dr.flow = q / dt;
      if (q < 0) this.stats.backflow -= q; else this.stats.drained += q;
    }

    // Pumps lift water over the tide into the bay
    for (const p of this.pumps) {
      const q = Math.min(PUMP_CAP * dt, water[p.i]);
      water[p.i] -= q;
      p.flow = q / dt;
      this.stats.pumped += q;
    }

    // Houses: depth of water above the floor
    for (const hs of this.houses) {
      let lvl = -99;
      for (const c of hs.cells) if (water[c] > 0.002) lvl = Math.max(lvl, elev[c] + water[c]);
      hs.depth = Math.max(0, lvl - hs.floor);
      if (hs.depth > hs.maxDepth) hs.maxDepth = hs.depth;
      if (hs.depth > this.stats.worst) this.stats.worst = hs.depth;
    }

    this.time += dt;
  }
}
