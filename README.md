# High Water

Educational Florida flood game. Level 1 teaches why streets flood and why unlimited money does not instantly fix it.

- Storm 1: heavy rain. Drains fix it.
- Storm 2: rain plus king tide. The bay rises above the outfall and drains run backward. Check valves stop backflow, pumps get rain out.

Stack: Vite, TypeScript, Three.js, PWA. Sim (`src/sim`) is independent of rendering (`src/render`).

Netlify: build `npm run build`, publish `dist` (set in `netlify.toml`).

Assets: `blender/build_assets.py` builds every model procedurally, bakes ambient occlusion, and exports Draco .glb files to `public/assets`. Rebuild with `pip install bpy` then `python3 blender/build_assets.py` (or `blender -b -P blender/build_assets.py`).

See `TODO.md` for priorities.

```
npm install
npm run dev
npm run build
```
