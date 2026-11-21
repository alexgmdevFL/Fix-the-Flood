# TODO / Priorities

## Now (Milestone 1 polish)
- Test on a real mid-range Android phone. Auto quality is in place (`?q=low` / `?q=high` to force).
- Flow-map animation in the water shader (advect ripples along sim flux).
- Move sim into a Web Worker.
- Unit tests for sim (headless run already works with `node --experimental-strip-types`).
- PNG icons (192, 512) for older Android installs.

## Next
- Milestone 4: second system (sewage or power) and its interactions with water.
- Real Volusia terrain (LiDAR) and NOAA tide data for a later level.
- Water: double the sim resolution (96x96) for smoother puddles and shorelines.

## On Ice
- Supabase (progress, accounts, shared scenarios). Not until a feature needs it.
- Godot port. Only if phone performance fails.

<details>
<summary>Recently Done</summary>

- Tutorial points at the exact button (pulsing ring and Tap here marker) and shows glowing rings for drain spots.
- Storm atmosphere (darker sky, dimmer sun, lightning and thunder), wet glossy ground, water shader rebuilt (flow-direction ripples, rain rings, foam, mirror-like shallow sheets), raindrop splashes, drain swirls, animated sea.
- Live site fixed: Netlify deploys from main; session branch merged.
- Setting: Halifax Shores, Volusia County (Halifax River and Atlantic), real Volusia facts after each storm. Audience students and adults, easy difficulty.
- Level 1 polish: guided first storm, drains pipe into nearby ponds, wall tool, procedural sound, star ratings and Level complete, sim unit tests (`npm test`).
- Milestone 3: House, Street, Watershed and Region zoom with camera flights, detail hiding and map labels. Watershed (bowl depth, bay vs ocean drainage), High tide and Pipes lenses. `src/sim/watershed.ts`.
- Netlify linked to GitHub (pushes deploy).
- Milestone 2: Storm 3 (wet season), swale, pond and raise-road tools, replay with flow arrows, groundwater and flow lenses, mosquito and raised-road consequence notes.
- Larger UI text and touch targets, tool bar clear of the hosting badge.
- Netlify project high-water-flood, deployed.
- Quality tiers for weak phones (smaller texture and shadows, fewer palms, lower resolution) plus automatic resolution drop when fps falls under 28.
- Removed the bay and ocean seam: the open sea plane covers all open water.
- Vite + TypeScript + Three.js PWA scaffold, Netlify config.
- Virtual-pipes water sim with rain, infiltration, groundwater, tide boundary.
- Drains with tide-dependent outfall (backflow), check valves, pumps.
- Storm 1 and Storm 2 scenarios, grading by worst house depth, plain-language failure notes.
- Blender asset pipeline (`blender/build_assets.py`): 3 house styles, 2 palms, shrub, car, streetlight, drain, check valve, pump. Baked AO, Draco glb.
- Physical sky with environment reflections, painted ground (roads, markings, sidewalks, driveways, pools), scenery border past the map edge.
- Water depth shader, rain, backflow and outfall particles, elevation lens.

</details>
