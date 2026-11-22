// Picks the map: ?place=<id>, the practice town on first play, otherwise a random real Florida place.
import type { Level } from './types.ts';
import { halifaxLevel } from './level1.ts';
import { placeLevel, type PlaceJSON } from './places.ts';

export interface PlaceMeta { id: string; name: string; county: string }
export let PLACE_INDEX: PlaceMeta[] = [];

export async function loadLevel(): Promise<Level> {
  const base = import.meta.env.BASE_URL;
  try { PLACE_INDEX = await (await fetch(`${base}places/index.json`)).json(); } catch { PLACE_INDEX = []; }
  const q = new URLSearchParams(location.search).get('place');
  let practiced = false;
  try { practiced = localStorage.getItem('hw-tutorial-done') === '1'; } catch { /* private mode */ }
  let id = q ?? (practiced && PLACE_INDEX.length ? PLACE_INDEX[Math.floor(Math.random() * PLACE_INDEX.length)].id : 'halifax');
  if (id !== 'halifax' && !PLACE_INDEX.some(p => p.id === id)) id = 'halifax';
  if (id !== 'halifax') {
    try {
      const js: PlaceJSON = await (await fetch(`${base}places/${id}.json`)).json();
      history.replaceState(null, '', `?place=${id}`);
      return placeLevel(js);
    } catch { /* fall back to the practice town */ }
  }
  return halifaxLevel();
}
