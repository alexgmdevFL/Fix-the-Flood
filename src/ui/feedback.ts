// Plain-language notes, live and after a storm.
import type { Sim } from '../sim/grid.ts';

export function liveNote(sim: Sim): string {
  if (sim.gwOffset > 0 && sim.time < 40) return 'Wet season: the water table is almost at the surface. Low spots and ponds are already filling from below.';
  const backflow = sim.drains.some(d => d.flow < -0.01);
  if (backflow) return `High tide: the bay (${sim.tide.toFixed(1)} ft) is above the outfall pipe (${sim.outfallElev.toFixed(1)} ft). Your drains are running backward.`;
  if (sim.tide > sim.outfallElev && sim.drains.some(d => d.valve && sim.water[d.i] > 0.05) && sim.pumps.length === 0)
    return 'Check valves are holding the bay out, but the outfall is underwater, so rain has nowhere to go.';
  if (sim.houses.some(h => h.depth > 0)) return 'Water is inside homes. Tap a tool, then tap the map to build.';
  if (sim.drains.length === 0 && sim.rain > 0) return 'Rain flows downhill and collects in the low street. Try placing drains where it pools.';
  return '';
}

export function resultNote(sim: Sim): string {
  const s = sim.stats;
  const parts: string[] = [];
  if (s.worst <= 0) parts.push('Every floor stayed dry.');
  else if (s.backflow > 1 && !sim.drains.some(d => d.valve))
    parts.push('Your drains ran backward. At high tide the bay sat above the outfall pipe, so bay water came up through the street drains. A check valve stops that.');
  else if (s.blockedMin > 20 && sim.pumps.length === 0)
    parts.push('Check valves stopped the backflow, but with the outfall underwater the rain had nowhere to go. A pump can lift water over the high tide.');
  else if (sim.gwOffset > 0)
    parts.push('The ground was already full of water, so almost nothing soaked in, and ponds started the storm full. Only moving water out, with drains and pumps, keeps up.');
  else if (sim.drains.length === 0 && sim.pumps.length === 0)
    parts.push('Water flows downhill and pooled in the low street until it reached the houses. It needs a drain with somewhere to go.');
  else parts.push('Your drains were overwhelmed. Put more where water collects, or add a pump.');
  let standing = 0;
  sim.surface.forEach((s, i) => { if (s === 7 && sim.water[i] > 0.25) standing++; });
  if (standing > 0) parts.push('Your ponds still hold standing water. Within a week that is mosquito habitat.');
  if (s.worst > 0 && sim.raisedCells() > 0) parts.push('Raised roads stay drier, but they push water toward the houses beside them.');
  if (sim.pumps.length > 0) parts.push('Trade-off: every gallon pumped went into the bay, along with whatever was on the street.');
  return parts.join(' ');
}
