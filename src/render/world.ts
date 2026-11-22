import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { S, LIFT_CAP, type Sim } from '../sim/grid.ts';
import type { Level } from '../levels/types.ts';
import { makeWaterMaterial, makeSeaNormals } from './water.ts';
import { PAD, padTerrain, paintGround, type Padded, type Rect } from './ground.ts';
import { computeWatershed, type Watershed } from '../sim/watershed.ts';

// World units per foot of elevation. Exaggerated so a few feet of relief reads on screen; set per map so
// places with more relief (Cedar Key, Key West) do not turn into cliffs.
export let VS = 0.35;
function verticalScale(elev: Float32Array, open: Uint8Array) {
  const land = Array.from(elev).filter((_, i) => !open[i]).sort((a, b) => a - b);
  if (!land.length) return 0.35;
  const relief = land[Math.floor(land.length * 0.95)] - land[Math.floor(land.length * 0.05)];
  return Math.min(0.35, 2.2 / Math.max(1, relief));
}
export type Lens = 'surface' | 'elevation' | 'groundwater' | 'flow' | 'tide' | 'watershed' | 'pipes';
export type Zoom = 'house' | 'street' | 'watershed' | 'region';
const MAP_LENSES: Lens[] = ['elevation', 'groundwater', 'tide'];
// Camera presets: distance and polar angle (0 = straight down)
const ZOOMS: Record<Zoom, [number, number]> = { house: [9, 0.95], street: [40, 0.86], watershed: [60, 0.3], region: [150, 0.5] };
export interface View { water: Float32Array; conc: Float32Array | null; vx: Float32Array | null; vy: Float32Array | null; tide: number; rain: number; live: boolean }
const SEWER_PIPE = -100000;

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
interface Particle { v: THREE.Vector3; life: number; g: number }

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
  watershed: Watershed;
  detail: THREE.Object3D[] = [];
  pipes: THREE.InstancedMesh | null = null;
  pipeOwner: number[] = []; // drain index, or -1 - pump index
  labels: { el: HTMLDivElement; pos: THREE.Vector3; min: number; max: number; lens?: Lens }[] = [];
  private ghost!: THREE.Mesh;
  private sewageProps = new THREE.Group();
  private septicRings: THREE.Mesh[] = [];
  private liftRing: THREE.Mesh | null = null;
  outline: THREE.LineLoop;
  private tween: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number } | null = null;
  camDist = 40;
  private sunLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private stormDome!: THREE.Mesh;
  private storm = 0;
  private flash = 0;
  onLightning: (() => void) | null = null;
  private wet: Float32Array;
  private wetT = 0;
  private hints = new THREE.Group();
  private seaNormal: THREE.DataTexture;

  level: Level;
  outfallVel = new THREE.Vector3(-2.2, 0.6, 0);

  constructor(parent: HTMLElement, sim: Sim, level: Level) {
    this.sim = sim;
    this.level = level;
    VS = verticalScale(sim.elev, sim.open);
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
    // Overcast dome that fades in with the rain
    this.stormDome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12), new THREE.MeshBasicMaterial({ color: 0x59626a, transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.stormDome.renderOrder = -1;
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
    this.controls.maxDistance = 200;
    this.controls.addEventListener('start', () => { this.tween = null; });

    this.scene.add(this.stormDome);
    this.hemi = new THREE.HemisphereLight(0xdcecff, 0x7a6a4a, 0.7);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
    sun.position.copy(sunDir).multiplyScalar(60);
    sun.castShadow = true;
    this.sunLight = sun;
    sun.shadow.mapSize.setScalar(LOW ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    this.layoutHouses();
    this.watershed = computeWatershed(sim);

    // Terrain with scenery padding around the sim grid
    this.pad = padTerrain(sim);
    const m = this.pad.m;
    const tg = new THREE.PlaneGeometry(m - 1, m - 1, m - 1, m - 1);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < m * m; i++) tp.setY(i, this.pad.elev[i] * VS);
    tg.computeVertexNormals();
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(m * m * 3), 3));
    tg.setAttribute('aWet', new THREE.BufferAttribute(new Float32Array(m * m), 1));
    this.wet = new Float32Array(n * n);
    this.groundMat = new THREE.MeshStandardMaterial({ map: paintGround(this.pad, n, this.groundExtras(), LOW ? 1024 : 2048, level.roads, level.bigBuildings), roughness: 0.95, vertexColors: true });
    // Rain makes the ground darker and glossy (wet asphalt reflects the sky)
    this.groundMat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aWet;\nvarying float vWet;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWet = aWet;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vWet;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.14, vWet);')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.58, vWet);');
    };
    this.lensMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.terrain = new THREE.Mesh(tg, this.groundMat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.paintColors();

    // Open sea beyond the grid on the bay and ocean sides
    this.seaNormal = makeSeaNormals();
    this.seaNormal.repeat.set(60, 60);
    const seaMat = new THREE.MeshStandardMaterial({ color: 0x1b5566, roughness: 0.18, metalness: 0.1, normalMap: this.seaNormal, normalScale: new THREE.Vector2(0.5, 0.5) });
    const half = n / 2 - 0.5, F = 400;
    const seaRect = (x0: number, x1: number, z0: number, z1: number) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), seaMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      p.receiveShadow = true;
      this.sea.add(p);
    };
    // A frame of sea around the playable grid; it shows wherever the scenery border dips below the tide
    seaRect(-F, -half, -F, F); seaRect(half, F, -F, F);
    seaRect(-half, half, -F, -half); seaRect(-half, half, half, F);
    this.scene.add(this.sea);

    // Outline of the playable neighborhood, shown when zoomed out
    const h0 = n / 2;
    this.outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h0, 0, -h0), new THREE.Vector3(h0, 0, -h0), new THREE.Vector3(h0, 0, h0), new THREE.Vector3(-h0, 0, h0)]),
      new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true }));
    this.outline.position.y = 3.5 * VS;
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);

    // Sim water surface
    const wg = new THREE.PlaneGeometry(n - 1, n - 1, n - 1, n - 1);
    wg.rotateX(-Math.PI / 2);
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const da = new THREE.BufferAttribute(new Float32Array(n * n), 1);
    da.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aDepth', da);
    const fa = new THREE.BufferAttribute(new Float32Array(n * n * 2), 2);
    fa.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aFlow', fa);
    const ca2 = new THREE.BufferAttribute(new Float32Array(n * n), 1);
    ca2.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aConc', ca2);
    this.waterMat = makeWaterMaterial(sunDir);
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.scene.add(this.water);

    this.buildOutfall();
    this.scene.add(this.props);
    this.scene.add(this.sewageProps);

    // "If nothing drained" bathtub: a striped ghost surface over the bowl behind the seawall
    const gg = new THREE.PlaneGeometry(n - 1, n - 1, n - 1, n - 1);
    gg.rotateX(-Math.PI / 2);
    gg.setAttribute('aFill', new THREE.BufferAttribute(new Float32Array(n * n), 1));
    this.ghost = new THREE.Mesh(gg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { uTime: { value: 0 } },
      vertexShader: 'attribute float aFill; varying float vFill; varying vec3 vW; void main() { vFill = aFill; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform float uTime; varying float vFill; varying vec3 vW; void main() { if (vFill < 0.03) discard; float s = step(0.5, fract((vW.x + vW.z) * 0.9 - uTime * 0.25)); float edge = 1.0 - smoothstep(0.03, 0.12, vFill); vec3 c = mix(vec3(0.35, 0.7, 1.0), vec3(1.0), edge); gl_FragColor = vec4(c, 0.28 + 0.14 * s + 0.4 * edge); }',
    }));
    this.ghost.renderOrder = 2;
    this.ghost.frustumCulled = false;
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.updateGhost();

    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 3;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
    this.scene.add(this.hints);

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
    for (let k = 0; k < MAXP; k++) this.partData.push({ v: new THREE.Vector3(), life: 0, g: 6 });
    this.parts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe6f2ff, size: 0.09, transparent: true, opacity: 0.85 }));
    this.parts.frustumCulled = false;
    this.scene.add(this.parts);

    // Map labels, shown by zoom distance
    const label = (text: string, gx: number, gy: number, y: number, min: number, max = 999, lens?: Lens) => {
      const el = document.createElement('div');
      el.className = 'maplabel';
      el.textContent = text;
      document.body.appendChild(el);
      this.labels.push({ el, pos: new THREE.Vector3(gx - n / 2 + 0.5, y, gy - n / 2 + 0.5), min, max, lens });
    };
    for (const l of level.labels) label(l.text, l.gx, l.gy, l.y, l.min, l.max ?? 999, l.lens as Lens | undefined);

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
      return { type, idx, gx, gy, rot: this.level.facing[k] ?? 0, color: new THREE.Color(HOUSE_COLS[(k * 3) % HOUSE_COLS.length]), car: r() > 0.3 };
    });
  }

  private groundExtras(): Rect[] {
    const out: Rect[] = [];
    const r = rng(9);
    this.slots.forEach((s, k) => {
      out.push({ x0: s.gx - 1.05, y0: s.gy - 1.05, x1: s.gx + 1.05, y1: s.gy + 1.05, color: '#b9b3a6' });
      const [ox, oz] = rotXZ(CAR_SPOT[s.type][0], CAR_SPOT[s.type][1], s.rot);
      const cx = s.gx + ox, cy = s.gy + oz;
      // Driveway from the car spot out to the street, along the way the house faces
      const m = this.sim.houses[k].manhole, mx = m % this.n, my = Math.floor(m / this.n);
      if (Math.abs(Math.sin(s.rot)) > 0.5) out.push({ x0: Math.min(cx - 0.35, mx), y0: cy - 0.28, x1: Math.max(cx + 0.35, mx), y1: cy + 0.28, color: '#cbc5b8' });
      else out.push({ x0: cx - 0.28, y0: Math.min(cy - 0.35, my), x1: cx + 0.28, y1: Math.max(cy + 0.35, my), color: '#cbc5b8' });
      if (r() < 0.5) {
        const [bx, bz] = rotXZ(-0.2, -1.35, s.rot);
        const px = s.gx + bx, py = s.gy + bz;
        out.push({ x0: px - 0.5, y0: py - 0.38, x1: px + 0.5, y1: py + 0.38, color: '#e9e5dc' });
        out.push({ x0: px - 0.38, y0: py - 0.26, x1: px + 0.38, y1: py + 0.26, color: '#46b8d0' });
      }
    });
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

  /** Screen position of a cell (at its water surface plus a lift), or null when off screen. */
  project(i: number, lift = 0.15) {
    const v = this.toWorld(i);
    v.y += (this.sim.open[i] ? 0 : this.sim.water[i]) * VS + lift;
    v.project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null;
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight };
  }

  houseLabel(k: number) { return { house_ranch: 'Ranch house', house_twostory: 'Two-story house', house_modern: 'Modern house' }[this.slots[k].type]; }

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
    this.terrain.material = MAP_LENSES.includes(l) ? this.lensMat : this.groundMat;
    if (this.pipes) this.pipes.visible = l === 'pipes';
    this.ghost.visible = l === 'watershed';
  }

  private updateGhost() {
    const n = this.n, { fill } = this.watershed;
    const gp = this.ghost.geometry.attributes.position as THREE.BufferAttribute;
    const ga = this.ghost.geometry.attributes.aFill as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) { gp.setY(i, (this.sim.elev[i] + fill[i]) * VS + 0.02); ga.setX(i, this.sim.open[i] ? 0 : fill[i]); }
    gp.needsUpdate = true; ga.needsUpdate = true;
  }

  /** Fly the camera to a zoom preset. House zoom centers on the house nearest the current view. */
  flyTo(z: Zoom) {
    const [dist, polar] = ZOOMS[z];
    let target = new THREE.Vector3(0, 0.6, 0);
    if (z === 'house') {
      const t = this.controls.target;
      let best = Infinity;
      for (const s of this.slots) {
        const p = this.gridToWorld(s.gx, s.gy);
        const d = p.distanceToSquared(t);
        if (d < best) { best = d; target = p.add(new THREE.Vector3(0, 0.3, 0)); }
      }
    }
    const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.radius = dist; sph.phi = polar;
    const p1 = new THREE.Vector3().setFromSpherical(sph).add(target);
    this.tween = { p0: this.camera.position.clone(), p1, t0: this.controls.target.clone(), t1: target, start: performance.now() };
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
        } else if (this.lens === 'tide') {
          const e = sim.elev[gi];
          if (sim.open[gi]) c.setRGB(0.1, 0.3, 0.6);
          else if (e < sim.tide) c.setRGB(0.92, 0.3, 0.25);
          else if (e < sim.tide + 1) c.setRGB(1.0, 0.72, 0.3);
          else c.setRGB(0.86, 0.88, 0.84);
          if (sim.surface[gi] === S.Wall) c.setRGB(0.35, 0.35, 0.38);
          c.convertSRGBToLinear();
        } else if (this.lens === 'watershed') {
          const { fill, basin } = this.watershed;
          if (sim.open[gi]) c.setRGB(0.12, 0.32, 0.6);
          else if (basin[gi] === 1) c.setRGB(1.0, 0.86, 0.68); // drains toward the river (light tint over the map)
          else c.setRGB(0.74, 0.96, 0.8); // drains toward the ocean
          if (fill[gi] > 0) c.multiply(new THREE.Color(0.82, 0.9, 1.0));
          const bx = gx < n - 1 ? basin[gi + 1] : basin[gi];
          if (!sim.open[gi] && bx !== basin[gi] && !sim.open[gi + 1]) c.setRGB(0.3, 0.22, 0.15); // the divide
        } else if (this.lens === 'pipes') {
          c.setRGB(0.3, 0.3, 0.34);
        } else {
          c.setRGB(1, 1, 1);
          if (inGrid && sim.surface[gi] === S.Swale) c.setRGB(0.72, 0.9, 0.62);
          if (inGrid && sim.surface[gi] === S.Pond) c.setRGB(0.62, 0.55, 0.42);
          if (inGrid && sim.elev[gi] > sim.elev0[gi] + 0.01) c.setRGB(0.82, 0.82, 0.85);
          if (inGrid && sim.surface[gi] === S.Wall && sim.surface0[gi] !== S.Wall) c.setRGB(0.72, 0.68, 0.62);
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
    this.watershed = computeWatershed(this.sim);
    this.updateGhost();
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
      if (!name.startsWith('house')) this.detail.push(im);
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
    const { m, surf, elev } = this.pad;
    const nearHouse = (gx: number, gy: number) => this.slots.some(s => Math.abs(s.gx - gx) < 2.2 && Math.abs(s.gy - gy) < 1.9);
    const surfAt = (gx: number, gy: number) => surf[Math.min(m - 1, Math.max(0, Math.round(gy + PAD))) * m + Math.min(m - 1, Math.max(0, Math.round(gx + PAD)))];
    // Walk each road: palms along the verges, streetlights every 8 tiles
    const lights: THREE.Matrix4[] = [];
    for (const rd of this.level.roads) {
      let acc = 0, side = 1;
      for (let j = 1; j < rd.pts.length; j++) {
        const [x0, y0] = rd.pts[j - 1], [x1, y1] = rd.pts[j];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-3) continue;
        const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
        for (let d = (5 - acc % 5) % 5; d < len; d += 5) {
          const tot = acc + d, px = x0 + ux * d, py = y0 + uy * d, off = rd.w / 2 + (rd.w >= 1.4 ? 1.1 : 0.7);
          for (const sg of [1, -1]) {
            const qx = px - uy * off * sg, qy = py + ux * off * sg;
            if (rd.w >= 1.4 && surfAt(qx, qy) === S.Grass && !nearHouse(qx, qy) && Math.round(tot / 5) % 2 === (sg > 0 ? 0 : 1)) addPalm(qx, qy);
          }
          if (rd.w >= 1.4 && tot % 10 < 5) {
            side = -side;
            const lx = px - uy * (rd.w / 2 + 0.5) * side, ly = py + ux * (rd.w / 2 + 0.5) * side;
            if (surfAt(lx, ly) !== S.Water) lights.push(mat(this.gridToWorld(lx, ly), Math.atan2(px - lx, py - ly))); // lamp arm points at the road
          }
        }
        acc += len;
      }
    }
    for (let t = 0; t < 2500 && palms[0].length + palms[1].length < (LOW ? 70 : 150); t++) {
      const x = Math.floor(r() * m), y = Math.floor(r() * m), i = y * m + x;
      const gx = x - PAD + (r() - 0.5) * 0.6, gy = y - PAD + (r() - 0.5) * 0.6;
      const s = surf[i];
      if (!(s === S.Grass || (s === S.Sand && elev[i] > 3))) continue;
      if (nearHouse(gx, gy) || surfAt(gx + 0.6, gy) === S.Pavement || surfAt(gx - 0.6, gy) === S.Pavement || surfAt(gx, gy + 0.6) === S.Pavement || surfAt(gx, gy - 0.6) === S.Pavement) continue;
      if (s === S.Grass && r() < 0.45) { shrubs.push(mat(this.gridToWorld(gx, gy), r() * 6, 0.8 + r() * 0.6)); continue; }
      addPalm(gx, gy);
    }
    this.batch('palm_a', palms[0]);
    this.batch('palm_b', palms[1]);
    this.batch('shrub', shrubs);

    this.batch('streetlight', lights);
  }

  private buildOutfall() {
    const n = this.n;
    const g = new THREE.CylinderGeometry(0.2, 0.2, 1.2, 16, 1, true);
    g.rotateZ(Math.PI / 2);
    const pipe = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide }));
    const [dx, dy] = this.level.outfallDir, c = this.level.outfallCell;
    void n;
    this.outfallPos.copy(this.toWorld(c)).add(new THREE.Vector3(dx * 0.6, 0, dy * 0.6));
    this.outfallPos.y = Math.max(this.sim.outfallElev, this.sim.elev[c] - 1) * VS;
    pipe.position.copy(this.outfallPos);
    if (dy !== 0) pipe.rotation.y = Math.PI / 2;
    pipe.castShadow = true;
    this.scene.add(pipe);
    this.outfallPos.add(new THREE.Vector3(dx * 0.6, 0, dy * 0.6));
    this.outfallVel.set(dx * 2.2, 0.6, dy * 2.2);
  }

  /** Pulsing rings that show the player where to tap (tutorial). */
  private hintCells: number[] = [];
  setHints(cells: number[]) {
    this.hintCells = cells;
    this.hints.clear();
    const g = new THREE.RingGeometry(0.35, 0.55, 28);
    g.rotateX(-Math.PI / 2);
    const mtl = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.95, depthTest: false });
    for (const i of cells) {
      if (this.sim.drainAt(i)) continue;
      const r = new THREE.Mesh(g, mtl);
      const p = this.toWorld(i);
      r.position.set(p.x, p.y + 0.08, p.z);
      r.renderOrder = 6;
      this.hints.add(r);
    }
  }

  /** Septic lids, manholes, lift station and failure rings (Level 2). */
  private buildSewage() {
    this.sewageProps.clear();
    this.septicRings = [];
    this.liftRing = null;
    const sim = this.sim;
    if (!sim.septicOn) return;
    const lid = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16);
    const lidMat = new THREE.MeshStandardMaterial({ color: 0x9c9a8a, roughness: 0.9 });
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.6, metalness: 0.5 });
    const ringG = new THREE.RingGeometry(0.4, 0.6, 28);
    ringG.rotateX(-Math.PI / 2);
    const ringM = new THREE.MeshBasicMaterial({ color: 0x8a5a14, transparent: true, opacity: 0.95, depthTest: false });
    for (const h of sim.houses) {
      const cell = h.sewer ? h.manhole : h.septic;
      const p = this.toWorld(cell);
      const m = new THREE.Mesh(lid, h.sewer ? holeMat : lidMat);
      m.position.set(p.x, p.y + 0.03, p.z);
      this.sewageProps.add(m);
      const r = new THREE.Mesh(ringG, ringM);
      r.position.set(p.x, p.y + 0.08, p.z);
      r.renderOrder = 6;
      r.visible = false;
      this.sewageProps.add(r);
      this.septicRings.push(r);
    }
    if (sim.houses.some(h => h.sewer) && this.assets.pump) {
      const ls = this.assets.pump.clone();
      ls.position.copy(this.toWorld(sim.liftCell));
      this.sewageProps.add(ls);
      const r = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, depthTest: false }));
      const p = this.toWorld(sim.liftCell);
      r.position.set(p.x, p.y + 0.6, p.z);
      r.scale.setScalar(1.6);
      r.renderOrder = 6;
      r.visible = false;
      this.sewageProps.add(r);
      this.liftRing = r;
    }
  }

  rebuildProps() {
    this.buildSewage();
    if (this.hintCells.length) this.setHints(this.hintCells);
    this.buildPipes();
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

  /** Underground pipes: drains run to a nearby pond or straight to the outfall; pumps push to the outfall too. */
  private buildPipes() {
    if (this.pipes) { this.scene.remove(this.pipes); this.pipes.geometry.dispose(); }
    const segs: [number, number, number, number, number][] = [];
    const n = this.n, oc = this.level.outfallCell, ox = oc % n, oy = Math.floor(oc / n);
    this.sim.connectDrains();
    this.sim.drains.forEach((d, k) => {
      const x = d.i % n, y = Math.floor(d.i / n);
      const to = d.to ?? -1;
      if (to >= 0) segs.push([x, y, to % n, Math.floor(to / n), k]);
      else segs.push([x, y, ox, oy, k]);
    });
    this.sim.pumps.forEach((p, k) => segs.push([p.i % n, Math.floor(p.i / n), ox, oy, -1 - k]));
    if (this.sim.septicOn) {
      const lx = this.sim.liftCell % this.n, ly = Math.floor(this.sim.liftCell / this.n);
      for (const h of this.sim.houses) if (h.sewer) segs.push([h.manhole % this.n, Math.floor(h.manhole / this.n), lx, ly, SEWER_PIPE]);
    }
    this.pipeOwner = segs.map(s => s[4]);
    const g = new THREE.BoxGeometry(1, 0.08, 1);
    this.pipes = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }), Math.max(1, segs.length));
    this.pipes.count = segs.length;
    this.pipes.renderOrder = 4;
    this.pipes.frustumCulled = false;
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    segs.forEach(([x0, y0, x1, y1], k) => {
      const a = this.gridToWorld(x0, y0), b = this.gridToWorld(x1, y1);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y = Math.max(a.y, b.y) + 0.05;
      const len = Math.max(0.2, a.distanceTo(new THREE.Vector3(b.x, a.y, b.z)));
      q.setFromAxisAngle(up, Math.atan2(b.x - a.x, b.z - a.z));
      this.pipes!.setMatrixAt(k, mtx.compose(mid, q, new THREE.Vector3(0.26, 1, len + 0.26)));
      this.pipes!.setColorAt(k, new THREE.Color(0x8fa3b8));
    });
    this.pipes.visible = this.lens === 'pipes';
    this.scene.add(this.pipes);
  }

  // ---------- effects
  private resetDrop(a: Float32Array, k: number, y: number) {
    const x = (Math.random() - 0.5) * 60, z = (Math.random() - 0.5) * 60;
    a.set([x, y, z, x + 0.08, y + 0.7, z + 0.05], k * 6);
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, spread: number, life = 0.7, g = 6) {
    const k = this.partHead;
    this.partHead = (k + 1) % this.partData.length;
    const pa = this.parts.geometry.attributes.position as THREE.BufferAttribute;
    pa.setXYZ(k, pos.x + (Math.random() - 0.5) * 0.25, pos.y, pos.z + (Math.random() - 0.5) * 0.25);
    const d = this.partData[k];
    d.v.set(vel.x + (Math.random() - 0.5) * spread, vel.y * (0.7 + Math.random() * 0.5), vel.z + (Math.random() - 0.5) * spread);
    d.life = life;
    d.g = g;
  }

  update(dt: number, t: number, v: View) {
    const { sim, n } = this;
    if (this.tween) {
      const tw = this.tween;
      const k = Math.min(1, (performance.now() - tw.start) / 900); // wall clock, so slow devices still finish in 0.9 s
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();

    // Level of detail: declutter and label when zoomed out
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camDist = dist;
    const showDetail = dist < 52;
    for (const o of this.detail) o.visible = showDetail;
    this.outline.visible = dist > 45;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 30 + dist * 0.9;
    fog.far = 90 + dist * 2.2;
    const half = new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), pv = new THREE.Vector3();
    for (const lb of this.labels) {
      const on = lb.lens ? this.lens === lb.lens : dist >= lb.min && dist <= lb.max;
      if (on) {
        pv.copy(lb.pos).project(this.camera);
        const vis = pv.z < 1 && Math.abs(pv.x) < 0.8 && Math.abs(pv.y) < 0.85;
        lb.el.style.display = vis ? 'block' : 'none';
        if (vis) lb.el.style.transform = `translate(${half.x + pv.x * half.x}px, ${half.y - pv.y * half.y}px) translate(-50%, -50%)`;
      } else lb.el.style.display = 'none';
    }
    if (this.pipes && this.lens === 'pipes') {
      const c = new THREE.Color();
      this.pipeOwner.forEach((o, k) => {
        if (o === SEWER_PIPE) { c.setHex(sim.liftLoad > LIFT_CAP ? 0xff4433 : 0xb07a3a); this.pipes!.setColorAt(k, c); return; }
        const f = o >= 0 ? (sim.drains[o]?.flow ?? 0) : (sim.pumps[-1 - o]?.flow ?? 0);
        c.setHex(f < -0.01 ? 0xff4433 : f > 0.01 ? 0x3ee0ff : 0x8fa3b8);
        this.pipes!.setColorAt(k, c);
      });
      if (this.pipes.instanceColor) this.pipes.instanceColor.needsUpdate = true;
    }
    this.waterMat.uniforms.uTime.value = t;
    this.sea.position.y = v.tide * VS - 0.03;
    this.seaNormal.offset.set(t * 0.004, t * 0.0025);

    // Storm atmosphere follows the rain
    this.storm += (Math.min(1, v.rain / 3) - this.storm) * Math.min(1, dt * 0.8);
    const st = this.storm;
    if (st > 0.6 && Math.random() < dt * 0.05 * st) { this.flash = 1; this.onLightning?.(); }
    this.flash = Math.max(0, this.flash - dt * 4);
    const fl = this.flash * (0.6 + 0.4 * Math.sin(t * 60));
    this.sunLight.intensity = 3.2 * (1 - 0.62 * st);
    this.hemi.intensity = 0.7 + 0.25 * st + fl * 2.5;
    this.renderer.toneMappingExposure = 0.75 - 0.05 * st + fl * 0.4;
    this.scene.environmentIntensity = 0.7 - 0.3 * st;
    (this.stormDome.material as THREE.MeshBasicMaterial).opacity = 0.75 * st;
    (this.scene.fog as THREE.Fog).color.setRGB(0.79 - 0.3 * st + fl * 0.2, 0.86 - 0.3 * st + fl * 0.2, 0.9 - 0.28 * st + fl * 0.2);
    this.waterMat.uniforms.uRain.value = Math.min(1, v.rain / 4);
    this.waterMat.uniforms.uDark.value = st;

    // Ground wetness: soaks in with rain, stays wet under water, dries slowly after
    const wet = this.wet;
    for (let i = 0; i < n * n; i++) {
      if (v.water[i] > 0.01) wet[i] = 1;
      else wet[i] = Math.min(1, Math.max(0, wet[i] + (v.rain > 0 ? dt * v.rain * 0.12 : -dt * 0.015)));
    }
    if ((this.wetT += dt) > 0.15) {
      this.wetT = 0;
      const { m } = this.pad;
      const wa = this.terrain.geometry.attributes.aWet as THREE.BufferAttribute;
      const outside = Math.min(1, st * 1.2);
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const gx = x - PAD, gy = y - PAD;
        wa.setX(y * m + x, gx >= 0 && gy >= 0 && gx < n && gy < n ? wet[gy * n + gx] : outside);
      }
      wa.needsUpdate = true;
    }

    // Tutorial hint rings pulse
    const pulse = 1 + 0.25 * Math.sin(t * 6);
    for (const h of this.hints.children) h.scale.setScalar(pulse);
    // Septic failures and an overloaded lift station pulse too
    sim.houses.forEach((h, k) => { const r = this.septicRings[k]; if (r) { r.visible = v.live && !h.sewer && h.septicFail; r.scale.setScalar(pulse); } });
    if (this.liftRing) { this.liftRing.visible = v.live && sim.liftLoad > LIFT_CAP; this.liftRing.scale.setScalar(1.6 * pulse); }
    (this.ghost.material as THREE.ShaderMaterial).uniforms.uTime.value = t;

    const wp = this.water.geometry.attributes.position as THREE.BufferAttribute;
    const wd = this.water.geometry.attributes.aDepth as THREE.BufferAttribute;
    const wf = this.water.geometry.attributes.aFlow as THREE.BufferAttribute;
    const wc = this.water.geometry.attributes.aConc as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) {
      const d = sim.open[i] ? 0 : v.water[i];
      wp.setY(i, d > 0.004 ? (sim.elev[i] + d) * VS : sim.elev[i] * VS - 0.03);
      wd.setX(i, d);
      if (v.vx && v.vy) wf.setXY(i, v.vx[i], v.vy[i]);
      wc.setX(i, v.conc ? v.conc[i] : 0);
    }
    wc.needsUpdate = true;
    wp.needsUpdate = true;
    wd.needsUpdate = true;
    wf.needsUpdate = true;

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
    // Water swirling into working drains
    for (const d of sim.drains) {
      if (d.flow > 0.03 && sim.water[d.i] > 0.02 && Math.random() < Math.min(1, d.flow * 2)) {
        const p = this.toWorld(d.i);
        const a = Math.random() * Math.PI * 2, r = 0.45;
        p.x += Math.cos(a) * r; p.z += Math.sin(a) * r; p.y += sim.water[d.i] * VS + 0.03;
        this.spawn(p, new THREE.Vector3(-Math.sin(a) * 1.2 - Math.cos(a) * 0.8, 0, Math.cos(a) * 1.2 - Math.sin(a) * 0.8), 0.05, 0.45, 0);
      }
    }
    // Raindrop splashes near the camera target
    if (v.rain > 0) {
      const tgt = this.controls.target;
      const count = Math.min(6, v.rain * 1.5);
      for (let k = 0; k < count; k++) {
        const gx = Math.round(tgt.x + n / 2 - 0.5 + (Math.random() - 0.5) * 30), gy = Math.round(tgt.z + n / 2 - 0.5 + (Math.random() - 0.5) * 30);
        if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        const i = gy * n + gx;
        if (sim.open[i]) continue;
        const p = this.gridToWorld(gx + Math.random() - 0.5, gy + Math.random() - 0.5);
        p.y = (sim.elev[i] + v.water[i]) * VS + 0.01;
        this.spawn(p, new THREE.Vector3(0, 0.9, 0), 0.5, 0.22, 7);
      }
    }
    const outflow = sim.drains.reduce((s, d) => s + Math.max(0, d.flow), 0) + sim.pumps.reduce((s, p) => s + p.flow, 0);
    if (outflow > 0.05 && Math.random() < Math.min(1, outflow)) this.spawn(this.outfallPos, this.outfallVel, 0.4);
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
    if ((this.lens === 'groundwater' || this.lens === 'tide') && (this.gwT += dt) > 0.5) { this.gwT = 0; this.paintColors(); }

    const pa = this.parts.geometry.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < this.partData.length; k++) {
      const d = this.partData[k];
      if (d.life <= 0) continue;
      d.life -= dt;
      d.v.y -= d.g * dt;
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
