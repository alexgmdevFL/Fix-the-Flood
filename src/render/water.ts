import * as THREE from 'three';

// Water reads per-vertex depth from the sim. Depth drives color, transparency and edge foam.
export function makeWaterMaterial(sunDir: THREE.Vector3, sky: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uSun: { value: sunDir.clone().normalize() }, uSky: { value: sky } },
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying float vDepth;
      varying vec3 vWorld;
      void main() {
        vDepth = aDepth;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSun;
      uniform vec3 uSky;
      varying float vDepth;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        if (vDepth < 0.008) discard;
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;
        vec2 p = vWorld.xz;
        float r1 = noise(p * 1.7 + vec2(uTime * 0.35, uTime * 0.2));
        float r2 = noise(p * 3.3 - vec2(uTime * 0.25, uTime * 0.45));
        n = normalize(n + vec3((r1 - 0.5) * 0.3, 0.0, (r2 - 0.5) * 0.3));
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        float d = clamp(vDepth / 4.0, 0.0, 1.0);
        vec3 flood = vec3(0.42, 0.47, 0.36);
        vec3 shallow = vec3(0.16, 0.52, 0.55);
        vec3 deep = vec3(0.02, 0.18, 0.32);
        vec3 col = mix(flood, shallow, smoothstep(0.2, 1.2, vDepth));
        col = mix(col, deep, sqrt(d));
        col = mix(col, uSky, fres * 0.55);
        vec3 H = normalize(uSun + V);
        col += pow(max(dot(n, H), 0.0), 140.0) * 1.4;
        float foam = (1.0 - smoothstep(0.02, 0.16, vDepth)) * smoothstep(0.35, 0.75, noise(p * 6.0 + uTime * 0.6));
        col = mix(col, vec3(0.95), foam * 0.75);
        float a = smoothstep(0.008, 0.25, vDepth) * 0.6 + fres * 0.25 + 0.15 * d;
        a = clamp(max(a, foam * 0.8), 0.0, 0.93);
        gl_FragColor = vec4(col, a);
      }`,
  });
}
