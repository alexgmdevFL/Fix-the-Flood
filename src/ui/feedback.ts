// Plain-language notes, live and after a storm.
import type { Sim } from '../sim/grid.ts';

export function liveNote(sim: Sim): string {
  // Problems at a specific spot (flooding, backflow, septic, sewer) are pinned on the map instead.
  if (sim.gwOffset > 0 && sim.time < 40) return 'Wet season: the water table is almost at the surface. Low spots and ponds are already filling from below.';
  if (sim.tide > sim.outfallElev && sim.drains.some(d => d.valve && sim.water[d.i] > 0.05) && sim.pumps.length === 0)
    return 'Check valves are holding the river out, but the outfall is underwater, so rain has nowhere to go.';
  if (sim.drains.length === 0 && sim.rain > 0) return 'Rain flows downhill and collects in the low street. Tap the street to see what you can build there.';
  if (sim.houses.some(h => h.depth > 0)) return 'Water is getting into homes. Tap a red pin to see why.';
  return '';
}

export function resultNote(sim: Sim): string {
  const s = sim.stats;
  const parts: string[] = [];
  if (sim.septicOn) {
    if (s.septicFails > 0) parts.push(`${s.septicFails} septic tank${s.septicFails > 1 ? 's' : ''} failed. A drainfield needs dry soil under it, and in the wet season the water table rose too close. Connecting homes to sewer solves this.`);
    if (s.overflow > 0.01) parts.push('The sewer overflowed. Floodwater on the street leaked in through manhole lids and overloaded the lift station. Keeping the street dry keeps the sewer working.');
    if (s.septicFails === 0 && s.overflow <= 0.01) parts.push('No sewage reached yards or streets.');
  }
  if (s.worst <= 0) parts.push('Every floor stayed dry.');
  else if (s.backflow > 1 && !sim.drains.some(d => d.valve))
    parts.push(`Your drains ran backward. At high tide ${sim.waterName} sat above the outfall pipe, so its water came up through the street drains. A check valve stops that.`);
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
  if (sim.pumps.length > 0) parts.push(`Trade-off: every gallon pumped went into ${sim.waterName}, along with whatever was on the street.`);
  return parts.join(' ');
}
