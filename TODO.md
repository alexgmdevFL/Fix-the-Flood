# TODO / Priorities

## Now (Milestone 1 polish)
- Test on a real mid-range Android phone. Auto quality is in place (`?q=low` / `?q=high` to force).
- Flow-map animation in the water shader (advect ripples along sim flux).
- Move sim into a Web Worker.
- Unit tests for sim (headless run already works with `node --experimental-strip-types`).
- PNG icons (192, 512) for older Android installs.

## Next
- Level 2 polish: sealed manhole lids tool, septic tutorial step, nutrient load to the river.
- Milestone 5: power (substations flood, pumps lose power, backup generators).
- Small dark lump at the near edge of the Miami Beach map (likely the scenery border); investigate.
- Storm surge storms, so surge-driven places (Davis Islands, Fort Myers Beach, Old Naples, Pensacola Beach, Jacksonville Riverside) become playable.
- More real places; NOAA gauges here lack published HAT, so king tides are estimated as MHHW + 0.75 ft.
- Water: double the sim resolution (96x96) for smoother puddles and shorelines.

## On Ice
- Supabase (progress, accounts, shared scenarios). Not until a feature needs it.
- Godot port. Only if phone performance fails.

<details>
<summary>Recently Done</summary>

- Real places look cleaner: larger buildings are 3D extrusions of their real OpenStreetMap outlines; street tiles no longer paint gray blobs (roads come only from real paths).
- Real Florida places: tools/fetch_places.py bakes USGS elevation, OpenStreetMap streets and homes, NOAA tide datums and NOAA Atlas 14 rainfall; tools/calibrate.ts picks each place's storms from real return periods. 8 playable places plus the practice town; place picker and Random place in More; data credits shown.
- Tap info, style A: info card anchored to the tapped spot (soil column, key numbers, reason, actions right there). Alerts pinned on the map: flooding, backflow, septic failing, sewer overflow. Inspect is the default tool. Hint strip has colored label chips and pops when it changes.
- Milestone 4 start: Level 2 Septic season. Septic drainfields fail when the water table is within 9 in, sewage surfaces and spreads with the water, Sewer tool connects a row to a lift station, floodwater leaking into manholes can overload it.
- Area view: light watershed tint over the real map, striped 'if nothing drained' bathtub surface, labels kept on screen.
- Decluttered mobile UI: compact header, one swipeable tool row, Play bar, everything else in a More sheet, small zoom buttons, slim hint strip.
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
