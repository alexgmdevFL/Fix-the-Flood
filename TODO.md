# TODO / Priorities

## Now (Milestone 1 polish)
- Test on a mid-range Android phone. Target 30 fps. Drop shadow map to 1024 if needed.
- Tune foam: speckle at thin water edges is noisy.
- Flow-map animation in the water shader (advect ripples along sim flux).
- Move sim into a Web Worker.
- Unit tests for sim (headless run already works with `node --experimental-strip-types`).
- PNG icons (192, 512) for older Android installs.

## Next (Milestone 2: Level 1 full)
- Storm 3: wet season (raise `gwOffset`, ponds that do not drain).
- Tools: swale, retention pond, raise road.
- Replay with flow arrows after each storm.
- Seawall-pushes-water-to-neighbors and pond-mosquito consequences.

## On Ice
- Supabase (progress, accounts, shared scenarios). Not until a feature needs it.
- Godot port. Only if phone performance fails.
- Blender glTF assets (houses, palms are procedural placeholders for now).

<details>
<summary>Recently Done</summary>

- Vite + TypeScript + Three.js PWA scaffold, Netlify config.
- Virtual-pipes water sim with rain, infiltration, groundwater, tide boundary.
- Drains with tide-dependent outfall (backflow), check valves, pumps.
- Storm 1 and Storm 2 scenarios, grading by worst house depth, plain-language failure notes.
- Water depth shader, rain, backflow and outfall particles, elevation lens.

</details>
