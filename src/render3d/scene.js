// What the 3D view draws, as plain arrays: instanced boxes, cylinders and
// capsules, soft contact shadows, glowing floor lines, the route ribbon
// and the safety fan. Built from the warehouse and the (interpolated) sim
// state only, never the other way round, so it runs in Node for the tests
// and can't change what the robots do.

import { BOX_OFFSET, CELL, H, H_ROADS, LEVELS, RACK_ROWS, V_ROADS, W, WALK_COLS, cellX, cellY, center, key } from "../sim/warehouse.js";
import { BODY, FORK, LOAD } from "../sim/collide.js";
import { Robot, SPEC } from "../sim/robot.js";

// one instance: position (base center), size, yaw, rgba, kind
export const STRIDE = 12;
export const KIND = { LIT: 0, EMISSIVE: 1, GLOSSY: 2 };

const rgb = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a];
export const COLORS = {
  floor: rgb("#17171a"),
  lane: rgb("#1c1c20"),
  wall: rgb("#2c2c31"),
  line: rgb("#b9b9c2", 0.85),
  yellow: rgb("#e2b33c", 0.95),
  walk: rgb("#8f7a52", 0.8),
  upright: rgb("#5a5a62"),
  beam: rgb("#8a8a93"),
  pallet: rgb("#6f6b64"),
  box: rgb("#c4c1bb"),
  otherBox: rgb("#a9a7a2"),
  dock: rgb("#5c5c63"),
  leveler: rgb("#3a3a40"),
  charger: rgb("#6e6e76"),
  silver: rgb("#d9d9de"),
  steel: rgb("#a9a9b2"),
  dark: rgb("#2a2a30"),
  black: rgb("#111114"),
  robot: rgb("#9d9da5"),
  person: rgb("#bdbdc3"),
  vest: rgb("#d1a04e"),
  blue: rgb("#3b82f6"),
  amber: rgb("#f59e0b"),
  red: rgb("#ef4444"),
  green: rgb("#22c55e"),
  white: rgb("#f4f4f6"),
};

export class Instances {
  constructor(capacity = 256) {
    this.data = new Float32Array(capacity * STRIDE);
    this.count = 0;
  }

  /** A box (or cylinder, capsule) standing on (x, y, z), sized along its own axes, turned by yaw. */
  push(x, y, z, sx, sy, sz, yaw, color, kind = KIND.LIT) {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count++ * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = sx;
    d[o + 4] = sy;
    d[o + 5] = sz;
    d[o + 6] = yaw;
    d[o + 7] = color[0];
    d[o + 8] = color[1];
    d[o + 9] = color[2];
    d[o + 10] = color[3];
    d[o + 11] = kind;
  }

  /** The same, given in a robot's frame: u forward, v to its right, h up. */
  local(pose, u, v, h, su, sh, sv, color, kind) {
    const c = Math.cos(pose.h);
    const s = Math.sin(pose.h);
    this.push(pose.x + u * c - v * s, h, pose.y + u * s + v * c, su, sh, sv, pose.h, color, kind);
  }

  get used() {
    return this.data.subarray(0, this.count * STRIDE);
  }
}

/** Floor lines: thin glowing strips lying on the floor. */
function line(out, x0, z0, x1, z1, width, color) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 1e-6) return;
  out.push((x0 + x1) / 2, 0.002, (z0 + z1) / 2, len, 0.004, width, Math.atan2(z1 - z0, x1 - x0), color, KIND.EMISSIVE);
}

/**
 * Everything that never moves: floor, walls, floor markings, racks, docks,
 * chargers and the inbound pallets. Returns { floor, boxes, cylinders,
 * shadows }: the floor and its markings apart from what stands on it.
 */
export function buildStatic(ws) {
  const floor = new Instances(1024);
  const boxes = new Instances(1024);
  const cylinders = new Instances(64);
  const shadows = new Instances(128);
  // the floor and the lanes on it
  floor.push(W / 2, -0.05, H / 2, W - 1, 0.05, H - 1, 0, COLORS.floor);
  for (let k = 0; k < ws.grid.length; k++) {
    if (ws.grid[k] !== CELL.LANE) continue;
    floor.push(cellX(k) + 0.5, -0.049, cellY(k) + 0.5, 1, 0.05, 1, 0, COLORS.lane);
  }
  // walls, low enough to see over from the chase camera
  const wallH = 1.1;
  boxes.push(W / 2, 0, 0.42, W - 0.84, wallH, 0.16, 0, COLORS.wall);
  boxes.push(W / 2, 0, H - 0.42, W - 0.84, wallH, 0.16, 0, COLORS.wall);
  boxes.push(0.42, 0, H / 2, 0.16, wallH, H - 0.84, 0, COLORS.wall);
  boxes.push(W - 0.42, 0, H / 2, 0.16, wallH, H - 0.84, 0, COLORS.wall);

  // road edges in light grey, the divider between the two lanes in yellow
  const x0 = V_ROADS[0][0];
  const x1 = V_ROADS[V_ROADS.length - 1][1] + 1;
  const y0 = H_ROADS[0][0];
  const y1 = H_ROADS[H_ROADS.length - 1][1] + 1;
  for (const [up, down] of H_ROADS) {
    for (let x = x0; x < x1; x++) {
      if (ws.grid[key(x, up - 1)] !== CELL.LANE) line(floor, x, up + 0.04, x + 1, up + 0.04, 0.04, COLORS.line);
      if (ws.grid[key(x, down + 1)] !== CELL.LANE) line(floor, x, down + 0.96, x + 1, down + 0.96, 0.04, COLORS.line);
      if (!ws.isJunction(key(x, up))) line(floor, x + 0.15, up + 1, x + 0.85, up + 1, 0.05, COLORS.yellow);
    }
  }
  for (const [left, right] of V_ROADS) {
    for (let y = y0; y < y1; y++) {
      if (ws.grid[key(left - 1, y)] !== CELL.LANE) line(floor, left + 0.04, y, left + 0.04, y + 1, 0.04, COLORS.line);
      if (ws.grid[key(right + 1, y)] !== CELL.LANE) line(floor, right + 0.96, y, right + 0.96, y + 1, 0.04, COLORS.line);
      if (!ws.isJunction(key(left, y))) line(floor, left + 1, y + 0.15, left + 1, y + 0.85, 0.05, COLORS.yellow);
    }
  }
  // zebra crossings and walkway edges
  for (const k of ws.crosswalks) {
    for (let i = 0; i < 4; i++) {
      const z = cellY(k) + 0.14 + i * 0.24;
      line(floor, cellX(k) + 0.14, z, cellX(k) + 0.86, z, 0.1, COLORS.line);
    }
  }
  for (const x of WALK_COLS) {
    for (let y = RACK_ROWS[0]; y <= RACK_ROWS[RACK_ROWS.length - 1]; y++) {
      if (ws.crosswalks.has(key(x, y))) continue;
      for (const xx of [x + 0.06, x + 0.94]) line(floor, xx, y + 0.15, xx, y + 0.65, 0.03, COLORS.walk);
    }
  }
  // parking and charging pockets
  for (const spot of [...ws.parking, ...ws.chargers]) {
    const x = cellX(spot.cell);
    const y = cellY(spot.cell);
    line(floor, x + 0.12, y + 0.06, x + 1, y + 0.06, 0.03, COLORS.line);
    line(floor, x + 0.12, y + 0.94, x + 1, y + 0.94, 0.03, COLORS.line);
    line(floor, x + 0.12, y + 0.06, x + 0.12, y + 0.94, 0.03, COLORS.line);
  }

  // racks: uprights on every bay corner, beams at each shelf level
  for (let r = 0; r < RACK_ROWS.length; r += 2) {
    const y = RACK_ROWS[r];
    for (const [xa, xb] of [[5, 13], [15, 23]]) {
      for (let x = xa; x <= xb; x++) {
        for (const yy of [y, y + 1, y + 2]) boxes.push(x, 0, yy, 0.06, 2.1, 0.06, 0, COLORS.upright);
      }
      for (const level of LEVELS) {
        const h = Math.max(0.04, level - 0.1);
        for (const face of [y + 0.04, y + 1.96]) boxes.push((xa + xb) / 2, h, face, xb - xa, 0.09, 0.05, 0, COLORS.beam);
      }
      shadows.push((xa + xb) / 2, 0, y + 1, xb - xa + 0.5, 1, 2.5, 0, [0, 0, 0, 0.55], 0.45);
    }
  }

  // docks: a door frame in the wall and a leveler plate in front of it
  for (const dock of ws.docks) {
    const x = cellX(dock.cell);
    const y = cellY(dock.cell);
    floor.push(x + 0.38, -0.01, y + 0.5, 0.72, 0.03, 1.1, 0, COLORS.leveler);
    boxes.push(x + 0.85, 0, y - 0.3, 0.2, 2.4, 0.14, 0, COLORS.dock);
    boxes.push(x + 0.85, 0, y + 1.3, 0.2, 2.4, 0.14, 0, COLORS.dock);
    boxes.push(x + 0.85, 2.3, y + 0.5, 0.2, 0.18, 1.74, 0, COLORS.dock);
    line(floor, x + 0.02, y - 0.25, x + 0.02, y + 1.25, 0.05, COLORS.yellow);
    cylinders.push(x + 0.85, 2.0, y - 0.45, 0.08, 0.08, 0.08, 0, COLORS.green, KIND.EMISSIVE);
  }
  // chargers: a wall unit with its contact plate
  for (const c of ws.chargers) {
    const x = cellX(c.cell);
    const y = cellY(c.cell);
    boxes.push(x - 0.25, 0.2, y + 0.5, 0.18, 0.7, 0.5, 0, COLORS.charger);
    floor.push(x + 0.18, 0, y + 0.5, 0.08, 0.02, 0.36, 0, rgb("#a08a5a"));
  }
  // inbound pallets with boxes stacked on them
  for (let yy = 9; yy <= 14; yy++) {
    if (ws.grid[key(1, yy)] !== CELL.STAGING) continue;
    boxes.push(1.5, 0, yy + 0.5, 0.8, 0.12, 0.8, 0, COLORS.pallet);
    boxes.push(1.35, 0.12, yy + 0.38, 0.38, 0.36, 0.38, 0, COLORS.otherBox);
    boxes.push(1.65, 0.12, yy + 0.64, 0.34, 0.5, 0.34, 0, COLORS.otherBox);
    shadows.push(1.5, 0, yy + 0.5, 1.0, 1, 1.0, 0, [0, 0, 0, 0.5], 0.2);
  }
  return { floor, boxes, cylinders, shadows };
}

/** A box on a shelf: the pallet under it and the box itself. */
function bayBox(out, shadows, bay, level, color) {
  const x = cellX(bay.cell) + 0.5;
  const z = cellY(bay.cell) + 0.5 - Math.sin(bay.facing) * BOX_OFFSET;
  const h = LEVELS[level] - 0.12;
  out.push(x, Math.max(0, h), z, 0.62, 0.11, 0.56, 0, COLORS.pallet);
  out.push(x, Math.max(0, h) + 0.11, z, 0.44, 0.34, 0.44, 0, color);
  if (level === 0) shadows.push(x, 0, z, 0.8, 1, 0.74, 0, [0, 0, 0, 0.5], 0.18);
  return { x, y: Math.max(0, h) + 0.11, z };
}

/** Blue edges round a box: the one the robot in focus is going for. */
function outline(out, x, y, z, s, h) {
  const t = 0.018;
  const c = COLORS.blue;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push(x + (dx * s) / 2, y, z + (dz * s) / 2, t, h, t, 0, c, KIND.EMISSIVE);
  for (const yy of [y, y + h - t]) {
    out.push(x, yy, z - s / 2, s, t, t, 0, c, KIND.EMISSIVE);
    out.push(x, yy, z + s / 2, s, t, t, 0, c, KIND.EMISSIVE);
    out.push(x - s / 2, yy, z, t, t, s, 0, c, KIND.EMISSIVE);
    out.push(x + s / 2, yy, z, t, t, s, 0, c, KIND.EMISSIVE);
  }
}

/**
 * The robot. `detail` draws the one in focus with everything; others get
 * the chassis, mast, fork and load. `v` is its interpolated pose and fork.
 */
export function robotParts(boxes, cylinders, shadows, r, v, { detail, status, beacon }) {
  const pose = { x: v.x, y: v.y, h: v.h };
  const fh = v.fh ?? r.fork.height;
  const reach = (v.fr ?? r.fork.reach) * FORK.reach;
  const body = detail ? COLORS.silver : COLORS.robot;
  const kind = detail ? KIND.GLOSSY : KIND.LIT;
  shadows.push(pose.x + Math.cos(pose.h) * 0.05, 0, pose.y + Math.sin(pose.h) * 0.05, 0.95, 1, 0.75, pose.h, [0, 0, 0, 0.75], 0.25);
  // chassis and outriggers
  boxes.local(pose, (BODY.x0 + 0.04) / 2, 0, 0.05, 0.04 - BODY.x0, 0.32, BODY.half * 2, body, kind);
  for (const side of [-1, 1]) {
    boxes.local(pose, 0.185, side * 0.225, 0.02, 0.33, 0.09, 0.07, detail ? COLORS.steel : body, kind);
  }
  // mast: outer rails, and inner rails that rise with the fork above 1 m
  const top = Math.max(1.25, fh + 0.75);
  for (const side of [-1, 1]) {
    boxes.local(pose, 0.06, side * 0.19, 0.05, 0.05, 1.2, 0.05, COLORS.steel, kind);
    if (top > 1.26) boxes.local(pose, 0.075, side * 0.16, 0.3, 0.04, top - 0.3, 0.04, COLORS.steel, kind);
  }
  boxes.local(pose, 0.07, 0, top - 0.05, 0.05, 0.05, 0.42, COLORS.steel, kind);
  // carriage with backrest, and the two tines
  const c = FORK.x0 + reach;
  boxes.local(pose, c - 0.02, 0, fh, 0.03, 0.34, FORK.half * 2, COLORS.steel, kind);
  for (const side of [-1, 1]) boxes.local(pose, (c + FORK.x1 + reach) / 2, side * 0.11, fh - 0.02, FORK.x1 - FORK.x0, 0.035, 0.07, COLORS.steel, KIND.GLOSSY);
  if (r.load) {
    const u = (LOAD.x0 + LOAD.x1) / 2 + reach;
    const s = LOAD.x1 - LOAD.x0;
    boxes.local(pose, u, 0, fh + 0.015, s, 0.3, s, COLORS.box, kind);
    if (detail) {
      // the label on the lid, with its real modules
      const code = r.load.code;
      const q = 0.2;
      const m = q / code.size;
      boxes.local(pose, u, 0, fh + 0.316, q + 0.03, 0.003, q + 0.03, COLORS.white, KIND.EMISSIVE);
      for (let y = 0; y < code.size; y++) {
        for (let x = 0; x < code.size; x++) {
          if (!code.modules[y][x]) continue;
          // label read the right way up from behind the robot
          boxes.local(pose, u + q / 2 - (y + 0.5) * m, -q / 2 + (x + 0.5) * m, fh + 0.318, m, 0.002, m, COLORS.black, KIND.EMISSIVE);
        }
      }
    }
  }
  if (!detail) {
    boxes.local(pose, -0.25, 0, 0.37, 0.08, 0.01, 0.4, status, KIND.EMISSIVE);
    return;
  }
  // bumper, drive wheels, casters, top details
  boxes.local(pose, BODY.x0 - 0.005, 0, 0.06, 0.04, 0.1, 0.44, COLORS.dark, KIND.LIT);
  for (const side of [-1, 1]) {
    boxes.local(pose, -0.08, side * 0.255, 0, 0.16, 0.16, 0.04, COLORS.black, KIND.LIT);
    cylinders.local(pose, 0.3, side * 0.225, 0, 0.05, 0.05, 0.05, COLORS.black, KIND.LIT);
    // status strips along both flanks
    boxes.local(pose, -0.13, side * 0.262, 0.28, 0.3, 0.025, 0.006, status, KIND.EMISSIVE);
  }
  boxes.local(pose, 0.045, 0, 0.11, 0.01, 0.06, 0.2, rgb("#1e3a8a"), KIND.EMISSIVE);
  boxes.local(pose, -0.12, 0, 0.37, 0.004, 0.001, 0.44, COLORS.dark, KIND.LIT);
  cylinders.local(pose, -0.09, 0, 0.37, 0.14, 0.06, 0.14, COLORS.dark, KIND.LIT);
  cylinders.local(pose, -0.09, 0, 0.43, 0.09, 0.02, 0.09, COLORS.steel, KIND.GLOSSY);
  cylinders.local(pose, -0.27, -0.165, 0.37, 0.06, 0.07, 0.06, beacon ? COLORS.amber : rgb("#7c5a12"), beacon ? KIND.EMISSIVE : KIND.LIT);
  cylinders.local(pose, -0.27, 0.165, 0.37, 0.065, 0.02, 0.065, rgb("#facc15"), KIND.LIT);
  cylinders.local(pose, -0.27, 0.165, 0.39, 0.045, 0.025, 0.045, COLORS.red, KIND.LIT);
  boxes.local(pose, -0.22, 0, 0.371, 0.09, 0.002, 0.1, COLORS.white, KIND.EMISSIVE);
  boxes.local(pose, BODY.x0 - 0.008, -0.065, 0.1, 0.006, 0.04, 0.05, rgb("#c8ad73"), KIND.LIT);
  boxes.local(pose, BODY.x0 - 0.008, 0.065, 0.1, 0.006, 0.04, 0.05, rgb("#c8ad73"), KIND.LIT);
}

/** A person as soft capsules, with a hint of the vest. */
export function personParts(capsules, shadows, w, v, time = 0) {
  const pose = { x: v.x, y: v.y, h: v.h };
  const sway = w.moving ? Math.sin(time * 7 + w.id * 1.7) * 0.03 : 0;
  shadows.push(pose.x, 0, pose.y, 0.6, 1, 0.5, pose.h, [0, 0, 0, 0.6], 0.3);
  capsules.local(pose, sway, -0.09, 0, 0.16, 0.85, 0.16, COLORS.person);
  capsules.local(pose, -sway, 0.09, 0, 0.16, 0.85, 0.16, COLORS.person);
  capsules.local(pose, 0, 0, 0.72, 0.28, 0.72, 0.42, COLORS.vest);
  capsules.local(pose, 0, 0, 1.42, 0.22, 0.26, 0.22, COLORS.person);
}

/**
 * The route as a centerline from the robot along its planned cells, traced
 * with the robot's own path geometry (corners as the same quarter circles
 * it drives), so the ribbon is exactly where it will go. Returns
 * [{ x, z, s }] with s the distance along it.
 */
export function ribbonPoints(r, v, step = 0.1) {
  const path = r.path;
  if (!path || r.i >= path.length - 1) return [];
  const probe = { path, i: r.i, seg: r.seg, x: r.x, y: r.y, h: r.h, corner: Robot.prototype.corner, arc: Robot.prototype.arc };
  const out = [{ x: v.x, z: v.y, s: 0 }];
  let s = 0;
  const end = path.length - 1;
  for (let p = r.i + r.seg + step; ; p += step) {
    const at = Math.min(p, end);
    probe.i = Math.min(Math.floor(at + 1e-9), end);
    probe.seg = at - probe.i;
    if (probe.i >= end) {
      probe.i = end;
      probe.seg = 0;
    }
    Robot.prototype.place.call(probe);
    const last = out[out.length - 1];
    s += Math.hypot(probe.x - last.x, probe.y - last.z);
    out.push({ x: probe.x, z: probe.y, s });
    if (at >= end) break;
  }
  return out;
}

/** The safety field as a fan on the floor: a few triangles from the robot. */
export function safetyFan(r, v) {
  const reach = r.safety === "stop" ? SPEC.stop : SPEC.slow * 0.75;
  const tris = [];
  const n = 14;
  const spread = 0.55;
  for (let i = 0; i < n; i++) {
    const a = v.h - spread + (2 * spread * i) / n;
    const b = v.h - spread + (2 * spread * (i + 1)) / n;
    tris.push(v.x, v.y, v.x + Math.cos(a) * reach, v.y + Math.sin(a) * reach, v.x + Math.cos(b) * reach, v.y + Math.sin(b) * reach);
  }
  return tris;
}

/**
 * Everything that moves this frame. `views` maps robots and people to
 * their interpolated poses; `focus` is the robot the camera follows.
 */
export function buildDynamic(world, views, focus, { time = 0, statusColor, beacon }) {
  const boxes = new Instances(1024);
  const cylinders = new Instances(64);
  const capsules = new Instances(32);
  const shadows = new Instances(64);
  const target = focus?.job?.kind === "order" && focus.stage <= 1 ? focus.job.bay : null;
  for (const bay of world.warehouse.bays) {
    if (!bay.pkg) continue;
    const at = bayBox(boxes, shadows, bay, bay.pkg.level, bay === target ? COLORS.box : COLORS.otherBox);
    if (bay === target) outline(boxes, at.x, at.y, at.z, 0.47, 0.36);
  }
  for (const r of world.robots) {
    const v = views.get(r);
    robotParts(boxes, cylinders, shadows, r, v, { detail: r === focus, status: statusColor(r), beacon: beacon(r) });
  }
  for (const w of world.workers) personParts(capsules, shadows, w, views.get(w), time);
  // lidar returns of the robot in focus, as faint points
  const points = new Instances(64);
  if (focus) {
    const v = views.get(focus);
    const n = SPEC.lidarRays;
    for (let k = 0; k < n; k++) {
      const d = focus.lidar[k];
      if (d >= SPEC.lidarRange - 0.01) continue;
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      points.push(v.x + Math.cos(a) * d, 0.32, v.y + Math.sin(a) * d, 0.035, 0.035, 0.035, 0, [0.75, 0.8, 0.95, 0.9], KIND.EMISSIVE);
    }
  }
  return { boxes, cylinders, capsules, shadows, points };
}
