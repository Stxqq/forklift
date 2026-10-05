// The 3D view: what the robot in focus sees, from a chase camera behind
// and above it, with a quiet HUD in the corners. It draws from the same
// interpolated sim state as the map, so both views move in step.

import { CELL, W, H, cellX, cellY, center } from "../sim/warehouse.js";
import { between } from "../render/interp.js";
import { status } from "../render/robot.js";
import { ChaseCamera } from "../render3d/camera.js";
import { lookAt, multiply, perspective } from "../render3d/math.js";
import { buildDynamic, buildStatic, ribbonPoints, safetyFan } from "../render3d/scene.js";
import { Renderer } from "../render3d/gl.js";

const FOG = [0.035, 0.035, 0.04];
const SUN = (() => {
  const v = [-0.35, 0.82, -0.45];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();

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
      this.renderer.buffers.clear();
      this.miniBase = null;
    }
    const views = new Map();
    for (const r of world.robots) views.set(r, between(r, alpha));
    for (const w of world.workers) views.set(w, between(w, alpha));
    const v = views.get(focus);
    const cam = this.camera.update(v, dt, { fixedYaw: this.motion.matches ? -Math.PI / 2 : null, moving: Math.abs(focus.v) > 0.15 });
    const aspect = this.region.w / this.region.h;
    // phones in portrait get a wider lens, so the robot's surroundings fit
    const fov = aspect < 0.9 ? 1.0 : 0.86;
    multiply(perspective(fov, aspect, 0.1, 80), lookAt(cam.eye, cam.target), this.viewProj);
    const moving = (r) => Math.abs(r.v) > 0.05 || Math.abs(r.w) > 0.05 || !!r.waiting;
    const dynamic = buildDynamic(world, views, focus, {
      time,
      statusColor: (r) => hexToRgba(status(r)),
      beacon: (r) => moving(r) && (this.motion.matches || Math.sin(time * 9) > -0.2),
    });
    let ribbon = null;
    if (!focus.manual && /^to/.test(focus.phase)) {
      const waiting = !!focus.waiting;
      const pulse = waiting ? (this.motion.matches ? 0.45 : 0.4 + 0.25 * Math.sin(time * 5)) : 1;
      ribbon = { points: ribbonPoints(focus, v), intensity: pulse };
    }
    const tint = focus.safety === "stop" ? [0.94, 0.27, 0.27, 0.32] : focus.safety === "slow" ? [0.96, 0.62, 0.04, 0.26] : [0.23, 0.51, 0.96, 0.1];
    this.renderer.render({
      viewProj: this.viewProj,
      eye: cam.eye,
      sun: SUN,
      fogColor: FOG,
      fogDensity: 0.055,
      scene: { static: this.staticScene, dynamic, ribbon, fan: { tris: safetyFan(focus, v), tint } },
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

function hexToRgba(hex) {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1];
}

