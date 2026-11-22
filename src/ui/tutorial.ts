// Guided first storm. Shown once; skippable. Points at the exact button or spot to tap.
export interface TutCtx {
  playing: boolean; time: number; drains: number; finished: boolean; tool: string;
  pause: () => void; hint: (cells: number[]) => void; selectTool: (t: string) => void;
}
interface Step { text: string; next?: string; target?: string; until?: (c: TutCtx) => boolean; onEnter?: (c: TutCtx) => void }
const KEY = 'hw-tutorial-done';

export class Tutorial {
  private k = -1;
  private ctx: TutCtx | null = null;
  private arrow: HTMLDivElement;
  private marked: Element | null = null;
  private steps: Step[] = [
    { text: 'Welcome to Halifax Shores, a practice town on a Florida barrier island. After this, the game takes you to real places across Florida, built from real elevation, tide and rainfall data.', next: 'Next' },
    { text: 'Your job: keep water out of every house. Money is no object. The challenge is how water behaves.', next: 'Next' },
    { text: 'Tap Play to start the rain, then watch where it goes.', target: '#play', until: c => c.playing && c.time > 25 },
    { text: 'The street is filling up. Water flows downhill, and the street is the lowest ground. Tap the Drain tool.', target: '[data-tool=drain]', until: c => c.tool === 'drain', onEnter: c => { c.pause(); c.selectTool('inspect'); } },
    { text: 'Now tap the glowing rings on the street to place 3 drains.', until: c => c.drains >= 3, onEnter: c => c.hint(this.spots) },
    { text: 'Each drain pipes water to the river. Tap Play and let the storm finish.', target: '#play', until: c => c.finished, onEnter: c => c.hint([]) },
  ];

  constructor(private el: HTMLElement, private spots: number[]) {
    this.arrow = document.createElement('div');
    this.arrow.id = 'tutArrow';
    this.arrow.textContent = 'Tap here ▼';
    this.arrow.classList.add('hidden');
    document.body.appendChild(this.arrow);
  }

  static done() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
  get active() { return this.k >= 0; }

  start() { this.k = 0; document.body.classList.add('tutorial'); this.render(); }

  end() {
    this.k = -1;
    this.el.classList.add('hidden');
    this.arrow.classList.add('hidden');
    this.mark(null);
    this.ctx?.hint([]);
    document.body.classList.remove('tutorial');
    try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }
  }

  private mark(el: Element | null) {
    if (this.marked === el) return;
    this.marked?.classList.remove('tut-target');
    el?.classList.add('tut-target');
    this.marked = el;
  }

  private advance() {
    this.k++;
    if (this.k >= this.steps.length) { this.end(); return; }
    const s = this.steps[this.k];
    if (s.onEnter && this.ctx) s.onEnter(this.ctx);
    this.render();
  }

  private render() {
    const s = this.steps[this.k];
    this.el.classList.remove('hidden');
    this.el.innerHTML = `<div class="tstep">Step ${this.k + 1} of ${this.steps.length}</div><p>${s.text}</p>
      <div class="row">${s.next ? `<button class="primary tut-target" id="tNext">${s.next}</button>` : ''}<button id="tSkip">Skip tutorial</button></div>`;
    const nb = this.el.querySelector<HTMLButtonElement>('#tNext');
    if (nb) nb.onclick = () => this.advance();
    this.el.querySelector<HTMLButtonElement>('#tSkip')!.onclick = () => this.end();
  }

  update(c: TutCtx) {
    this.ctx = c;
    if (this.k < 0) return;
    const s = this.steps[this.k];
    // Point at the target, except Play while it is already running
    const el = s.target ? document.querySelector(s.target) : null;
    const show = el && !(s.target === '#play' && c.playing);
    this.mark(show ? el : null);
    if (show) {
      const r = el.getBoundingClientRect();
      this.arrow.classList.remove('hidden');
      this.arrow.style.left = `${r.left + r.width / 2}px`;
      this.arrow.style.top = `${r.top - 10}px`;
    } else this.arrow.classList.add('hidden');
    if (s.until && s.until(c)) this.advance();
  }
}
