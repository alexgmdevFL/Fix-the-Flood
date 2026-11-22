// A playable map: the sim's data plus what the renderer and UI need.
import type { LevelData } from '../sim/grid.ts';

export interface Scenario {
  id: string;
  title: string;
  concept: string;
  duration: number; // minutes
  rain: (t: number) => number; // in/hr
  tide: (t: number) => number; // ft NAVD88 (or game feet for the practice town)
  gwOffset: number;
  fact: string;
  septic?: boolean;
}

export interface Road { w: number; pts: [number, number][] } // width in cells, points in grid coords
export interface MapLabel { text: string; gx: number; gy: number; y: number; min: number; max?: number; lens?: string }

export interface Level extends LevelData {
  id: string;
  name: string; // shown in the header
  county: string;
  real: boolean;
  roads: Road[];
  bigBuildings: number[][]; // [x0, y0, x1, y1] grid boxes for larger buildings
  facing: number[]; // yaw per house; the model's front is +Z (toward +gy)
  outfallCell: number;
  outfallDir: [number, number]; // grid direction from the outfall cell toward open water
  suggest: number[]; // good first drain spots (tutorial)
  labels: MapLabel[];
  scenarios: Scenario[];
  regionNote: string;
}
