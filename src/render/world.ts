import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { S, type Sim } from '../sim/grid.ts';
import { OUTFALL_ROW } from '../levels/level1.ts';
import { makeWaterMaterial } from './water.ts';
import { PAD, padTerrain, paintGround, type Padded, type Rect } from './ground.ts';

export const VS = 0.35; // world units per foot of elevation (vertical exaggeration)
export type Lens = 'surface' | 'elevation' | 'groundwater' | 'flow';
export interface View { water: Float32Array; vx: Float32Array | null; vy: Float32Array | null; tide: number; rain: number; live: boolean }

// Quality tier: ?q=low or ?q=high forces it, otherwise touch devices with few cores or little memory get low.
export const LOW = (() => {
  const q = new URLSearchParams(location.search).get('q');
  if (q) return q === 'low';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch && ((navigator.hardwareConcurrency ?? 8) <= 6 || (nav.deviceMemory ?? 8) <= 4);
})();

const ASSETS = ['house_ranch', 'house_twostory', 'house_modern', 'palm_a', 'palm_b', 'shrub', 'car', 'streetlight', 'drain', 'check_valve', 'pump'] as const;
type AssetName = (typeof ASSETS)[number];
const HOUSE_TYPES = ['house_ranch', 'house_twostory', 'house_modern'] as const;
type HouseType = (typeof HOUSE_TYPES)[number];
const CAR_SPOT: Record<HouseType, [number, number]> = { house_ranch: [0.42, 1.2], house_twostory: [0.35, 1.25], house_modern: [1.06, -0.05] };
const HOUSE_COLS = [0xf2b49e, 0xb5e0cf, 0xf6e3a1, 0xf6f3ec, 0xa9cdeb, 0xeec3d8, 0xf3d2b0];
const CAR_COLS = [0xc8ccd0, 0x23405e, 0xf0f0f0, 0x8a1f1f, 0x2b2b2b, 0x5e7d8a, 0xd9d2c0];
const FLOOD_COL = new THREE.Color(0xe0503f);

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Rotate a local offset (x = side, z = front) by a yaw angle
const rotXZ = (lx: number, lz: number, a: number): [number, number] => [lx * Math.cos(a) + lz * Math.sin(a), -lx * Math.sin(a) + lz * Math.cos(a)];

interface Batch { meshes: THREE.InstancedMesh[]; tinted: THREE.InstancedMesh[] }
interface Slot { type: HouseType; idx: number; gx: number; gy: number; rot: number; color: THREE.Color; car: boolean }
interface Particle { v: THREE.Vector3; life: number }

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sim: Sim;
  n: number;
  pad: Padded;
  terrain: THREE.Mesh;
  groundMat: THREE.MeshStandardMaterial;
  lensMat: THREE.MeshStandardMaterial;
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  sea = new THREE.Group();
  assets: Partial<Record<AssetName, THREE.Object3D>> = {};
  batches: Partial<Record<HouseType, Batch>> = {};
  slots: Slot[] = [];
  houseFlooded: boolean[] = [];
  props = new THREE.Group();
  cursor: THREE.Mesh;
  rain: THREE.LineSegments;
  rainCount = LOW ? 450 : 900;
  pixelRatio = 1;
  private fpsT = 0;
  private fpsN = 0;
  parts: THREE.Points;
  partData: Particle[] = [];
  partHead = 0;
  lens: Lens = 'surface';
  outfallPos = new THREE.Vector3();
  arrows: THREE.InstancedMesh;
  forceArrows = false;
  private gwT = 0;

  constructor(parent: HTMLElement, sim: Sim) {
    this.sim = sim;
    this.n = sim.n;
    const n = this.n;
    this.renderer = new THREE.WebGLRenderer({ antialias: !LOW, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio, LOW ? 1.25 : 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = LOW ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    parent.appendChild(this.renderer.domElement);

    // Physical sky, also baked into an environment map for reflections
    const sunDir = new THREE.Vector3(-30, 24, 12).normalize();
    const sky = new Sky();
    sky.scale.setScalar(1500);
    const su = sky.material.uniforms;
    su.turbidity.value = 3.5; su.rayleigh.value = 1.3; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;
    su.sunPosition.value.copy(sunDir);
    this.scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(this.scene, 0.02, 0.1, 3000).texture;
    this.scene.environmentIntensity = 0.7;
    pmrem.dispose();
    this.scene.fog = new THREE.Fog(0xc9dbe6, 55, 130);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
    this.camera.position.set(-24, 22, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.6, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.38;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 70;

    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x7a6a4a, 0.7));
    const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
    sun.position.copy(sunDir).multiplyScalar(60);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(LOW ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    this.layoutHouses();

    // Terrain with scenery padding around the sim grid
    this.pad = padTerrain(sim);
    const m = this.pad.m;
    const tg = new THREE.PlaneGeometry(m - 1, m - 1, m - 1, m - 1);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < m * m; i++) tp.setY(i, this.pad.elev[i] * VS);
    tg.computeVertexNormals();
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(m * m * 3), 3));
    this.groundMat = new THREE.MeshStandardMaterial({ map: paintGround(this.pad, n, this.groundExtras(), LOW ? 1024 : 2048), roughness: 0.95, vertexColors: true });
    this.lensMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.terrain = new THREE.Mesh(tg, this.groundMat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.paintColors();

    // Open sea beyond the grid on the bay and ocean sides
    const seaMat = new THREE.MeshStandardMaterial({ color: 0x1b5566, roughness: 0.12, metalness: 0.1 });
    const half = n / 2 - 0.5, F = 400;
    const seaRect = (x0: number, x1: number, z0: number, z1: number) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), seaMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      p.receiveShadow = true;
      this.sea.add(p);
    };
    const bayEdge = 6 - n / 2 + 0.5 - 0.1, oceanEdge = 40 - n / 2 + 0.5;
    void half;
    seaRect(-F, bayEdge, -F, F);
    seaRect(oceanEdge, F, -F, F);
    this.scene.add(this.sea);

    // Sim water surface
    const wg = new THREE.PlaneGeometry(n - 1, n - 1, n - 1, n - 1);
    wg.rotateX(-Math.PI / 2);
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const da = new THREE.BufferAttribute(new Float32Array(n * n), 1);
    da.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aDepth', da);
    this.waterMat = makeWaterMaterial(sunDir);
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.scene.add(this.water);

    this.buildOutfall();
    this.scene.add(this.props);

    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 3;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    // Flow arrows (flow lens and replay)
    const shape = new THREE.Shape([new THREE.Vector2(0, 0.42), new THREE.Vector2(0.24, 0.02), new THREE.Vector2(0.08, 0.02), new THREE.Vector2(0.08, -0.36), new THREE.Vector2(-0.08, -0.36), new THREE.Vector2(-0.08, 0.02), new THREE.Vector2(-0.24, 0.02)]);
    const ag = new THREE.ShapeGeometry(shape);
    ag.rotateX(Math.PI / 2);
    this.arrows = new THREE.InstancedMesh(ag, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }), Math.ceil(n / 2) ** 2);
    this.arrows.count = 0;
    this.arrows.renderOrder = 2;
    this.arrows.frustumCulled = false;
    this.scene.add(this.arrows);

    const rp = new Float32Array(this.rainCount * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    for (let k = 0; k < this.rainCount; k++) this.resetDrop(rp, k, Math.random() * 25);
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc8d6e4, transparent: true, opacity: 0.4 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);

    const MAXP = 500;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3).fill(-100), 3));
    for (let k = 0; k < MAXP; k++) this.partData.push({ v: new THREE.Vector3(), life: 0 });
    this.parts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe6f2ff, size: 0.12, transparent: true, opacity: 0.9 }));
    this.parts.frustumCulled = false;
    this.scene.add(this.parts);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.load().catch(e => console.error('asset load failed', e));
  }

  // ---------- layout
  private layoutHouses() {
    const r = rng(5);
    const counts: Record<string, number> = {};
    this.slots = this.sim.houses.map((h, k) => {
      let gx = 0, gy = 0;
      for (const c of h.cells) { gx += c % this.n; gy += Math.floor(c / this.n); }
      gx /= 4; gy /= 4;
      const type = HOUSE_TYPES[(k * 7 + Math.floor(k / 3)) % 3];
      const idx = counts[type] ?? 0;
      counts[type] = idx + 1;
      this.houseFlooded.push(false);
      return { type, idx, gx, gy, rot: gx < 20 ? Math.PI / 2 : -Math.PI / 2, color: new THREE.Color(HOUSE_COLS[(k * 3) % HOUSE_COLS.length]), car: r() > 0.3 };
    });
  }

  private streetEdge(gx: number) { return gx < 20 ? 18.0 : gx < 27 ? 22.0 : 28.4; }

  private groundExtras(): Rect[] {
    const out: Rect[] = [];
    const r = rng(9);
    for (const s of this.slots) {
      out.push({ x0: s.gx - 1.05, y0: s.gy - 1.05, x1: s.gx + 1.05, y1: s.gy + 1.05, color: '#b9b3a6' });
      const [ox, oz] = rotXZ(CAR_SPOT[s.type][0], CAR_SPOT[s.type][1], s.rot);
      const cx = s.gx + ox, cy = s.gy + oz, e = this.streetEdge(s.gx);
      out.push({ x0: Math.min(cx - 0.35, e), y0: cy - 0.28, x1: Math.max(cx + 0.35, e), y1: cy + 0.28, color: '#cbc5b8' });
      if (r() < 0.5) {
        const [bx, bz] = rotXZ(-0.2, -1.35, s.rot);
        const px = s.gx + bx, py = s.gy + bz;
        out.push({ x0: px - 0.5, y0: py - 0.38, x1: px + 0.5, y1: py + 0.38, color: '#e9e5dc' });
        out.push({ x0: px - 0.38, y0: py - 0.26, x1: px + 0.38, y1: py + 0.26, color: '#46b8d0' });
      }
    }
    return out;
  }

  // ---------- coordinates
  gridToWorld(gx: number, gy: number) { return new THREE.Vector3(gx - this.n / 2 + 0.5, this.elevAt(gx, gy) * VS, gy - this.n / 2 + 0.5); }

  elevAt(gx: number, gy: number) {
    const m = this.pad.m;
    const x = Math.min(m - 1, Math.max(0, Math.round(gx + PAD))), y = Math.min(m - 1, Math.max(0, Math.round(gy + PAD)));
    return this.pad.elev[y * m + x];
  }

  toWorld(i: number) { return this.gridToWorld(i % this.n, Math.floor(i / this.n)); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 55 : 42;
    this.camera.updateProjectionMatrix();
  }

  private ray = new THREE.Raycaster();
  pick(cx: number, cy: number): number | null {
    const v = new THREE.Vector2((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = this.ray.intersectObject(this.terrain)[0];
    if (!hit) return null;
    const n = this.n;
    const x = Math.round(hit.point.x + n / 2 - 0.5), y = Math.round(hit.point.z + n / 2 - 0.5);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    return y * n + x;
  }

  showCursor(i: number | null) {
    if (i === null) { this.cursor.visible = false; return; }
    const p = this.toWorld(i);
    this.cursor.position.set(p.x, p.y + 0.06, p.z);
    this.cursor.visible = true;
  }

  setLens(l: Lens) {
    this.lens = l;
    this.paintColors();
    this.terrain.material = l === 'elevation' || l === 'groundwater' ? this.lensMat : this.groundMat;
  }

  /** Writes the terrain color attribute: earthwork tints in surface/flow view, or the active lens ramp. */
  paintColors() {
    const { m, elev } = this.pad;
    const { sim, n } = this;
    const ca = this.terrain.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const pi = y * m + x;
        const gx = Math.min(n - 1, Math.max(0, x - PAD)), gy = Math.min(n - 1, Math.max(0, y - PAD));
        const gi = gy * n + gx;
        const inGrid = x - PAD === gx && y - PAD === gy;
        if (this.lens === 'elevation') {
          const e = elev[pi];
          const t = Math.min(1, Math.max(0, (e - 1.5) / 3));
          c.setHSL(0.62 - 0.55 * t, 0.65, 0.42 + 0.12 * t);
          if (e > 0 && Math.abs(e - Math.round(e * 2) / 2) < 0.04) c.multiplyScalar(0.7);
          c.convertSRGBToLinear();
        } else if (this.lens === 'groundwater') {
          if (sim.open[gi]) c.setRGB(0.05, 0.2, 0.45);
          else {
            const room = sim.elev[gi] - sim.gw[gi]; // dry soil above the water table, ft
            const t = Math.min(1, Math.max(0, room / 1.5));
            c.setRGB(0.1 + 0.75 * t, 0.35 + 0.45 * t, 0.85 - 0.5 * t);
            if (room < 0.03) c.setRGB(0.1, 0.45, 1.0);
          }
          c.convertSRGBToLinear();
        } else {
          c.setRGB(1, 1, 1);
          if (inGrid && sim.surface[gi] === S.Swale) c.setRGB(0.72, 0.9, 0.62);
          if (inGrid && sim.surface[gi] === S.Pond) c.setRGB(0.62, 0.55, 0.42);
          if (inGrid && sim.elev[gi] > sim.elev0[gi] + 0.01) c.setRGB(0.82, 0.82, 0.85);
        }
        ca.setXYZ(pi, c.r, c.g, c.b);
      }
    }
    ca.needsUpdate = true;
  }

  /** Call after the sim reshapes a cell (earthworks). */
  refreshCells(cells: number[]) {
    const { m } = this.pad, n = this.n;
    const tp = this.terrain.geometry.attributes.position as THREE.BufferAttribute;
    for (const i of cells) {
      const pi = (Math.floor(i / n) + PAD) * m + (i % n) + PAD;
      this.pad.elev[pi] = this.sim.elev[i];
      tp.setY(pi, this.sim.elev[i] * VS);
    }
    tp.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this.terrain.geometry.computeBoundingSphere();
    this.paintColors();
    this.rebuildProps();
  }

  // ---------- assets
  private async load() {
    const base = import.meta.env.BASE_URL;
    const draco = new DRACOLoader();
    draco.setDecoderPath(base + 'draco/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const list = await Promise.all(ASSETS.map(a => loader.loadAsync(`${base}assets/${a}.glb`)));
    ASSETS.forEach((a, k) => {
      const s = list[k].scene;
      s.traverse(o => { const mm = o as THREE.Mesh; if (mm.isMesh) { mm.castShadow = true; mm.receiveShadow = true; } });
      this.assets[a] = s;
    });
    draco.dispose();
    this.placeScenery();
    this.rebuildProps();
  }

  private batch(name: AssetName, mats: THREE.Matrix4[], tints?: THREE.Color[]): Batch {
    const out: Batch = { meshes: [], tinted: [] };
    const src = this.assets[name];
    if (!src || mats.length === 0) return out;
    src.updateMatrixWorld(true);
    src.traverse(o => {
      const mm = o as THREE.Mesh;
      if (!mm.isMesh) return;
      const geo = mm.geometry.clone().applyMatrix4(mm.matrixWorld);
      const material = mm.material as THREE.MeshStandardMaterial;
      const im = new THREE.InstancedMesh(geo, material, mats.length);
      mats.forEach((x, k) => im.setMatrixAt(k, x));
      if (tints && material.name.startsWith('Tint')) { tints.forEach((c, k) => im.setColorAt(k, c)); out.tinted.push(im); }
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      out.meshes.push(im);
      this.scene.add(im);
    });
    return out;
  }

  private placeScenery() {
    const up = new THREE.Vector3(0, 1, 0);
    const mat = (p: THREE.Vector3, yaw: number, s = 1, tilt = 0) =>
      new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, tilt * 0.5)), new THREE.Vector3(s, s, s));
    const r = rng(42);

    // Houses: origin is the finished floor
    for (const t of HOUSE_TYPES) {
      const ss = this.slots.filter(s => s.type === t);
      const ms = ss.map(s => { const p = this.gridToWorld(s.gx, s.gy); p.y = this.sim.houses[this.slots.indexOf(s)].floor * VS; return mat(p, s.rot); });
      this.batches[t] = this.batch(t, ms, ss.map(s => s.color));
    }

    // Cars, shrubs
    const cars: THREE.Matrix4[] = [], carCols: THREE.Color[] = [], shrubs: THREE.Matrix4[] = [];
    this.slots.forEach((s, k) => {
      if (s.car) {
        const [ox, oz] = rotXZ(CAR_SPOT[s.type][0], CAR_SPOT[s.type][1], s.rot);
        const p = this.gridToWorld(s.gx + ox, s.gy + oz);
        cars.push(mat(p, s.rot + (r() < 0.5 ? 0 : Math.PI), 1));
        carCols.push(new THREE.Color(CAR_COLS[k % CAR_COLS.length]));
      }
      for (const [lx, lz] of [[-0.8, 0.82], [-0.45, 0.85], [0.85, -0.8], [-0.85, -0.8]]) {
        if (r() < 0.25) continue;
        const [ox, oz] = rotXZ(lx, lz, s.rot);
        shrubs.push(mat(this.gridToWorld(s.gx + ox, s.gy + oz), r() * 6, 0.7 + r() * 0.5));
      }
    });
    this.batch('car', cars, carCols);

    // Palms: street rows plus scattered across yards, park, dune and the scenery border
    const palms: [THREE.Matrix4[], THREE.Matrix4[]] = [[], []];
    const addPalm = (gx: number, gy: number) => palms[r() < 0.5 ? 0 : 1].push(mat(this.gridToWorld(gx, gy), r() * 6.28, 0.8 + r() * 0.45, (r() - 0.5) * 0.12));
    for (let y = -PAD + 1; y < this.n + PAD - 1; y += 4) {
      if (Math.abs(y - 23) < 3) continue;
      addPalm(17.55, y + 0.5); addPalm(22.45, y + 2.5);
    }
    const { m, surf, elev } = this.pad;
    const nearHouse = (gx: number, gy: number) => this.slots.some(s => Math.abs(s.gx - gx) < 2.2 && Math.abs(s.gy - gy) < 1.9);
    for (let t = 0; t < 2500 && palms[0].length + palms[1].length < (LOW ? 70 : 150); t++) {
      const x = Math.floor(r() * m), y = Math.floor(r() * m), i = y * m + x;
      const gx = x - PAD + (r() - 0.5) * 0.6, gy = y - PAD + (r() - 0.5) * 0.6;
      const s = surf[i];
      if (!(s === S.Grass || (s === S.Sand && elev[i] > 3))) continue;
      if (nearHouse(gx, gy) || (gx > 17 && gx < 23) || (gy > 20.5 && gy < 25.5 && gx < 37) || (gx > 27 && gx < 29)) continue;
      if (s === S.Grass && r() < 0.45) { shrubs.push(mat(this.gridToWorld(gx, gy), r() * 6, 0.8 + r() * 0.6)); continue; }
      addPalm(gx, gy);
    }
    this.batch('palm_a', palms[0]);
    this.batch('palm_b', palms[1]);
    this.batch('shrub', shrubs);

    const lights: THREE.Matrix4[] = [];
    for (let y = -PAD + 2; y < this.n + PAD; y += 8) {
      lights.push(mat(this.gridToWorld(18.2, y), Math.PI / 2));
      lights.push(mat(this.gridToWorld(21.8, y + 4), -Math.PI / 2));
    }
    this.batch('streetlight', lights);
  }

  private buildOutfall() {
    const n = this.n;
    const g = new THREE.CylinderGeometry(0.2, 0.2, 1.2, 16, 1, true);
    g.rotateZ(Math.PI / 2);
    const pipe = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide }));
    this.outfallPos.set(6 - n / 2 + 0.5 - 0.6, this.sim.outfallElev * VS, OUTFALL_ROW - n / 2 + 0.5);
    pipe.position.copy(this.outfallPos);
    pipe.castShadow = true;
    this.scene.add(pipe);
    this.outfallPos.x -= 0.6;
  }

  rebuildProps() {
    this.props.clear();
    const { drain, check_valve, pump } = this.assets;
    if (!drain || !check_valve || !pump) return;
    for (const d of this.sim.drains) {
      const p = this.toWorld(d.i);
      const g = drain.clone();
      g.position.copy(p);
      this.props.add(g);
      if (d.valve) {
        const v = check_valve.clone();
        v.position.set(p.x, p.y + 0.06, p.z);
        this.props.add(v);
      }
    }
    for (const pm of this.sim.pumps) {
      const b = pump.clone();
      b.position.copy(this.toWorld(pm.i));
      this.props.add(b);
    }
  }

  // ---------- effects
  private resetDrop(a: Float32Array, k: number, y: number) {
    const x = (Math.random() - 0.5) * 60, z = (Math.random() - 0.5) * 60;
    a.set([x, y, z, x + 0.08, y + 0.7, z + 0.05], k * 6);
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, spread: number) {
    const k = this.partHead;
    this.partHead = (k + 1) % this.partData.length;
    const pa = this.parts.geometry.attributes.position as THREE.BufferAttribute;
    pa.setXYZ(k, pos.x + (Math.random() - 0.5) * 0.25, pos.y, pos.z + (Math.random() - 0.5) * 0.25);
    const d = this.partData[k];
    d.v.set(vel.x + (Math.random() - 0.5) * spread, vel.y * (0.7 + Math.random() * 0.5), vel.z + (Math.random() - 0.5) * spread);
    d.life = 0.7;
  }

  update(dt: number, t: number, v: View) {
    const { sim, n } = this;
    this.controls.update();
    this.waterMat.uniforms.uTime.value = t;
    this.sea.position.y = v.tide * VS - 0.03;

    const wp = this.water.geometry.attributes.position as THREE.BufferAttribute;
    const wd = this.water.geometry.attributes.aDepth as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) {
      const d = sim.open[i] ? 0 : v.water[i];
      wp.setY(i, d > 0.004 ? (sim.elev[i] + d) * VS : sim.elev[i] * VS - 0.03);
      wd.setX(i, d);
    }
    wp.needsUpdate = true;
    wd.needsUpdate = true;

    // Walls turn red while water is above the floor
    sim.houses.forEach((h, k) => {
      let lvl = -99;
      for (const c of h.cells) if (v.water[c] > 0.002) lvl = Math.max(lvl, sim.elev[c] + v.water[c]);
      const f = lvl > h.floor;
      if (f === this.houseFlooded[k]) return;
      const s = this.slots[k], b = this.batches[s.type];
      if (!b) return;
      this.houseFlooded[k] = f;
      for (const im of b.tinted) { im.setColorAt(s.idx, f ? FLOOD_COL : s.color); im.instanceColor!.needsUpdate = true; }
    });

    const vis = Math.round(Math.min(1, v.rain / 4) * this.rainCount);
    this.rain.geometry.setDrawRange(0, vis * 2);
    if (vis > 0) {
      const rp = this.rain.geometry.attributes.position as THREE.BufferAttribute;
      const a = rp.array as Float32Array;
      const fall = 28 * dt;
      for (let k = 0; k < vis; k++) {
        const o = k * 6;
        a[o + 1] -= fall; a[o + 4] -= fall; a[o] -= fall * 0.1; a[o + 3] -= fall * 0.1;
        if (a[o + 1] < -1) this.resetDrop(a, k, 22 + Math.random() * 4);
      }
      rp.needsUpdate = true;
    }

    const up = new THREE.Vector3(0, 2.2, 0);
    if (v.live) {
    for (const d of sim.drains) {
      if (d.flow < -0.01 && Math.random() < Math.min(1, -d.flow * 3)) {
        const p = this.toWorld(d.i); p.y += sim.water[d.i] * VS + 0.05;
        this.spawn(p, up, 0.6);
      }
    }
    for (const pm of sim.pumps) {
      if (pm.flow > 0.02 && Math.random() < 0.5) {
        const p = this.toWorld(pm.i); p.x -= 0.46; p.y += 0.22;
        this.spawn(p, new THREE.Vector3(-1.0, 0.8, 0), 0.3);
      }
    }
    const outflow = sim.drains.reduce((s, d) => s + Math.max(0, d.flow), 0) + sim.pumps.reduce((s, p) => s + p.flow, 0);
    if (outflow > 0.05 && Math.random() < Math.min(1, outflow)) this.spawn(this.outfallPos, new THREE.Vector3(-2.2, 0.6, 0), 0.4);
    }
    // Arrows on every other cell where water is moving
    if ((this.lens === 'flow' || this.forceArrows) && v.vx && v.vy) {
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), up2 = new THREE.Vector3(0, 1, 0);
      let c = 0;
      for (let y = 1; y < n; y += 2) for (let x = 1; x < n; x += 2) {
        const i = y * n + x;
        if (sim.open[i] || v.water[i] < 0.03) continue;
        const fx = v.vx[i], fz = v.vy[i], mag = Math.hypot(fx, fz);
        if (mag < 0.0015) continue;
        const s = Math.min(1.1, 0.45 + mag * 25);
        pos.set(x - n / 2 + 0.5, (sim.elev[i] + v.water[i]) * VS + 0.04, y - n / 2 + 0.5);
        q.setFromAxisAngle(up2, Math.atan2(fx, fz));
        sc.set(s, 1, s);
        this.arrows.setMatrixAt(c++, mtx.compose(pos, q, sc));
      }
      this.arrows.count = c;
      this.arrows.instanceMatrix.needsUpdate = true;
    } else this.arrows.count = 0;
    if (this.lens === 'groundwater' && (this.gwT += dt) > 0.5) { this.gwT = 0; this.paintColors(); }

    const pa = this.parts.geometry.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < this.partData.length; k++) {
      const d = this.partData[k];
      if (d.life <= 0) continue;
      d.life -= dt;
      d.v.y -= 6 * dt;
      if (d.life <= 0) { pa.setY(k, -100); continue; }
      pa.setXYZ(k, pa.getX(k) + d.v.x * dt, pa.getY(k) + d.v.y * dt, pa.getZ(k) + d.v.z * dt);
    }
    pa.needsUpdate = true;

    this.fpsT += dt; this.fpsN++;
    if (this.fpsT > 3) {
      const fps = this.fpsN / this.fpsT;
      if (fps < 28 && this.pixelRatio > 0.8) { this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25); this.renderer.setPixelRatio(this.pixelRatio); this.resize(); }
      this.fpsT = 0; this.fpsN = 0;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
