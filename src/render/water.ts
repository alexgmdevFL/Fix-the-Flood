import * as THREE from 'three';

// Water surface driven by the sim: per-vertex depth and flow velocity.
// Thin sheets read as a glossy wet film, deeper water gets color and transparency,
// ripples advect along the flow (two-phase flow map), rain draws ripple rings, fast flow foams.
export function makeWaterMaterial(sunDir: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uSun: { value: sunDir.clone().normalize() },
      uRain: { value: 0 },
      uDark: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aDepth;
      attribute vec2 aFlow;
      varying float vDepth;
      varying vec2 vFlow;
      varying vec3 vWorld;
      void main() {
        vDepth = aDepth;
        vFlow = aFlow;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRain;
      uniform float uDark;
      uniform vec3 uSun;
      varying float vDepth;
      varying vec2 vFlow;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float waves(vec2 uv) { return noise(uv * 1.3) + 0.5 * noise(uv * 2.7 + 3.1); }
      // Expanding rings from raindrops on a jittered grid
      float rings(vec2 p, float t) {
        vec2 g = p * 1.6;
        vec2 cell = floor(g);
        float acc = 0.0;
        for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
          vec2 c = cell + vec2(float(i), float(j));
          float h = hash(c);
          vec2 ctr = c + vec2(hash(c + 3.1), hash(c + 7.7));
          float ph = fract(t * 1.3 + h);
          float d = length(g - ctr) - ph * 0.8;
          acc += (1.0 - ph) * exp(-d * d * 90.0) * step(h, uRain);
        }
        return acc;
      }
      void main() {
        if (vDepth < 0.012) discard;
        vec2 p = vWorld.xz;
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;

        // Two-phase flow map so ripples travel with the water without stretching forever
        vec2 fl = clamp(vFlow * 60.0, -2.5, 2.5);
        float speed = length(fl);
        float t = uTime * 0.6;
        float ph0 = fract(t), ph1 = fract(t + 0.5);
        float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
        float h = mix(waves(p - fl * ph1 + 0.37), waves(p - fl * ph0), w0) + waves(p * 0.5 + uTime * 0.05) * 0.5;
        h += rings(p, uTime) * 0.35;
        vec2 grad = vec2(dFdx(h), dFdy(h));
        float rough = 0.5 + 0.4 * min(1.0, speed) + uRain * 0.3;
        grad = clamp(grad, -0.25, 0.25);
        n = normalize(n + vec3(-grad.x, 0.0, -grad.y) * rough * 0.9);

        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.3 + 0.7 * pow(1.0 - max(dot(n, V), 0.0), 4.0); // shallow sheets read as mirrors of the sky
        vec3 R = reflect(-V, n);
        vec3 skyTop = mix(vec3(0.36, 0.56, 0.82), vec3(0.42, 0.46, 0.50), uDark);
        vec3 skyHor = mix(vec3(0.82, 0.88, 0.93), vec3(0.66, 0.70, 0.73), uDark);
        vec3 sky = mix(skyHor, skyTop, clamp(R.y * 1.4, 0.0, 1.0));

        float d = clamp(vDepth / 4.0, 0.0, 1.0);
        vec3 tea = vec3(0.34, 0.31, 0.20);      // Florida floodwater, stained with tannins
        vec3 mid = vec3(0.10, 0.30, 0.31);
        vec3 deep = vec3(0.02, 0.14, 0.21);
        vec3 col = mix(tea, mid, smoothstep(0.15, 1.2, vDepth));
        col = mix(col, deep, sqrt(d));
        col *= 1.0 - 0.35 * uDark;
        col = mix(col, sky, clamp(fres, 0.0, 0.85));
        vec3 H = normalize(uSun + V);
        col += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, H), 0.0), 90.0) * 1.3 * (1.0 - 0.85 * uDark);

        float edge = smoothstep(0.02, 0.06, vDepth) * (1.0 - smoothstep(0.08, 0.28, vDepth));
        float churn = smoothstep(0.6, 2.0, speed) * smoothstep(0.05, 0.2, vDepth);
        float fn = noise(p * 3.2 - fl * uTime * 0.8) + 0.35 * noise(p * 6.5 + uTime * 0.3);
        float foam = max(edge, churn) * smoothstep(0.75, 1.15, fn);
        col = mix(col, vec3(0.9, 0.9, 0.86), foam * 0.55);

        float a = 0.45 + smoothstep(0.012, 0.25, vDepth) * 0.35 + fres * 0.2 + 0.2 * d;
        a = clamp(max(a, foam * 0.8), 0.0, 0.96);
        gl_FragColor = vec4(col, a);
      }`,
  });
}

/** Tileable wave normal map for the open sea. */
export function makeSeaNormals(size = 128) {
  const h = new Float32Array(size * size);
  const rnd = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let oct = 0, amp = 1, f = 4; oct < 4; oct++, amp *= 0.5, f *= 2) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const gx = (x / size) * f, gy = (y / size) * f;
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const w = (a: number, b: number) => rnd(((ix + a) % f), ((iy + b) % f) + oct * 17);
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      h[y * size + x] += amp * ((w(0, 0) * (1 - ux) + w(1, 0) * ux) * (1 - uy) + (w(0, 1) * (1 - ux) + w(1, 1) * ux) * uy);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = h[y * size + (x + 1) % size] - h[y * size + (x - 1 + size) % size];
    const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
    const v = new THREE.Vector3(-dx * 3, -dy * 3, 1).normalize();
    const o = (y * size + x) * 4;
    data[o] = (v.x * 0.5 + 0.5) * 255; data[o + 1] = (v.y * 0.5 + 0.5) * 255; data[o + 2] = (v.z * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}
