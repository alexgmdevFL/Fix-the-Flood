// Watershed analysis by priority flood from the open water.
// fill: how deep water would pool in a cell if nothing drained (the "bathtub" behind the seawall).
// basin: 1 = drains to the bay, 2 = drains to the ocean.
import type { Sim } from './grid.ts';

export interface Watershed { fill: Float32Array; basin: Uint8Array }

export function computeWatershed(sim: Sim): Watershed {
  const n = sim.n, N = n * n, elev = sim.elev;
  const filled = new Float32Array(N);
  const done = new Uint8Array(N);
  const basin = new Uint8Array(N);
  const heap: number[] = [];
  const push = (i: number) => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (filled[heap[p]] <= filled[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && filled[heap[l]] < filled[heap[m]]) m = l;
        if (r < heap.length && filled[heap[r]] < filled[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < N; i++) {
    if (!sim.open[i]) continue;
    filled[i] = elev[i]; basin[i] = (i % n) < n / 2 ? 1 : 2; done[i] = 1; push(i);
  }
  while (heap.length) {
    const c = pop(), x = c % n, y = (c / n) | 0;
    const nb = [x > 0 ? c - 1 : -1, x < n - 1 ? c + 1 : -1, y > 0 ? c - n : -1, y < n - 1 ? c + n : -1];
    for (const j of nb) {
      if (j < 0 || done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(elev[j], filled[c] + 1e-5);
      basin[j] = basin[c];
      push(j);
    }
  }
  const fill = new Float32Array(N);
  for (let i = 0; i < N; i++) { const d = filled[i] - elev[i]; fill[i] = d > 0.01 ? d : 0; }
  return { fill, basin };
}
