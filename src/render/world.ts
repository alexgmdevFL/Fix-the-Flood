import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { S, type Sim } from '../sim/grid.ts';
import { OUTFALL_ROW } from '../levels/level1.ts';
import { makeWaterMaterial } from './water.ts';

export const VS = 0.35; // world units per foot of elevation (vertical exaggeration)
export type Lens = 'surface' | 'elevation';

const SURF_COL = [0xc2b183, 0xe3d3a6, 0x7fa35a, 0x6b6e72, 0xbdb6a8, 0xb0aca2];
const HOUSE_COLS = [0xf2a48c, 0xa8dcc8, 0xf5e09a, 0xf4f1ea, 0x9cc6e8, 0xe8b4d0];
const FLOOD_COL = new THREE.Color(0xd9443a);

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Particle { v: THREE.Vector3; life: number }

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sim: Sim;
  n: number;
  terrain: THREE.Mesh;
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  walls!: THREE.InstancedMesh;
  roofs!: THREE.InstancedMesh;
  houseCols: THREE.Color[] = [];
  houseFlooded: boolean[] = [];
  props = new THREE.Group();
  cursor: THREE.Mesh;
  rain: THREE.LineSegments;
  rainCount = 900;
  parts: THREE.Points;
  partData: Particle[] = [];
  partHead = 0;
  lens: Lens = 'surface';
  private geo = {
    grate: new THREE.BoxGeometry(0.55, 0.05, 0.55),
    valve: new THREE.TorusGeometry(0.3, 0.06, 6, 16),
    pump: new THREE.BoxGeometry(0.55, 0.45, 0.55),
    stack: new THREE.CylinderGeometry(0.08, 0.08, 0.5, 8),
  };
  private mat = {
    grate: new THREE.MeshStandardMaterial({ color: 0x222428, metalness: 0.6, roughness: 0.5 }),
    valve: new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.5 }),
    pump: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.4, metalness: 0.2 }),
  };

  constructor(parent: HTMLElement, sim: Sim) {
    this.sim = sim;
    this.n = sim.n;
    const n = this.n;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(this.renderer.domElement);

    const sky = new THREE.Color(0xbfd8ea);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 70, 150);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.camera.position.set(-26, 30, 34);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.6, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;

    this.scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x8a7a5a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    sun.position.set(-20, 35, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32; sc.near = 1; sc.far = 100;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);

    // Terrain: one vertex per cell
    const tg = new THREE.PlaneGeometry(n - 1, n - 1, n - 1, n - 1);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) tp.setY(i, sim.elev[i] * VS);
    tg.computeVertexNormals();
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    this.terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.paintTerrain();

    // Water surface
    const wg = tg.clone();
    wg.deleteAttribute('color');
    wg.deleteAttribute('normal');
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const da = new THREE.BufferAttribute(new Float32Array(n * n), 1);
    da.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aDepth', da);
    this.waterMat = makeWaterMaterial(sun.position, sky);
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.scene.add(this.water);

    this.buildHouses();
    this.buildPalms();
    this.buildOutfall();
    this.scene.add(this.props);

    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 3;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    // Rain streaks
    const rp = new Float32Array(this.rainCount * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    for (let k = 0; k < this.rainCount; k++) this.resetDrop(rp, k, Math.random() * 25);
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc8d6e4, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);

    // Splash particles for drain backflow, pumps and outfall discharge
    const MAXP = 500;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3).fill(-100), 3));
    for (let k = 0; k < MAXP; k++) this.partData.push({ v: new THREE.Vector3(), life: 0 });
    this.parts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe6f2ff, size: 0.13, transparent: true, opacity: 0.9 }));
    this.parts.frustumCulled = false;
    this.scene.add(this.parts);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  toWorld(i: number) {
    const n = this.n;
    return new THREE.Vector3((i % n) - n / 2 + 0.5, this.sim.elev[i] * VS, Math.floor(i / n) - n / 2 + 0.5);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
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
    this.cursor.position.set(p.x, p.y + 0.04, p.z);
    this.cursor.visible = true;
  }

  setLens(l: Lens) { this.lens = l; this.paintTerrain(); }

  paintTerrain() {
    const { sim, n } = this;
    const ca = this.terrain.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    const r = rng(7);
    for (let i = 0; i < n * n; i++) {
      if (this.lens === 'elevation') {
        const e = sim.elev[i];
        const t = Math.min(1, Math.max(0, (e - 1.5) / 3));
        c.setHSL(0.62 - 0.55 * t, 0.65, 0.42 + 0.12 * t);
        if (e > 0 && Math.abs(e - Math.round(e * 2) / 2) < 0.04) c.multiplyScalar(0.7); // half-foot contours
      } else {
        c.setHex(SURF_COL[sim.surface[i]]);
        const j = 0.94 + r() * 0.1;
        c.multiplyScalar(j);
        if (sim.surface[i] === S.Water) c.multiplyScalar(Math.max(0.45, 1 + sim.elev[i] * 0.12));
      }
      c.convertSRGBToLinear();
      ca.setXYZ(i, c.r, c.g, c.b);
    }
    ca.needsUpdate = true;
  }

  private buildHouses() {
    const hs = this.sim.houses;
    const wallG = new THREE.BoxGeometry(1, 1, 1);
    wallG.translate(0, 0.5, 0);
    const roofG = new THREE.ConeGeometry(1.25, 0.65, 4);
    roofG.rotateY(Math.PI / 4);
    roofG.translate(0, 0.325, 0);
    this.walls = new THREE.InstancedMesh(wallG, new THREE.MeshStandardMaterial({ roughness: 0.8 }), hs.length);
    this.roofs = new THREE.InstancedMesh(roofG, new THREE.MeshStandardMaterial({ color: 0x8e5a43, roughness: 0.7, flatShading: true }), hs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    hs.forEach((h, k) => {
      const ctr = new THREE.Vector3();
      for (const ci of h.cells) ctr.add(this.toWorld(ci));
      ctr.multiplyScalar(0.25);
      const y0 = h.ground * VS - 0.05;
      const top = h.floor * VS + 0.9;
      p.set(ctr.x, y0, ctr.z); s.set(1.6, top - y0, 1.6);
      this.walls.setMatrixAt(k, m.compose(p, q, s));
      p.set(ctr.x, top, ctr.z); s.set(1, 1, 1);
      this.roofs.setMatrixAt(k, m.compose(p, q, s));
      const col = new THREE.Color(HOUSE_COLS[k % HOUSE_COLS.length]);
      this.houseCols.push(col);
      this.houseFlooded.push(false);
      this.walls.setColorAt(k, col);
    });
    this.walls.castShadow = this.roofs.castShadow = true;
    this.walls.receiveShadow = true;
    this.scene.add(this.walls, this.roofs);
  }

  private buildPalms() {
    const { sim, n } = this;
    const r = rng(42);
    const spots: number[] = [];
    for (let tries = 0; tries < 800 && spots.length < 55; tries++) {
      const i = Math.floor(r() * n * n);
      const x = i % n;
      if (sim.surface[i] !== S.Grass && !(sim.surface[i] === S.Sand && x < 41)) continue;
      if (spots.some(o => Math.abs((o % n) - x) + Math.abs(Math.floor(o / n) - Math.floor(i / n)) < 2)) continue;
      spots.push(i);
    }
    const trunkG = new THREE.CylinderGeometry(0.05, 0.08, 1.4, 5);
    trunkG.translate(0, 0.7, 0);
    const crownG = new THREE.ConeGeometry(0.75, 0.3, 7, 1, true);
    crownG.translate(0, 1.45, 0);
    const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x8a7255, roughness: 0.9 }), spots.length);
    const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0x4f8a3c, roughness: 0.8, flatShading: true, side: THREE.DoubleSide }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3();
    spots.forEach((i, k) => {
      const p = this.toWorld(i);
      e.set((r() - 0.5) * 0.25, r() * 6, (r() - 0.5) * 0.25);
      q.setFromEuler(e);
      const sc = 0.8 + r() * 0.5;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      trunks.setMatrixAt(k, m);
      crowns.setMatrixAt(k, m);
    });
    trunks.castShadow = crowns.castShadow = true;
    this.scene.add(trunks, crowns);
  }

  outfallPos = new THREE.Vector3();
  private buildOutfall() {
    const n = this.n;
    const g = new THREE.CylinderGeometry(0.2, 0.2, 1.2, 12, 1, true);
    g.rotateZ(Math.PI / 2);
    const pipe = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide }));
    this.outfallPos.set(6 - n / 2 + 0.5 - 0.6, this.sim.outfallElev * VS, OUTFALL_ROW - n / 2 + 0.5);
    pipe.position.copy(this.outfallPos);
    pipe.castShadow = true;
    this.scene.add(pipe);
    this.outfallPos.x -= 0.6;
  }

  rebuildProps() {
    this.props.clear();
    for (const d of this.sim.drains) {
      const p = this.toWorld(d.i);
      const g = new THREE.Mesh(this.geo.grate, this.mat.grate);
      g.position.set(p.x, p.y + 0.03, p.z);
      this.props.add(g);
      if (d.valve) {
        const v = new THREE.Mesh(this.geo.valve, this.mat.valve);
        v.rotation.x = -Math.PI / 2;
        v.position.set(p.x, p.y + 0.07, p.z);
        this.props.add(v);
      }
    }
    for (const pm of this.sim.pumps) {
      const p = this.toWorld(pm.i);
      const b = new THREE.Mesh(this.geo.pump, this.mat.pump);
      b.position.set(p.x, p.y + 0.22, p.z);
      b.castShadow = true;
      const st = new THREE.Mesh(this.geo.stack, this.mat.grate);
      st.position.set(p.x + 0.18, p.y + 0.6, p.z);
      this.props.add(b, st);
    }
  }

  private resetDrop(a: Float32Array, k: number, y: number) {
    const n = this.n;
    const x = (Math.random() - 0.5) * n, z = (Math.random() - 0.5) * n;
    a.set([x, y, z, x + 0.08, y + 0.7, z + 0.05], k * 6);
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, spread: number) {
    const k = this.partHead;
    this.partHead = (k + 1) % this.partData.length;
    const pa = this.parts.geometry.attributes.position as THREE.BufferAttribute;
    pa.setXYZ(k, pos.x + (Math.random() - 0.5) * 0.3, pos.y, pos.z + (Math.random() - 0.5) * 0.3);
    const d = this.partData[k];
    d.v.set(vel.x + (Math.random() - 0.5) * spread, vel.y * (0.7 + Math.random() * 0.5), vel.z + (Math.random() - 0.5) * spread);
    d.life = 0.7;
  }

  update(dt: number, t: number) {
    const { sim, n } = this;
    this.controls.update();
    this.waterMat.uniforms.uTime.value = t;

    // Water surface from sim depth
    const wp = this.water.geometry.attributes.position as THREE.BufferAttribute;
    const wd = this.water.geometry.attributes.aDepth as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) {
      const d = sim.water[i];
      wp.setY(i, d > 0.004 ? (sim.elev[i] + d) * VS : sim.elev[i] * VS - 0.03);
      wd.setX(i, d);
    }
    wp.needsUpdate = true;
    wd.needsUpdate = true;

    // Houses turn red while water is above the floor
    sim.houses.forEach((h, k) => {
      const f = h.depth > 0.001;
      if (f !== this.houseFlooded[k]) {
        this.houseFlooded[k] = f;
        this.walls.setColorAt(k, f ? FLOOD_COL : this.houseCols[k]);
        this.walls.instanceColor!.needsUpdate = true;
      }
    });

    // Rain
    const vis = Math.round(Math.min(1, sim.rain / 4) * this.rainCount);
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

    // Particles
    const up = new THREE.Vector3(0, 2.2, 0);
    for (const d of sim.drains) {
      if (d.flow < -0.01 && Math.random() < Math.min(1, -d.flow * 3)) {
        const p = this.toWorld(d.i); p.y += sim.water[d.i] * VS;
        this.spawn(p, up, 0.6);
      }
    }
    for (const pm of sim.pumps) {
      if (pm.flow > 0.02 && Math.random() < 0.5) {
        const p = this.toWorld(pm.i); p.y += 0.8; p.x += 0.18;
        this.spawn(p, new THREE.Vector3(-0.8, 1.2, 0), 0.4);
      }
    }
    const outflow = sim.drains.reduce((s, d) => s + Math.max(0, d.flow), 0) + sim.pumps.reduce((s, p) => s + p.flow, 0);
    if (outflow > 0.05 && Math.random() < Math.min(1, outflow)) this.spawn(this.outfallPos, new THREE.Vector3(-2.2, 0.6, 0), 0.4);
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

    this.renderer.render(this.scene, this.camera);
  }
}
