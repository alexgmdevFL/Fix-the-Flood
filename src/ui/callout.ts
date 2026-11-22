// Info card anchored to the tapped spot (follows the camera), and alert pins pinned to where things go wrong.
import type { World } from '../render/world.ts';

export interface Act { label: string; primary?: boolean; run: () => void }
export interface Info {
  title: string; badge: string; k: string; // k = accent color for the badge
  rows: [string, string, string][]; // label, value, tone ('' | 'bad' | 'warn' | 'ok')
  why: string;
  acts: Act[];
  col: { ground: number; water: number; table: number; pool: number; floor?: number };
  lift?: number; // world units above the ground to anchor at (taller for houses)
}
export interface Alert { key: string; cell: number; label: string; k: string; lift?: number }

function soilColumn(d: Info['col'], w = 62, h = 112) {
  const top = Math.max(d.ground + Math.max(d.pool, d.water) + 0.5, (d.floor ?? 0) + 0.3);
  const lo = Math.min(d.table, d.ground) - 0.8;
  const y = (v: number) => (h - ((v - lo) / (top - lo)) * h).toFixed(1);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect width="${w}" height="${h}" rx="8" fill="#dfeaf1"/>`;
  s += `<rect x="0" y="${y(d.ground)}" width="${w}" height="${h}" fill="#a07d55"/>`;
  s += `<rect x="0" y="${y(d.table)}" width="${w}" height="${h}" fill="#3d8fd1" opacity=".6"/>`;
  s += `<rect x="0" y="${y(d.ground)}" width="${w}" height="4" fill="#6e9a4a"/>`;
  if (d.water > 0.005) s += `<rect x="0" y="${y(d.ground + d.water)}" width="${w}" height="${(+y(d.ground) - +y(d.ground + d.water)).toFixed(1)}" fill="#5aa0d6"/>`;
  if (d.pool > 0) s += `<line x1="0" x2="${w}" y1="${y(d.ground + d.pool)}" y2="${y(d.ground + d.pool)}" stroke="#c62828" stroke-width="2" stroke-dasharray="4 3"/>`;
  if (d.floor) s += `<line x1="0" x2="${w}" y1="${y(d.floor)}" y2="${y(d.floor)}" stroke="#1b7a3d" stroke-width="2.5"/>`;
  return s + '</svg>';
}

export class Callout {
  private el: HTMLDivElement;
  cell = -1;
  private acts: Act[] = [];
  private lift = 0.15;
  private t = 0;

  constructor(private world: World, private build: (i: number) => Info | null) {
    this.el = document.createElement('div');
    this.el.id = 'callout';
    this.el.className = 'hidden';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      if (b.dataset.close !== undefined) { this.close(); return; }
      const a = this.acts[Number(b.dataset.a)];
      if (a) { a.run(); this.refresh(); }
    });
  }

  get open() { return this.cell >= 0; }

  show(i: number) {
    this.cell = i;
    this.refresh();
    this.el.classList.remove('hidden', 'pop');
    void this.el.offsetWidth;
    this.el.classList.add('pop');
    document.body.classList.add('has-callout');
  }

  close() { this.cell = -1; this.el.classList.add('hidden'); this.world.showCursor(null); document.body.classList.remove('has-callout'); }

  refresh() {
    if (this.cell < 0) return;
    const info = this.build(this.cell);
    if (!info) { this.close(); return; }
    this.acts = info.acts;
    this.lift = info.lift ?? 0.15;
    this.el.style.setProperty('--k', info.k);
    this.el.innerHTML = `<div class="chead"><span class="ctitle">${info.title}</span><span class="badge">${info.badge}</span></div>
      <div class="cbody">${soilColumn(info.col)}<div class="rows">${info.rows.map(r => `<div class="row"><span>${r[0]}</span><b class="${r[2]}">${r[1]}</b></div>`).join('')}</div></div>
      <div class="why">${info.why}</div>
      <div class="acts">${info.acts.map((a, k) => `<button data-a="${k}" class="${a.primary ? 'primary' : ''}">${a.label}</button>`).join('')}<button data-close>Close</button></div>`;
  }

  update(dt: number) {
    if (this.cell < 0) return;
    if ((this.t += dt) > 0.5) { this.t = 0; this.refresh(); }
    const p = this.world.project(this.cell, this.lift);
    if (!p) { this.el.style.visibility = 'hidden'; return; }
    this.el.style.visibility = 'visible';
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const above = p.y - h - 22 > 64;
    const left = Math.min(Math.max(8, p.x - w / 2), window.innerWidth - w - 8);
    this.el.classList.toggle('above', above);
    this.el.classList.toggle('below', !above);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${above ? p.y - h - 16 : p.y + 16}px`;
    this.el.style.setProperty('--ax', `${Math.min(w - 18, Math.max(18, p.x - left))}px`);
  }
}

export class Pins {
  private els = new Map<string, HTMLDivElement>();
  private list: Alert[] = [];

  constructor(private world: World, private onTap: (cell: number) => void) {}

  set(list: Alert[]) {
    this.list = list;
    const keep = new Set(list.map(a => a.key));
    for (const [k, el] of this.els) if (!keep.has(k)) { el.remove(); this.els.delete(k); }
    for (const a of list) {
      let el = this.els.get(a.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pin';
        el.innerHTML = '<div class="bub"></div><div class="stem"></div><div class="dot"></div>';
        el.addEventListener('click', e => { e.stopPropagation(); this.onTap(a.cell); });
        document.body.appendChild(el);
        this.els.set(a.key, el);
      }
      el.style.setProperty('--k', a.k);
      el.querySelector('.bub')!.textContent = a.label;
    }
  }

  update() {
    for (const a of this.list) {
      const el = this.els.get(a.key)!;
      const p = this.world.project(a.cell, a.lift ?? 0.2);
      if (!p) { el.style.display = 'none'; continue; }
      el.style.display = 'flex';
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
  }
}
