// A small WebGL2 renderer for the 3D view, no library: instanced boxes,
// cylinders and capsules lit by a sun and a sky (hemisphere) light, soft
// contact shadows as blurred rounded rectangles on the floor, fog to black,
// a translucent safety fan, and the route ribbon drawn once additively and
// once more into a half-size buffer that is blurred and added on top for
// the glow. Edges are smoothed by the canvas's own multisampling.

import { STRIDE } from "./scene.js";

const LIT_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iSize;
layout(location=4) in float iYaw;
layout(location=5) in vec4 iColor;
layout(location=6) in float iKind;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColor;
out float vKind;
void main() {
  vec3 p = aPos * iSize;
  float c = cos(iYaw), s = sin(iYaw);
  vec3 w = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c) + iPos;
  vNormal = vec3(aNormal.x * c - aNormal.z * s, aNormal.y, aNormal.x * s + aNormal.z * c);
  vWorld = w;
  vColor = iColor;
  vKind = iKind;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const FOG = `
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDensity;
vec3 fogged(vec3 col, vec3 world) {
  float d = distance(world, uEye) * uFogDensity;
  return mix(col, uFogColor, 1.0 - exp(-d * d));
}`;

const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vColor;
in float vKind;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uMask;
${FOG}
out vec4 outColor;
void main() {
  // as a mask for the glow pass: anything solid covers the ribbon behind it
  if (uMask > 0.5) {
    outColor = vec4(1.0);
    return;
  }
  vec3 col;
  if (vKind > 0.5 && vKind < 1.5) {
    col = vColor.rgb;
  } else {
    vec3 n = normalize(vNormal);
    vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
    float sun = max(dot(n, uSun), 0.0);
    col = vColor.rgb * (hemi + sun * uSunColor);
    if (vKind > 1.5) {
      vec3 v = normalize(uEye - vWorld);
      float spec = pow(max(dot(n, normalize(uSun + v)), 0.0), 40.0);
      col += spec * 0.35 * uSunColor;
    }
    // contact darkening: surfaces near the floor get less of the sky
    col *= mix(0.55, 1.0, smoothstep(0.0, 0.45, vWorld.y));
  }
  outColor = vec4(fogged(col, vWorld), 1.0);
}`;

const SHADOW_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iSize;
layout(location=4) in float iYaw;
layout(location=5) in vec4 iColor;
layout(location=6) in float iKind;
uniform mat4 uViewProj;
out vec2 vLocal;
out vec2 vHalf;
out float vAlpha;
out float vSoft;
out vec3 vWorld;
void main() {
  vec2 p = aPos.xz * iSize.xz;
  float c = cos(iYaw), s = sin(iYaw);
  vec3 w = vec3(p.x * c - p.y * s, 0.004, p.x * s + p.y * c) + vec3(iPos.x, 0.0, iPos.z);
  vLocal = p;
  vHalf = iSize.xz * 0.5;
  vAlpha = iColor.a;
  vSoft = iKind;
  vWorld = w;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in float vAlpha;
in float vSoft;
in vec3 vWorld;
${FOG}
out vec4 outColor;
void main() {
  // a rounded rectangle with a soft edge
  vec2 q = abs(vLocal) - (vHalf - vSoft);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float a = vAlpha * (1.0 - smoothstep(-vSoft * 0.6, vSoft, d));
  float f = distance(vWorld, uEye) * uFogDensity;
  outColor = vec4(0.0, 0.0, 0.0, a * exp(-f * f));
}`;

const RIBBON_VS = `#version 300 es
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
${FOG}
out vec4 outColor;
void main() {
  float across = vAttr.x;
  float s = vAttr.y;
  float profile = mix(exp(-across * across * 2.5), 1.0 - smoothstep(0.55, 1.0, abs(across)), uCore);
  // starts past the fork tips, so the glow never lies over the robot
  float fade = smoothstep(0.7, 1.3, s) * (1.0 - smoothstep(uLength * 0.55, uLength, s));
  float f = distance(vWorld, uEye) * uFogDensity;
  outColor = vec4(uColor * profile * fade * uIntensity * exp(-f * f), 1.0);
}`;

const FAN_FS = `#version 300 es
precision highp float;
in vec2 vAttr;
in vec3 vWorld;
uniform vec4 uTint;
${FOG}
out vec4 outColor;
void main() {
  float f = distance(vWorld, uEye) * uFogDensity;
  outColor = vec4(uTint.rgb, uTint.a * (1.0 - vAttr.y) * exp(-f * f));
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
  // nine-tap gaussian
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
    uniforms[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, uniforms };
}

// ------------------------------------------------------------- meshes

function cube() {
  const p = [];
  const n = [];
  const faces = [
    [[1, 0, 0], [0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]],
    [[-1, 0, 0], [-0.5, 0, 0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5]],
    [[0, 1, 0], [-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]],
    [[0, -1, 0], [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]],
    [[0, 0, 1], [0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]],
    [[0, 0, -1], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]],
  ];
  for (const [normal, a, b, c, d] of faces) {
    for (const v of [a, b, c, a, c, d]) {
      p.push(...v);
      n.push(...normal);
    }
  }
  return { p, n };
}

/** A shape turned round the y axis: points (radius, y, normal radius, normal y). */
function lathe(profile, segments = 18) {
  const p = [];
  const n = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    for (let k = 0; k < profile.length - 1; k++) {
      const [r0, y0, nr0, ny0] = profile[k];
      const [r1, y1, nr1, ny1] = profile[k + 1];
      const v = (r, y, a, nr, ny) => {
        p.push(Math.cos(a) * r, y, Math.sin(a) * r);
        n.push(Math.cos(a) * nr, ny, Math.sin(a) * nr);
      };
      v(r0, y0, a0, nr0, ny0);
      v(r1, y1, a1, nr1, ny1);
      v(r1, y1, a0, nr1, ny1);
      v(r0, y0, a0, nr0, ny0);
      v(r0, y0, a1, nr0, ny0);
      v(r1, y1, a1, nr1, ny1);
    }
  }
  return { p, n };
}

function cylinder() {
  return lathe([[0, 0, 0, -1], [0.5, 0, 0, -1], [0.5, 0, 1, 0], [0.5, 1, 1, 0], [0.5, 1, 0, 1], [0, 1, 0, 1]], 20);
}

function capsule() {
  const prof = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    prof.push([Math.cos(a) * 0.5, 0.25 + Math.sin(a) * 0.25, Math.cos(a), Math.sin(a)]);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    prof.push([Math.cos(a) * 0.5, 0.75 + Math.sin(a) * 0.25, Math.cos(a), Math.sin(a)]);
  }
  return lathe(prof, 18);
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 isn't available");
    this.gl = gl;
    this.canvas = canvas;
    this.lit = compile(gl, LIT_VS, LIT_FS);
    this.shadow = compile(gl, SHADOW_VS, SHADOW_FS);
    this.ribbon = compile(gl, RIBBON_VS, RIBBON_FS);
    this.fan = compile(gl, RIBBON_VS, FAN_FS);
    this.blur = compile(gl, QUAD_VS, BLUR_FS);
    this.composite = compile(gl, QUAD_VS, COMPOSITE_FS);
    this.meshes = { box: this.mesh(cube()), cylinder: this.mesh(cylinder()), capsule: this.mesh(capsule()) };
    this.quadFloor = this.mesh({ p: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], n: new Array(18).fill(0) });
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

  mesh({ p, n }) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const data = new Float32Array(p.length * 2);
    for (let i = 0; i < p.length / 3; i++) {
      data.set(p.slice(i * 3, i * 3 + 3), i * 6);
      data.set(n.slice(i * 3, i * 3 + 3), i * 6 + 3);
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
    return { vao, count: p.length / 3 };
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
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength * 2, gl.DYNAMIC_DRAW);
      entry.size = data.byteLength * 2;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    entry.count = instances.count;
    return entry;
  }

  drawInstances(mesh, entry) {
    if (!entry || !entry.count) return;
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buf);
    const B = STRIDE * 4;
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, B, 0);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, B, 12);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, B, 24);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, B, 28);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, B, 44);
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

  setCommon(prog, frame) {
    const gl = this.gl;
    const u = prog.uniforms;
    gl.useProgram(prog.prog);
    gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
    if (u.uEye) gl.uniform3fv(u.uEye, frame.eye);
    if (u.uFogColor) gl.uniform3fv(u.uFogColor, frame.fogColor);
    if (u.uFogDensity) gl.uniform1f(u.uFogDensity, frame.fogDensity);
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

  /**
   * Draw a frame. `frame` has viewProj, eye, fog settings, and the scene:
   * static and dynamic instances, the ribbon points and how bright it is,
   * and the safety fan.
   */
  render(frame) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const [r, g, b] = frame.fogColor;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    const lit = this.lit;
    this.setCommon(lit, frame);
    gl.uniform3fv(lit.uniforms.uSun, frame.sun);
    gl.uniform3fv(lit.uniforms.uSunColor, [0.62, 0.62, 0.66]);
    gl.uniform3fv(lit.uniforms.uSky, [0.52, 0.53, 0.58]);
    gl.uniform3fv(lit.uniforms.uGround, [0.16, 0.16, 0.18]);
    gl.uniform1f(lit.uniforms.uMask, 0);
    const s = frame.scene;
    this.drawInstances(this.meshes.box, this.upload("static-floor", s.static.floor, false));
    this.drawInstances(this.meshes.box, this.upload("static-boxes", s.static.boxes, false));
    this.drawInstances(this.meshes.cylinder, this.upload("static-cyl", s.static.cylinders, false));
    this.drawInstances(this.meshes.box, this.upload("boxes", s.dynamic.boxes));
    this.drawInstances(this.meshes.cylinder, this.upload("cyl", s.dynamic.cylinders));
    this.drawInstances(this.meshes.capsule, this.upload("caps", s.dynamic.capsules));
    this.drawInstances(this.meshes.box, this.upload("points", s.dynamic.points));

    // soft shadows and the safety fan: blended, no depth writes
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.setCommon(this.shadow, frame);
    this.drawInstances(this.quadFloor, this.upload("static-shadows", s.static.shadows, false));
    this.drawInstances(this.quadFloor, this.upload("shadows", s.dynamic.shadows));
    if (s.fan && s.fan.tris.length) {
      this.setCommon(this.fan, frame);
      gl.uniform4fv(this.fan.uniforms.uTint, s.fan.tint);
      const data = new Float32Array((s.fan.tris.length / 2) * 5);
      for (let i = 0; i < s.fan.tris.length / 2; i++) {
        const first = i % 3 === 0;
        data.set([s.fan.tris[i * 2], 0.008, s.fan.tris[i * 2 + 1], 0, first ? 0 : 1], i * 5);
      }
      gl.bindVertexArray(this.stripVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stripBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
    }

    // the route: an additive core on the floor
    const rib = s.ribbon;
    if (rib && rib.points.length > 1) {
      gl.blendFunc(gl.ONE, gl.ONE);
      this.setCommon(this.ribbon, frame);
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

      // and its glow: wider, into a half-size buffer, blurred, added on top
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
      for (const [src, dst, dx, dy] of [[G.a, G.b, 1, 0], [G.b, G.a, 0, 1], [G.a, G.b, 2, 0], [G.b, G.a, 0, 2]]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.blur.uniforms.uStep, dx / G.w, dy / G.h);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      // Everything standing on the floor that covers the ribbon on screen
      // is in front of it: draw those as a mask, so the glow stays behind
      // the robot and the racks instead of washing over them.
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.b.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.setCommon(lit, frame);
      gl.uniform1f(lit.uniforms.uMask, 1);
      this.drawInstances(this.meshes.box, this.buffers.get("static-boxes"));
      this.drawInstances(this.meshes.box, this.buffers.get("boxes"));
      this.drawInstances(this.meshes.cylinder, this.buffers.get("cyl"));
      this.drawInstances(this.meshes.capsule, this.buffers.get("caps"));
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
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
