# High Water

Educational Florida flood game. Level 1 teaches why streets flood and why unlimited money does not instantly fix it.

- Storm 1: heavy rain. Drains fix it.
- Storm 2: rain plus king tide. The bay rises above the outfall and drains run backward. Check valves stop backflow, pumps get rain out.

Stack: Vite, TypeScript, Three.js, PWA. Sim (`src/sim`) is independent of rendering (`src/render`).

Netlify: build `npm run build`, publish `dist` (set in `netlify.toml`).

See `TODO.md` for priorities.

```
npm install
npm run dev
npm run build
```
