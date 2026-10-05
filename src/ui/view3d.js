// The 3D view: what the robot in focus sees, from a chase camera behind
// and above it, with a quiet HUD in the corners. It draws from the same
// interpolated sim state as the map, so both views move in step.

import { CELL, W, H, cellX, cellY, center } from "../sim/warehouse.js";
import { between } from "../render/interp.js";
import { SCAN_TIME } from "../sim/world.js";
import { ChaseCamera } from "../render3d/camera.js";
import { lookAt, multiply, perspective } from "../render3d/math.js";
import { buildDynamic, buildStatic, laserFan, ribbonPoints, safetyFan } from "../render3d/scene.js";
import { Looks } from "../render3d/looks.js";
import { Renderer, screenFog } from "../render3d/gl.js";

const FOG = [0.03, 0.03, 0.035];
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
// key light high and from the front left, fill low from the other side
const KEY = unit([-0.45, 0.8, -0.4]);
const FILL = unit([0.6, 0.35, 0.7]);
// contact shadows fall a little away from the key light
const SHADOW = [-KEY[0] * 0.14, -KEY[2] * 0.14];
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

const LIFTING = /^(facePick|raise|reach|lift|retract|putBack|putReach|putSet|retractEmpty|stow|mFace|mRaise|mReach|mLift|mStow|mStowEmpty|mPut)$/;
const DROPPING = /^(faceDock|dropRaise|dropReach|dropSet|dropRetract|confirm|mDrop)$/;

/** The HUD's one line of what the robot is doing. */
export function statusLine(r) {
  const job = r.job;
  if (r.manual && (r.phase === "idle" || r.phase === "carry")) return r.load ? "Carrying, driving by hand" : "Driving by hand";
  if (r.safety === "stop") return "Stopped · person ahead";
  if (r.waiting?.kind === "robot") return `Waiting · Robot ${r.waiting.id + 1} has the cells ahead`;
  if (r.waiting?.kind === "person") return "Waiting · person on the crossing";
  if (r.waiting?.kind === "plan") return "Waiting · letting another robot through";
  if (/scan/i.test(r.phase)) return "Scanning";
  if (LIFTING.test(r.phase)) return "Lifting";
  if (DROPPING.test(r.phase)) return `Setting down at Dock ${job?.dock?.id ?? ""}`.trim();
  if (r.phase === "toPick") return `Driving to Bay ${job.bay.id}${r.safety === "slow" ? " · slowing" : ""}`;
  if (r.phase === "toDrop") return `Driving to Dock ${job.dock.id}${r.safety === "slow" ? " · slowing" : ""}`;
  if (r.phase === "toCharge") return "Going to charge";
  if (r.phase === "charging") return `Charging · ${Math.round(r.battery * 100)} %`;
  if (r.phase === "toPark") return "Going to park";
  return "Parked";
}

export class View3D {
  constructor(root, { motion }) {
    this.root = root;
    this.motion = motion;
    this.canvas = root.querySelector("#scene3d");
    this.speed = root.querySelector("#hud-speed");
    this.mode = root.querySelector("#hud-mode");
    this.line = root.querySelector("#hud-line");
    this.wheel = root.querySelector("#hud-wheel");
    this.mini = root.querySelector("#minimap");
    this.camera = new ChaseCamera();
    this.looks = new Looks();
    this.idle = 0;
    this.orbit = null;
    this.renderer = null;
    this.error = null;
    this.staticScene = null;
    this.dpr = 1;
    this.frameTimes = [];
    this.region = { x: 0, y: 0, w: 1, h: 1 };
    this.viewProj = new Float32Array(16);
    this.shownSpeed = "";
    this.shownLine = "";
  }

  /** Try to start WebGL2. Returns false (and why) if it can't. */
  start() {
    if (this.renderer) return true;
    if (this.error) return false;
    try {
      this.renderer = new Renderer(this.canvas);
      this.applySize();
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.error = "The 3D view lost its graphics context";
        this.renderer = null;
        this.onLost?.();
      });
      return true;
    } catch (err) {
      this.error = err.message;
      return false;
    }
  }

  /** Fit the scene to the free part of the stage, at a pixel ratio that holds 60 fps. */
  place(region) {
    this.region = region;
    Object.assign(this.root.style, { left: `${region.x}px`, top: `${region.y}px`, width: `${region.w}px`, height: `${region.h}px` });
    const coarse = matchMedia("(pointer: coarse)").matches || region.w < 700;
    this.maxDpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    this.dpr = Math.min(this.dpr > 1 ? this.dpr : this.maxDpr, this.maxDpr);
    this.applySize();
  }

  applySize() {
    const { w, h } = this.region;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.renderer?.resize(this.canvas.width, this.canvas.height);
    this.miniBase = null;
  }

  /** Drop the pixel ratio a step when frames run long, so phones keep up. */
  adapt(ms) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length < 90) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    this.frameTimes.length = 0;
    if (p90 > 22 && this.dpr > 1) {
      this.dpr = Math.max(1, this.dpr - 0.25);
      this.applySize();
    }
  }

  render(world, focus, { alpha, dt, time }) {
    if (!this.renderer || !focus) return;
    if (!this.staticScene || this.staticScene.ws !== world.warehouse) {
      this.staticScene = { ws: world.warehouse, ...buildStatic(world.warehouse) };
      this.looks = new Looks();
      this.renderer.buffers.clear();
      this.miniBase = null;
    }
    const views = new Map();
    for (const r of world.robots) views.set(r, between(r, alpha));
    for (const w of world.workers) views.set(w, between(w, alpha));
    const v = views.get(focus);
    const reduced = this.motion.matches;
    // standing still a while, the camera drifts slowly round the robot
    const resting = Math.abs(focus.v) < 0.02 && /^(idle|parked|charging)$/.test(focus.phase);
    this.idle = resting ? this.idle + dt : 0;
    if (this.idle > 6 && !reduced) this.orbit = (this.orbit ?? this.camera.yaw) + dt * 0.12;
    else this.orbit = null;
    const cam = this.camera.update(v, dt, {
      yaw: reduced ? -Math.PI / 2 : this.orbit,
      moving: Math.abs(focus.v) > 0.15,
      speed: Math.min(1, Math.abs(focus.v) / 1.5),
    });
    const aspect = this.region.w / this.region.h;
    // phones in portrait get a wider lens, so the robot's surroundings fit
    const fov = aspect < 0.9 ? 1.0 : 0.82;
    multiply(perspective(fov, aspect, 0.1, 80), lookAt(cam.eye, cam.target), this.viewProj);
    const looks = this.looks.update(world, views, { dt, time, eye: cam.eye, reduced, shadow: SHADOW });
    const charging = new Set();
    for (const r of world.robots) {
      if (r.phase !== "charging" && !r.charging) continue;
      for (const c of world.warehouse.chargers) if (Math.hypot(cellX(c.cell) + 0.5 - r.x, cellY(c.cell) + 0.5 - r.y) < 0.6) charging.add(c.id);
    }
    const dynamic = buildDynamic(world, views, focus, { looks, eye: cam.eye, docks: this.looks.docks, time, charging });
    let ribbon = null;
    if (!focus.manual && /^to/.test(focus.phase)) {
      const waiting = !!focus.waiting;
      const pulse = waiting ? (reduced ? 0.45 : 0.4 + 0.25 * Math.sin(time * 5)) : 1;
      ribbon = { points: ribbonPoints(focus, v), intensity: pulse };
    }
    let laser = null;
    if (/scan/i.test(focus.phase) && focus.load && focus.timer < SCAN_TIME) {
      const t = Math.min(1, focus.timer / SCAN_TIME);
      laser = laserFan(v, reduced ? 0.5 : t < 0.5 ? ease(t * 2) : 1 - ease((t - 0.5) * 2));
    }
    const tint = focus.safety === "stop" ? [0.94, 0.27, 0.27, 0.3] : focus.safety === "slow" ? [0.96, 0.62, 0.04, 0.24] : [0.23, 0.51, 0.96, 0.08];
    this.renderer.render({
      viewProj: this.viewProj,
      eye: cam.eye,
      focus: [v.x, 0.45, v.y],
      key: KEY,
      fill: FILL,
      fogColor: FOG,
      clear: screenFog(FOG),
      fogDensity: 0.05,
      scene: { static: this.staticScene, dynamic, ribbon, laser, fan: { tris: safetyFan(focus, v), tint } },
    });
    this.hud(world, focus);
  }

  hud(world, r) {
    const speed = Math.abs(r.v).toFixed(1);
    if (speed !== this.shownSpeed) {
      this.speed.textContent = speed;
      this.shownSpeed = speed;
    }
    const line = statusLine(r);
    if (line !== this.shownLine) {
      this.line.textContent = line;
      this.shownLine = line;
    }
    const auto = !r.manual;
    this.mode.textContent = auto ? "Autonomous" : "Manual";
    this.mode.dataset.auto = String(auto);
    this.wheel.dataset.auto = String(auto);
    this.minimap(world, r);
  }

  minimap(world, focus) {
    const c = this.mini;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (!cw) return;
    if (c.width !== Math.round(cw * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      this.miniBase = null;
    }
    const s = Math.min((cw - 8) / (W - 1), (ch - 8) / (H - 1));
    const ox = (cw - (W - 1) * s) / 2 - s / 2;
    const oy = (ch - (H - 1) * s) / 2 - s / 2;
    const g = c.getContext("2d");
    if (!this.miniBase) {
      const base = document.createElement("canvas");
      base.width = c.width;
      base.height = c.height;
      const b = base.getContext("2d");
      b.scale(dpr, dpr);
      const ws = world.warehouse;
      for (let k = 0; k < ws.grid.length; k++) {
        const t = ws.grid[k];
        const color = t === CELL.LANE ? "rgba(255,255,255,.12)" : t === CELL.RACK ? "rgba(255,255,255,.32)" : t === CELL.DOCK ? "rgba(255,255,255,.5)" : null;
        if (!color) continue;
        b.fillStyle = color;
        b.fillRect(ox + cellX(k) * s, oy + cellY(k) * s, s, s);
      }
      this.miniBase = base;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.miniBase, 0, 0);
    g.scale(dpr, dpr);
    if (focus.path && /^to/.test(focus.phase)) {
      g.strokeStyle = "rgba(59,130,246,.9)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(ox + focus.x * s, oy + focus.y * s);
      for (let j = focus.i + 1; j < focus.path.length; j++) {
        const p = center(focus.path[j]);
        g.lineTo(ox + p.x * s, oy + p.y * s);
      }
      g.stroke();
    }
    for (const r of world.robots) {
      g.fillStyle = r === focus ? "#3b82f6" : "rgba(255,255,255,.75)";
      g.beginPath();
      g.arc(ox + r.x * s, oy + r.y * s, r === focus ? 2.6 : 2, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(245,158,11,.85)";
    for (const w of world.workers) g.fillRect(ox + w.x * s - 1, oy + w.y * s - 1, 2, 2);
  }
}

