// Procedural sound with WebAudio: rain hiss, drain gurgle during backflow, pump hum. No audio files.
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private rain!: GainNode;
  private gurgle!: GainNode;
  private hum!: GainNode;
  muted = false;

  constructor() { try { this.muted = localStorage.getItem('hw-muted') === '1'; } catch { /* ignore */ } }

  /** Must be called from a user gesture (browsers block audio until then). */
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    const filter = (type: BiquadFilterType, f: number, q = 1) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = () => { const g = ctx.createGain(); g.gain.value = 0; return g; };

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    const hp = filter('highpass', 900), lp = filter('lowpass', 7000);
    this.rain = gain();
    noise().connect(hp); hp.connect(lp); lp.connect(this.rain); this.rain.connect(this.master);

    const glp = filter('lowpass', 260, 8);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 3.2;
    const lfoG = ctx.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG); lfoG.connect(glp.frequency); lfo.start();
    this.gurgle = gain();
    noise().connect(glp); glp.connect(this.gurgle); this.gurgle.connect(this.master);

    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 58;
    const olp = filter('lowpass', 180);
    this.hum = gain();
    osc.connect(olp); olp.connect(this.hum); this.hum.connect(this.master); osc.start();
  }

  update(rain: number, backflow: number, pumping: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rain.gain.setTargetAtTime(Math.min(1, rain / 4) * 0.25, t, 0.4);
    this.gurgle.gain.setTargetAtTime(Math.min(1, backflow * 2) * 0.5, t, 0.3);
    this.hum.gain.setTargetAtTime(pumping ? 0.06 : 0, t, 0.3);
  }

  /** Rolling thunder a moment after a lightning flash. */
  thunder() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.8 + Math.random() * 1.5;
    const len = 3;
    const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = last * 0.98 + (Math.random() * 2 - 1) * 0.2; d[i] = last; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(lp); lp.connect(g); g.connect(this.master); src.start(t); src.stop(t + len);
  }

  click() {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(330, t + 0.08);
    g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.12);
  }

  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem('hw-muted', this.muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }
}
