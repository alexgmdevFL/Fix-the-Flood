# Working on High Water

## How Alex works
- Alex uses Claude from a phone. Never give terminal or npm commands to run; run, test and deploy everything yourself.
- Always end every reply with the live URL: https://high-water-flood.netlify.app
- Be frugal with actions and deploys. No unnecessary checks.
- Use hyphens, never em dashes. No emojis.

## Deploys
- Netlify deploys from `main` (one deploy per push to main). Work on the session branch, then merge to main only when a release is ready.
- Verify a release by checking the live page serves the new `assets/index-*.js` hash.

## Project
- Vite + TypeScript + Three.js PWA. Sim in `src/sim` (no rendering code), renderer in `src/render`, UI in `src/ui`, level data in `src/levels`.
- Assets come from `blender/build_assets.py` (Blender as a Python module, `pip install bpy`), exported as Draco glb to `public/assets`.
- Sim tests: `npm test`. Build: `npm run build`.
- Setting: Halifax Shores, a fictional neighborhood on Volusia County's barrier island (Halifax River west, Atlantic east). Audience: students and adults. Difficulty: easy.
- Keep `TODO.md` current: Recently Done section (collapsed) and On Ice section.
