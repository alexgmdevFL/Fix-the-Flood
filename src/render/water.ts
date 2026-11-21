import * as THREE from 'three';

// Water reads per-vertex depth from the sim. Depth drives color, transparency and edge foam.
export function makeWaterMaterial(sunDir: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uSun: { value: sunDir.clone().normalize() } },
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
      varying float vDepth;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        if (vDepth < 0.03) discard;
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;
        vec2 p = vWorld.xz;
        float r1 = noise(p * 1.6 + vec2(uTime * 0.35, uTime * 0.2)) + 0.5 * noise(p * 4.1 - uTime * 0.5);
        float r2 = noise(p * 2.9 - vec2(uTime * 0.25, uTime * 0.45)) + 0.5 * noise(p * 5.3 + uTime * 0.4);
        n = normalize(n + vec3((r1 - 0.75) * 0.22, 0.0, (r2 - 0.75) * 0.22));
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        vec3 sky = mix(vec3(0.80, 0.87, 0.92), vec3(0.32, 0.52, 0.78), clamp(R.y * 1.5, 0.0, 1.0));
        float d = clamp(vDepth / 4.0, 0.0, 1.0);
        vec3 flood = vec3(0.40, 0.43, 0.32);
        vec3 shallow = vec3(0.12, 0.48, 0.50);
        vec3 deep = vec3(0.02, 0.17, 0.26);
        vec3 col = mix(flood, shallow, smoothstep(0.2, 1.2, vDepth));
        col = mix(col, deep, sqrt(d));
        col = mix(col, sky, clamp(fres * 1.4, 0.0, 0.85));
        vec3 H = normalize(uSun + V);
        col += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, H), 0.0), 220.0) * 2.0;
        float foam = smoothstep(0.03, 0.07, vDepth) * (1.0 - smoothstep(0.1, 0.3, vDepth)) * smoothstep(0.55, 0.85, noise(p * 7.0 + uTime * 0.6) + 0.3 * noise(p * 15.0));
        col = mix(col, vec3(0.95), foam * 0.6);
        float a = smoothstep(0.03, 0.3, vDepth) * 0.55 + fres * 0.35 + 0.35 * d;
        a = clamp(max(a, foam * 0.7), 0.0, 0.96);
        gl_FragColor = vec4(col, a);
      }`,
  });
}
