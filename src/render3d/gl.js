// A small WebGL2 renderer for the 3D view, no library. Instanced rounded
// boxes (true bevels whatever the size), cylinders and capsules, each with
// a full rotation, lit in linear light by a key light, a fill light, a
// rim light and the sky, then tone-mapped (filmic) to sRGB with fog to
// black. Soft contact shadows and coloured floor glows are blurred
// rounded rectangles on the floor. The route ribbon is drawn once
// additively and once more into a half-size buffer that is blurred and
// added on top, masked by whatever stands in front of it. Parts between
// the camera and the followed robot are thinned out with a dither so the
// robot is always in view. A vignette goes on last; the canvas's own
// multisampling smooths the edges.

import { STRIDE } from "./models.js";

const COMMON = `
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uFocus;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toneMap(vec3 x) {
  // Narkowicz's fit of the ACES filmic curve
  x *= 0.9;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toScreen(vec3 linear) { return pow(toneMap(linear), vec3(1.0 / 2.2)); }
float fogAmount(vec3 world) {
  float d = distance(world, uEye) * uFogDensity;
  return 1.0 - exp(-d * d);
}`;

const LIT_VS = `#version 300 es
layout(location=0) in vec3 aCore;
layout(location=1) in vec3 aDir;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iSize;
layout(location=4) in vec4 iQuat;
layout(location=5) in vec4 iColor;
layout(location=6) in vec2 iMat;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec3 vLocal;
out vec4 vColor;
out float vMat;
vec3 rot(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
void main() {
  float r = iMat.y;
  // a rounded box: the core box shrunk by the bevel, pushed out along the
  // vertex's offset direction; other meshes have r = 0
  vec3 local = aCore * (iSize * 0.5 - vec3(r)) + aDir * r;
  vec3 w = rot(iQuat, local) + iPos;
  vNormal = rot(iQuat, aDir);
  vWorld = w;
  vLocal = local;
  vColor = iColor;
  vMat = iMat.x;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vLocal;
in vec4 vColor;
in float vMat;
uniform vec3 uKey;
uniform vec3 uFill;
uniform float uMask;
${COMMON}
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  float mat = vMat;
  bool fades = mat >= 99.5;
  if (fades) mat -= 100.0;
  if (fades) {
    // between the camera and the robot it follows: keep a fifth of the
    // pixels, in an ordered dither, so the robot shows through
    vec3 d = uFocus - uEye;
    vec3 e = vWorld - uEye;
    float t = dot(e, d) / dot(d, d);
    float alpha = 1.0;
    if (t > 0.0 && t < 0.92) {
      float dist = length(uEye + d * t - vWorld);
      float radius = 0.5 + 0.5 * t;
      alpha = 0.2 + 0.8 * smoothstep(radius * 0.7, radius, dist);
    }
    alpha = min(alpha, 0.2 + 0.8 * smoothstep(0.8, 1.6, length(e)));
    ivec2 px = ivec2(gl_FragCoord.xy) & 3;
    if (alpha < 1.0 && (BAYER[px.y * 4 + px.x] + 0.5) / 16.0 > alpha) discard;
  }
  if (uMask > 0.5) {
    outColor = vec4(1.0);
    return;
  }
  vec3 base = toLinear(vColor.rgb);
  vec3 col;
  if (mat > 0.5 && mat < 1.5) {
    col = base * 1.6;
  } else {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(uEye - vWorld);
    if (mat > 3.5 && mat < 4.5) {
      // concrete: two scales of faint noise
      base *= 0.86 + 0.18 * noise(vWorld.xz * 3.0) + 0.08 * noise(vWorld.xz * 23.0);
    } else if (mat > 4.5 && mat < 5.5) {
      // rack upright: a column of punched holes on its faces
      float holes = step(0.55, fract(vLocal.y / 0.05)) * step(abs(vLocal.x), 0.012);
      base *= 1.0 - 0.45 * holes;
    } else if (mat > 5.5 && mat < 6.5) {
      base *= 0.94 + 0.1 * noise(vec2(vLocal.x + vLocal.z, vLocal.y) * 40.0);
    }
    vec3 sky = mix(vec3(0.035, 0.035, 0.04), vec3(0.2, 0.21, 0.24), n.y * 0.5 + 0.5);
    float key = max(dot(n, uKey), 0.0);
    float fill = max(dot(n, uFill), 0.0);
    col = base * (sky + key * vec3(1.05, 1.02, 0.98) + fill * vec3(0.22, 0.24, 0.3));
    float spec = 0.0;
    if (mat > 1.5 && mat < 3.5) {
      float shininess = mat > 2.5 ? 60.0 : 32.0;
      spec = pow(max(dot(n, normalize(uKey + v)), 0.0), shininess) * (mat > 2.5 ? 0.5 : 0.28);
    }
    col += spec * vec3(1.0);
    // a cool rim so silhouettes come off the dark floor
    if (mat < 3.5 || mat > 4.5) {
      float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * (mat > 6.5 ? 0.04 : 0.16);
      col += rim * vec3(0.55, 0.62, 0.8);
      // contact darkening near the floor, a cheap stand-in for occlusion
      col *= mix(0.45, 1.0, smoothstep(0.0, 0.35, vWorld.y));
    }
  }
  col = mix(col, toLinear(uFogColor), fogAmount(vWorld));
  outColor = vec4(toScreen(col), 1.0);
}`;

const FLAT_VS = `#version 300 es
layout(location=0) in vec3 aCore;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iSize;
layout(location=4) in vec4 iQuat;
layout(location=5) in vec4 iColor;
layout(location=6) in vec2 iMat;
uniform mat4 uViewProj;
out vec2 vLocal;
out vec2 vHalf;
out vec4 vColor;
out float vSoft;
out vec3 vWorld;
vec3 rot(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
void main() {
  vec2 p = aCore.xz * 0.5 * iSize.xz;
  vec3 w = rot(iQuat, vec3(p.x, 0.0, p.y)) + vec3(iPos.x, iPos.y + 0.004, iPos.z);
  vLocal = p;
  vHalf = iSize.xz * 0.5;
  vColor = iColor;
  vSoft = iMat.y;
  vWorld = w;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const FLAT_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vColor;
in float vSoft;
in vec3 vWorld;
${COMMON}
out vec4 outColor;
void main() {
  // a rounded rectangle with a soft edge
  vec2 q = abs(vLocal) - (vHalf - vSoft);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float a = vColor.a * (1.0 - smoothstep(-vSoft * 0.7, vSoft, d)) * (1.0 - fogAmount(vWorld));
  outColor = vec4(vColor.rgb * a, a);
}`;

const STRIP_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aAttr;
uniform mat4 uViewProj;
out vec2 vAttr;
out vec3 vWorld;
void main() {
  vAttr = aAttr;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const RIBBON_FS = `#version 300 es
precision highp float;
in vec2 vAttr;
in vec3 vWorld;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uLength;
uniform float uCore;
${COMMON}
out vec4 outColor;
void main() {
  float across = vAttr.x;
  float s = vAttr.y;
  float profile = mix(exp(-across * across * 2.5), 1.0 - smoothstep(0.55, 1.0, abs(across)), uCore);
  // starts past the fork tips, so it never lies under the robot
  float fade = smoothstep(0.7, 1.3, s) * (1.0 - smoothstep(uLength * 0.55, uLength, s));
  outColor = vec4(uColor * profile * fade * uIntensity * (1.0 - fogAmount(vWorld)), 1.0);
}`;

const TINT_FS = `#version 300 es
precision highp float;
in vec2 vAttr;
in vec3 vWorld;
uniform vec4 uTint;
${COMMON}
out vec4 outColor;
void main() {
  float a = uTint.a * (1.0 - vAttr.y) * (1.0 - fogAmount(vWorld));
  outColor = vec4(uTint.rgb * a, a);
}`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270;
  c += (texture(uTex, vUv + uStep * 1.3846).rgb + texture(uTex, vUv - uStep * 1.3846).rgb) * 0.3162;
  c += (texture(uTex, vUv + uStep * 3.2308).rgb + texture(uTex, vUv - uStep * 3.2308).rgb) * 0.0703;
  outColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
uniform float uStrength;
out vec4 outColor;
void main() {
  float covered = texture(uMaskTex, vUv).r;
  outColor = vec4(texture(uTex, vUv).rgb * uStrength * (1.0 - covered), 1.0);
}`;

const VIGNETTE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uAspect;
out vec4 outColor;
void main() {
  float d = length((vUv - 0.5) * uAspect) / length(0.5 * uAspect);
  outColor = vec4(vec3(mix(1.0, 0.6, smoothstep(0.45, 1.0, d))), 1.0);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    uniforms[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, uniforms };
}

// ------------------------------------------------------------- meshes
// Every mesh gives each vertex a core position (-1..1 per axis, scaled by
// half the instance size minus the bevel) and an offset direction, which
// is also the normal. A plain mesh has its position as the core and a
// bevel of zero.

/** A rounded box: flat faces, quarter-round edges, eighth-sphere corners. */
function roundedBox(seg = 4) {
  const core = [];
  const dir = [];
  const quad = (a, b, c, d) => {
    for (const v of [a, b, c, a, c, d]) {
      core.push(...v[0]);
      dir.push(...v[1]);
    }
  };
  // faces
  const axes = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  for (const [i, j, k] of axes) {
    for (const s of [-1, 1]) {
      const n = [0, 0, 0];
      n[i] = s;
      const v = (a, b) => {
        const c = [0, 0, 0];
        c[i] = s;
        c[j] = a;
        c[k] = b;
        return [c, n];
      };
      if (s > 0) quad(v(-1, -1), v(1, -1), v(1, 1), v(-1, 1));
      else quad(v(-1, -1), v(-1, 1), v(1, 1), v(1, -1));
    }
  }
  // edges: along axis i, between faces j and k
  for (const [i, j, k] of axes) {
    for (const sj of [-1, 1]) {
      for (const sk of [-1, 1]) {
        for (let m = 0; m < seg; m++) {
          const a0 = (m / seg) * (Math.PI / 2);
          const a1 = ((m + 1) / seg) * (Math.PI / 2);
          const v = (t, a) => {
            const c = [0, 0, 0];
            const d = [0, 0, 0];
            c[i] = t;
            c[j] = sj;
            c[k] = sk;
            d[j] = sj * Math.cos(a);
            d[k] = sk * Math.sin(a);
            return [c, d];
          };
          quad(v(-1, a0), v(1, a0), v(1, a1), v(-1, a1));
        }
      }
    }
  }
  // corners
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const c = [sx, sy, sz];
        for (let m = 0; m < seg; m++) {
          for (let n = 0; n < seg; n++) {
            const p = (u, w) => {
              const th = (u / seg) * (Math.PI / 2);
              const ph = (w / seg) * (Math.PI / 2);
              return [c, [sx * Math.cos(ph) * Math.cos(th), sy * Math.sin(ph), sz * Math.cos(ph) * Math.sin(th)]];
            };
            quad(p(m, n), p(m + 1, n), p(m + 1, n + 1), p(m, n + 1));
          }
        }
      }
    }
  }
  return { core, dir };
}

/** A shape turned round the y axis: (radius, y, normal radius, normal y), centered. */
function lathe(profile, segments = 20) {
  const core = [];
  const dir = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    for (let k = 0; k < profile.length - 1; k++) {
      const [r0, y0, nr0, ny0] = profile[k];
      const [r1, y1, nr1, ny1] = profile[k + 1];
      const v = (r, y, a, nr, ny) => {
        core.push(Math.cos(a) * r * 2, (y - 0.5) * 2, Math.sin(a) * r * 2);
        const l = Math.hypot(nr, ny) || 1;
        dir.push((Math.cos(a) * nr) / l, ny / l, (Math.sin(a) * nr) / l);
      };
      v(r0, y0, a0, nr0, ny0);
      v(r1, y1, a1, nr1, ny1);
      v(r1, y1, a0, nr1, ny1);
      v(r0, y0, a0, nr0, ny0);
      v(r0, y0, a1, nr0, ny0);
      v(r1, y1, a1, nr1, ny1);
    }
  }
  return { core, dir };
}

const cylinderMesh = () => lathe([[0, 0, 0, -1], [0.5, 0, 0, -1], [0.5, 0, 1, 0], [0.5, 1, 1, 0], [0.5, 1, 0, 1], [0, 1, 0, 1]], 24);

function capsuleMesh() {
  const prof = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    prof.push([Math.cos(a) * 0.5, 0.25 + Math.sin(a) * 0.25, Math.cos(a), Math.sin(a) * 2]);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    prof.push([Math.cos(a) * 0.5, 0.75 + Math.sin(a) * 0.25, Math.cos(a), Math.sin(a) * 2]);
  }
  return lathe(prof, 20);
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 isn't available");
    this.gl = gl;
    this.canvas = canvas;
    this.lit = compile(gl, LIT_VS, LIT_FS);
    this.flat = compile(gl, FLAT_VS, FLAT_FS);
    this.ribbon = compile(gl, STRIP_VS, RIBBON_FS);
    this.tint = compile(gl, STRIP_VS, TINT_FS);
    this.blur = compile(gl, QUAD_VS, BLUR_FS);
    this.composite = compile(gl, QUAD_VS, COMPOSITE_FS);
    this.vignette = compile(gl, QUAD_VS, VIGNETTE_FS);
    this.meshes = { rbox: this.mesh(roundedBox()), cyl: this.mesh(cylinderMesh()), cap: this.mesh(capsuleMesh()) };
    this.quad = this.mesh({ core: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, 1], dir: new Array(18).fill(0) });
    this.screen = gl.createVertexArray();
    gl.bindVertexArray(this.screen);
    const sb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.stripVao = gl.createVertexArray();
    this.stripBuf = gl.createBuffer();
    gl.bindVertexArray(this.stripVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stripBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.buffers = new Map();
    this.glow = null;
  }

  mesh({ core, dir }) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const n = core.length / 3;
    const data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      data[i * 6] = core[i * 3];
      data[i * 6 + 1] = core[i * 3 + 1];
      data[i * 6 + 2] = core[i * 3 + 2];
      data[i * 6 + 3] = dir[i * 3];
      data[i * 6 + 4] = dir[i * 3 + 1];
      data[i * 6 + 5] = dir[i * 3 + 2];
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    for (let loc = 2; loc <= 6; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, count: n };
  }

  /** Upload instance data under a name; static data only once. */
  upload(name, instances, dynamic = true) {
    const gl = this.gl;
    let entry = this.buffers.get(name);
    if (!entry) {
      entry = { buf: gl.createBuffer(), count: 0, size: 0 };
      this.buffers.set(name, entry);
    } else if (!dynamic) return entry;
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buf);
    const data = instances.used;
    if (data.byteLength > entry.size) {
      gl.bufferData(gl.ARRAY_BUFFER, Math.max(data.byteLength * 2, 64), gl.DYNAMIC_DRAW);
      entry.size = Math.max(data.byteLength * 2, 64);
    }
    if (data.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    entry.count = instances.count;
    return entry;
  }

  draw(mesh, entry) {
    if (!entry || !entry.count) return;
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buf);
    const B = STRIDE * 4;
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, B, 0);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, B, 12);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, B, 24);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, B, 40);
    gl.vertexAttribPointer(6, 2, gl.FLOAT, false, B, 56);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, entry.count);
  }

  resize(width, height) {
    const gl = this.gl;
    this.width = width;
    this.height = height;
    const gw = Math.max(1, Math.round(width / 2));
    const gh = Math.max(1, Math.round(height / 2));
    if (this.glow && this.glow.w === gw && this.glow.h === gh) return;
    const target = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    };
    this.glow = { w: gw, h: gh, a: target(), b: target() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  use(prog, frame) {
    const gl = this.gl;
    const u = prog.uniforms;
    gl.useProgram(prog.prog);
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
    if (u.uEye) gl.uniform3fv(u.uEye, frame.eye);
    if (u.uFogColor) gl.uniform3fv(u.uFogColor, frame.fogColor);
    if (u.uFogDensity) gl.uniform1f(u.uFogDensity, frame.fogDensity);
    if (u.uFocus) gl.uniform3fv(u.uFocus, frame.focus);
  }

  strip(points, width, y) {
    // two vertices per point, across -1 and +1, then the distance along
    const data = new Float32Array(points.length * 2 * 5);
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const nx = -tz * width * 0.5;
      const nz = tx * width * 0.5;
      const p = points[i];
      data.set([p.x + nx, y, p.z + nz, -1, p.s, p.x - nx, y, p.z - nz, 1, p.s], i * 10);
    }
    return data;
  }

  /** Triangles given as (x, y, z) corners, the first of each three bright. */
  tris(points3, tint, frame) {
    const gl = this.gl;
    this.use(this.tint, frame);
    gl.uniform4fv(this.tint.uniforms.uTint, tint);
    const n = points3.length / 3;
    const data = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) data.set([points3[i * 3], points3[i * 3 + 1], points3[i * 3 + 2], 0, i % 3 === 0 ? 0 : 1], i * 5);
    gl.bindVertexArray(this.stripVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stripBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, n);
  }

  /** Draw a frame of the scene (see View3D for what's in it). */
  render(frame) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const [r, g, b] = frame.clear;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    const lit = this.lit;
    this.use(lit, frame);
    gl.uniform3fv(lit.uniforms.uKey, frame.key);
    gl.uniform3fv(lit.uniforms.uFill, frame.fill);
    gl.uniform1f(lit.uniforms.uMask, 0);
    const st = frame.scene.static;
    const dy = frame.scene.dynamic;
    this.draw(this.meshes.rbox, this.upload("s-floor", st.floor, false));
    const solids = [
      [this.meshes.rbox, this.upload("s-rbox", st.rbox, false)],
      [this.meshes.cyl, this.upload("s-cyl", st.cyl, false)],
      [this.meshes.rbox, this.upload("d-rbox", dy.rbox)],
      [this.meshes.cyl, this.upload("d-cyl", dy.cyl)],
      [this.meshes.cap, this.upload("d-cap", dy.cap)],
    ];
    for (const [mesh, entry] of solids) this.draw(mesh, entry);

    // soft shadows (darkening) and floor glows (adding light), no depth writes
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    this.use(this.flat, frame);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    this.draw(this.quad, this.upload("s-shadows", st.shadows, false));
    this.draw(this.quad, this.upload("d-shadows", dy.shadows));
    gl.blendFunc(gl.ONE, gl.ONE);
    this.draw(this.quad, this.upload("s-glows", st.glows, false));
    this.draw(this.quad, this.upload("d-glows", dy.glows));

    // safety fan and laser: light, added
    const fan = frame.scene.fan;
    if (fan && fan.tris.length) {
      const pts = [];
      for (let i = 0; i < fan.tris.length; i += 2) pts.push(fan.tris[i], 0.008, fan.tris[i + 1]);
      this.tris(pts, fan.tint, frame);
    }
    if (frame.scene.laser) this.tris(frame.scene.laser, [0.25, 0.55, 1.0, 0.55], frame);

    // the route: an additive core on the floor
    const rib = frame.scene.ribbon;
    if (rib && rib.points.length > 1) {
      this.use(this.ribbon, frame);
      const u = this.ribbon.uniforms;
      gl.uniform3fv(u.uColor, [0.16, 0.42, 1.0]);
      gl.uniform1f(u.uLength, rib.points[rib.points.length - 1].s + 0.01);
      gl.uniform1f(u.uIntensity, rib.intensity);
      gl.uniform1f(u.uCore, 1);
      gl.bindVertexArray(this.stripVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stripBuf);
      const strip = this.strip(rib.points, 0.34, 0.012);
      gl.bufferData(gl.ARRAY_BUFFER, strip, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, strip.length / 5);

      // its glow: wider, half size, blurred, added on top
      const G = this.glow;
      gl.disable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.a.fb);
      gl.viewport(0, 0, G.w, G.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.uCore, 0);
      gl.uniform1f(u.uIntensity, rib.intensity * 0.9);
      const wide = this.strip(rib.points, 0.9, 0.012);
      gl.bufferData(gl.ARRAY_BUFFER, wide, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, wide.length / 5);
      gl.disable(gl.BLEND);
      gl.useProgram(this.blur.prog);
      gl.bindVertexArray(this.screen);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.blur.uniforms.uTex, 0);
      for (const [src, dst, dx, dy2] of [[G.a, G.b, 1, 0], [G.b, G.a, 0, 1], [G.a, G.b, 2, 0], [G.b, G.a, 0, 2]]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.blur.uniforms.uStep, dx / G.w, dy2 / G.h);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      // what stands in front of the ribbon on screen masks its glow
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.b.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.use(lit, frame);
      gl.uniform1f(lit.uniforms.uMask, 1);
      for (const [mesh, entry] of solids) this.draw(mesh, entry);
      gl.uniform1f(lit.uniforms.uMask, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.composite.prog);
      gl.bindVertexArray(this.screen);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, G.b.tex);
      gl.uniform1i(this.composite.uniforms.uMaskTex, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, G.a.tex);
      gl.uniform1i(this.composite.uniforms.uTex, 0);
      gl.uniform1f(this.composite.uniforms.uStrength, 1.15);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // a vignette, multiplied over everything
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.useProgram(this.vignette.prog);
    gl.uniform2f(this.vignette.uniforms.uAspect, this.width / this.height, 1);
    gl.bindVertexArray(this.screen);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}

/** The fog color as it lands on screen after the tone curve, for the clear color. */
export function screenFog([r, g, b]) {
  const curve = (x) => {
    const lin = Math.pow(x, 2.2) * 0.9;
    const t = Math.min(1, Math.max(0, (lin * (2.51 * lin + 0.03)) / (lin * (2.43 * lin + 0.59) + 0.14)));
    return Math.pow(t, 1 / 2.2);
  };
  return [curve(r), curve(g), curve(b)];
}
