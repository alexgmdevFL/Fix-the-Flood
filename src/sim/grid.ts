// Grid-based shallow-water sim. Units: feet and minutes. No rendering code here.

export const S = { Water: 0, Sand: 1, Grass: 2, Pavement: 3, House: 4, Wall: 5, Swale: 6, Pond: 7 } as const;
export const SURFACE_NAMES = ['Open water', 'Sand', 'Grass', 'Pavement', 'House', 'Seawall', 'Swale', 'Retention pond'];
export type Earthwork = 'swale' | 'pond' | 'raise' | 'wall' | 'restore';

// Infiltration rate by surface, inches per hour
export const INFIL_IN_HR = [0, 3, 1, 0.05, 0, 0, 2.5, 1.5];
export const POROSITY = 0.3;
export const DRAIN_CAP = 0.6; // ft of depth per minute one inlet can pass
export const DRAIN_K = 2.0;
export const PUMP_CAP = 1.0; // ft per minute
const C = 0.1; // virtual pipe conductance per tick
const FRICTION = 0.985;

export interface Drain { i: number; valve: boolean; flow: number; to?: number } // flow < 0 means backflow; to = pond cell it pipes into, or -1 for the river outfall
export const POND_REACH = 12; // a drain pipes into a pond within this many tiles
const POND_OUT = 0.08; // ft per minute each pond cell can release through its outlet
export interface Pump { i: number; flow: number }
export interface House {
  cells: number[]; floor: number; ground: number; depth: number; maxDepth: number;
  septic: number; // drainfield cell in the back yard
  manhole: number; // street cell where its sewer lateral meets the main
  sewer: boolean; // connected to central sewer (septic retired)
  septicFail: boolean;
}
export const SEPTIC_SEP = 0.75; // ft of dry soil a drainfield needs above the water table
export const LIFT_CAP = 0.12; // lift station capacity, ft*cell per minute
export const GAL_PER_CELL_FT = 6700; // one tile is about 30 x 30 ft

export interface LevelData {
  n: number;
  elev: Float32Array;
  surface: Uint8Array;
  open: Uint8Array; // 1 = bay or ocean cell, level held at tide
  houses: House[];
  outfallElev: number;
  liftCell: number;
  tideNormal?: number; // usual high tide (ft); the water table is set relative to it
  gw0?: number; // water table at usual high tide (ft)
  waterName?: string; // the water body the outfall drains to
}

export interface Stats { backflow: number; drained: number; pumped: number; blockedMin: number; worst: number; emerged: number; sewage: number; overflow: number; septicFails: number }

export class Sim {
  n: number;
  elev: Float32Array;
  surface: Uint8Array;
  elev0: Float32Array; // original terrain, for undoing earthworks
  surface0: Uint8Array;
  open: Uint8Array;
  water: Float32Array;
  conc: Float32Array; // sewage fraction of the water in each cell, 0..1
  private concN: Float32Array;
  gw: Float32Array;
  fR: Float32Array; fL: Float32Array; fU: Float32Array; fD: Float32Array;
  houses: House[];
  drains: Drain[] = [];
  pumps: Pump[] = [];
  outfallElev: number;
  liftCell: number;
  septicOn = false; // Level 2: houses on septic tanks
  tideNormal: number;
  gw0: number;
  waterName: string;
  liftLoad = 0; // current sewer flow into the lift station, ft*cell per minute
  rain = 0; // in/hr
  tide = 1; // ft
  gwOffset = 0; // wet season raises this
  time = 0; // minutes
  stats: Stats = { backflow: 0, drained: 0, pumped: 0, blockedMin: 0, worst: 0, emerged: 0, sewage: 0, overflow: 0, septicFails: 0 };

  constructor(l: LevelData) {
    this.n = l.n;
    this.elev = l.elev;
    this.surface = l.surface;
    this.elev0 = l.elev.slice();
    this.surface0 = l.surface.slice();
    this.open = l.open;
    this.houses = l.houses;
    this.outfallElev = l.outfallElev;
    this.liftCell = l.liftCell;
    this.tideNormal = l.tideNormal ?? 1.0;
    this.gw0 = l.gw0 ?? 1.4;
    this.waterName = l.waterName ?? 'the river';
    const N = l.n * l.n;
    this.water = new Float32Array(N);
    this.conc = new Float32Array(N);
    this.concN = new Float32Array(N);
    this.gw = new Float32Array(N);
    this.fR = new Float32Array(N); this.fL = new Float32Array(N);
    this.fU = new Float32Array(N); this.fD = new Float32Array(N);
    this.reset();
  }

  gwBase() { return this.gw0 + 0.5 * (this.tide - this.tideNormal) + this.gwOffset; }

  reset() {
    this.water.fill(0);
    this.conc.fill(0);
    this.liftLoad = 0;
    this.fR.fill(0); this.fL.fill(0); this.fU.fill(0); this.fD.fill(0);
    const b = this.gwBase();
    for (let i = 0; i < this.gw.length; i++) {
      if (this.open[i]) { this.water[i] = Math.max(0, this.tide - this.elev[i]); this.gw[i] = this.elev[i]; continue; }
      // Where the water table sits above the ground, it starts out as standing water
      if (b >= this.elev[i]) { this.gw[i] = this.elev[i]; this.water[i] = b - this.elev[i]; } else this.gw[i] = b;
    }
    this.time = 0;
    this.stats = { backflow: 0, drained: 0, pumped: 0, blockedMin: 0, worst: 0, emerged: 0, sewage: 0, overflow: 0, septicFails: 0 };
    for (const h of this.houses) { h.depth = 0; h.maxDepth = 0; h.septicFail = false; }
    for (const d of this.drains) d.flow = 0;
    for (const p of this.pumps) p.flow = 0;
  }

  private addSewage(i: number, v: number) {
    const m = this.water[i] * this.conc[i] + v;
    this.water[i] += v;
    this.conc[i] = Math.min(1, m / this.water[i]);
    this.stats.sewage += v;
  }

  /** Septic drainfields fail when the soil under them is wet; sewers overflow when floodwater gets in. */
  private sewage(dt: number) {
    const { water, gw, elev } = this;
    let load = 0;
    for (const h of this.houses) {
      if (h.sewer) {
        h.septicFail = false;
        load += 0.003 * dt;
        const m = h.manhole;
        if (water[m] > 0.1) { const q = Math.min(water[m] - 0.1, 0.006 * dt); water[m] -= q; load += q; } // inflow through the lid
        continue;
      }
      const c = h.septic;
      const fail = water[c] > 0.05 || gw[c] > elev[c] - SEPTIC_SEP;
      if (fail && !h.septicFail) this.stats.septicFails++;
      h.septicFail = fail;
      if (fail) this.addSewage(c, 0.002 * dt);
    }
    this.liftLoad = load / dt;
    const cap = LIFT_CAP * dt;
    if (load > cap) { this.addSewage(this.liftCell, load - cap); this.stats.overflow += load - cap; }
  }

  /** Connect a house and its neighbors on the block (within 7 tiles) to the sewer. Returns how many changed. */
  connectSewer(house: number) {
    const n = this.n, c0 = this.houses[house].cells[0];
    const x0 = c0 % n, y0 = Math.floor(c0 / n);
    let k = 0;
    for (const h of this.houses) {
      const c = h.cells[0];
      if (h.sewer || Math.max(Math.abs((c % n) - x0), Math.abs(Math.floor(c / n) - y0)) > 7) continue;
      h.sewer = true; h.septicFail = false; k++;
    }
    return k;
  }

  houseAt(i: number) { return this.houses.findIndex(h => h.cells.includes(i)); }

  /** Reshape a cell. Returns '' when done, otherwise a reason it was refused. */
  modify(i: number, kind: Earthwork): string {
    const s0 = this.surface0[i];
    if (this.open[i] || s0 === S.House || s0 === S.Wall) return "Can't build there.";
    if (kind === 'restore') {
      if (this.elev[i] === this.elev0[i] && this.surface[i] === s0) return 'Nothing to remove here.';
      this.elev[i] = this.elev0[i]; this.surface[i] = s0;
      return '';
    }
    if (kind === 'raise') {
      if (s0 !== S.Pavement) return 'Raise road only works on pavement.';
      if (this.elev[i] >= this.elev0[i] + 0.99) return 'Already raised the full 1 ft.';
      this.elev[i] += 0.5;
      return '';
    }
    if (s0 !== S.Grass && s0 !== S.Sand) return 'Swales, ponds and walls go on open ground, not pavement.';
    if (kind === 'wall') { this.elev[i] = this.elev0[i] + 1.0; this.surface[i] = S.Wall; return ''; }
    this.elev[i] = this.elev0[i] - (kind === 'swale' ? 0.4 : 1.2);
    this.surface[i] = kind === 'swale' ? S.Swale : S.Pond;
    return '';
  }

  /** Each drain pipes into the nearest pond within reach, otherwise to the river outfall. */
  connectDrains() {
    const ponds: number[] = [];
    for (let i = 0; i < this.surface.length; i++) if (this.surface[i] === S.Pond) ponds.push(i);
    for (const d of this.drains) {
      let best = -1, bd = POND_REACH;
      const x = d.i % this.n, y = Math.floor(d.i / this.n);
      for (const p of ponds) {
        const dist = Math.hypot((p % this.n) - x, Math.floor(p / this.n) - y);
        if (dist < bd) { bd = dist; best = p; }
      }
      d.to = best;
    }
    return ponds;
  }

  raisedCells() { let c = 0; for (let i = 0; i < this.elev.length; i++) if (this.elev[i] > this.elev0[i] + 0.01) c++; return c; }

  /** Net outflow direction per cell, for flow arrows. */
  computeFlow(vx: Float32Array, vy: Float32Array) {
    for (let i = 0; i < vx.length; i++) { vx[i] = this.fR[i] - this.fL[i]; vy[i] = this.fD[i] - this.fU[i]; }
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
      if (gw[i] > elev[i]) { const e = (gw[i] - elev[i]) * POROSITY; water[i] += e; this.stats.emerged += e; gw[i] = elev[i]; }
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
    // Move water, and carry sewage with it (mass = water * concentration)
    const conc = this.conc, cN = this.concN;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const out = fR[i] + fL[i] + fD[i] + fU[i];
        let w = water[i] - out;
        let mass = (water[i] - out) * conc[i];
        if (x > 0) { w += fR[i - 1]; mass += fR[i - 1] * conc[i - 1]; }
        if (x < n - 1) { w += fL[i + 1]; mass += fL[i + 1] * conc[i + 1]; }
        if (y > 0) { w += fD[i - n]; mass += fD[i - n] * conc[i - n]; }
        if (y < n - 1) { w += fU[i + n]; mass += fU[i + n] * conc[i + n]; }
        water[i] = Math.max(0, w);
        cN[i] = water[i] > 1e-5 && !open[i] ? Math.min(1, Math.max(0, mass / water[i])) : 0;
      }
    }
    this.conc = cN; this.concN = conc;

    // Drains: pipe to the bay outfall. The outlet level is the outfall or the tide, whichever is higher.
    const outlet = Math.max(this.outfallElev, this.tide);
    const ponds = this.connectDrains();
    for (const dr of this.drains) {
      const h = elev[dr.i] + water[dr.i];
      const to = dr.to ?? -1;
      const out = to >= 0 ? elev[to] + water[to] : outlet;
      let q = DRAIN_K * (h - out) * dt;
      q = Math.max(-DRAIN_CAP * dt, Math.min(DRAIN_CAP * dt, q));
      if (q < 0 && dr.valve) {
        if (water[dr.i] > 0.02) this.stats.blockedMin += dt;
        q = 0;
      }
      if (q > 0) q = Math.min(q, water[dr.i]);
      if (q < 0 && to >= 0) q = Math.max(q, -water[to]);
      water[dr.i] -= q;
      if (to >= 0) water[to] += q;
      dr.flow = q / dt;
      if (q < 0) this.stats.backflow -= q; else this.stats.drained += q;
    }
    // Ponds release slowly to the river through a flap-gated outlet, only when above the outfall and the tide
    for (const p of ponds) {
      const q = Math.min(POND_OUT * dt, Math.max(0, elev[p] + water[p] - outlet) * 0.5 * dt, water[p]);
      water[p] -= q;
    }

    // Pumps lift water over the tide into the bay
    for (const p of this.pumps) {
      const q = Math.min(PUMP_CAP * dt, water[p.i]);
      water[p.i] -= q;
      p.flow = q / dt;
      this.stats.pumped += q;
    }

    if (this.septicOn) this.sewage(dt);

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
