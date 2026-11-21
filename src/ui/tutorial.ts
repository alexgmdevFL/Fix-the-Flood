// Guided first storm. Shown once; skippable.
export interface TutCtx { playing: boolean; time: number; drains: number; finished: boolean; pause: () => void }
interface Step { text: string; next?: string; until?: (c: TutCtx) => boolean; onEnter?: (c: TutCtx) => void }
const KEY = 'hw-tutorial-done';

export class Tutorial {
  private k = -1;
  private ctx: TutCtx | null = null;
  private steps: Step[] = [
    { text: 'Welcome to Halifax Shores, a neighborhood on Volusia County\'s barrier island. The Halifax River is on one side, the Atlantic Ocean on the other.', next: 'Next' },
    { text: 'Your job: keep water out of every house. Money is no object. The challenge is how water behaves.', next: 'Next' },
    { text: 'Press Play and watch where the rain goes.', until: c => c.playing && c.time > 25 },
    {
      text: 'See the street filling up? Water flows downhill, and the street is the lowest ground. Pick Drain, then tap the street where water pools. Place 3 drains.',
      until: c => c.drains >= 3, onEnter: c => c.pause(),
    },
    { text: 'Each drain pipes water to the river. Press Play and let the storm finish.', until: c => c.finished },
  ];

  constructor(private el: HTMLElement) {}

  static done() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
  get active() { return this.k >= 0; }

  start() { this.k = 0; document.body.classList.add('tutorial'); this.render(); }

  end() {
    this.k = -1;
    this.el.classList.add('hidden');
    document.body.classList.remove('tutorial');
    try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }
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
      <div class="row">${s.next ? `<button class="primary" id="tNext">${s.next}</button>` : ''}<button id="tSkip">Skip tutorial</button></div>`;
    const nb = this.el.querySelector<HTMLButtonElement>('#tNext');
    if (nb) nb.onclick = () => this.advance();
    this.el.querySelector<HTMLButtonElement>('#tSkip')!.onclick = () => this.end();
  }

  update(c: TutCtx) {
    this.ctx = c;
    if (this.k < 0) return;
    const s = this.steps[this.k];
    if (s.until && s.until(c)) this.advance();
  }
}
