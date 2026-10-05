// What the 3D view draws, as plain arrays of instanced parts, built from
// the warehouse and the (interpolated) sim state only, never the other way
// round, so it runs in Node for the tests and can't change what the robots
// do. The models themselves are in models.js.

import { BOX_OFFSET, CELL, H, H_ROADS, LEVELS, RACK_ROWS, V_ROADS, W, WALK_COLS, cellX, cellY, key } from "../sim/warehouse.js";
import { Robot, SPEC } from "../sim/robot.js";
import { COLORS, FADES, Instances, MAT, STRIDE, T, bucket, carton, pallet, person, qX, qY, rgb, robot, tone } from "./models.js";

export { STRIDE, Instances };

export const RACK_TOP = 2.1;

/** Floor markings: thin glowing strips lying on the floor. */
function line(out, x0, z0, x1, z1, width, color) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 1e-6) return;
  out.add([(x0 + x1) / 2, 0.003, (z0 + z1) / 2], [len, 0.004, width], qY(-Math.atan2(z1 - z0, x1 - x0)), color, MAT.EMISSIVE);
}

/**
 * Everything that never moves: floor and markings, walls, racks, dock
 * frames, chargers and the inbound pallets. The floor is kept apart from
 * what stands on it (the glow pass needs to know the difference).
 */
export function buildStatic(ws) {
  const sc = bucket();
  const floor = new Instances(1024);
  const q0 = qY(0);
  floor.add([W / 2, -0.025, H / 2], [W - 1, 0.05, H - 1], q0, COLORS.floor, MAT.FLOOR);
  for (let k = 0; k < ws.grid.length; k++) {
    if (ws.grid[k] !== CELL.LANE) continue;
    floor.add([cellX(k) + 0.5, -0.024, cellY(k) + 0.5], [1, 0.05, 1], q0, COLORS.lane, MAT.FLOOR);
  }
  // walls, low enough to see over
  const wallH = 1.1;
  for (const [x, z, sx, sz] of [[W / 2, 0.42, W - 0.84, 0.16], [W / 2, H - 0.42, W - 0.84, 0.16], [0.42, H / 2, 0.16, H - 0.84], [W - 0.42, H / 2, 0.16, H - 0.84]]) {
    sc.rbox.add([x, wallH / 2, z], [sx, wallH, sz], q0, COLORS.wall, MAT.MATTE + FADES, 0.04);
  }

  // road edges in light grey, the divider between the lanes in yellow
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
  for (const spot of [...ws.parking, ...ws.chargers]) {
    const x = cellX(spot.cell);
    const y = cellY(spot.cell);
    line(floor, x + 0.12, y + 0.06, x + 1, y + 0.06, 0.03, COLORS.line);
    line(floor, x + 0.12, y + 0.94, x + 1, y + 0.94, 0.03, COLORS.line);
    line(floor, x + 0.12, y + 0.06, x + 0.12, y + 0.94, 0.03, COLORS.line);
  }
  for (const dock of ws.docks) {
    const x = cellX(dock.cell);
    const y = cellY(dock.cell);
    line(floor, x + 0.02, y - 0.25, x + 0.02, y + 1.25, 0.05, COLORS.yellow);
    floor.add([x + 0.38, -0.004, y + 0.5], [0.72, 0.03, 1.1], q0, rgb("#323238"), MAT.METAL);
  }

  // racks: slim uprights with a hole pattern, warm beams at each level
  for (let r = 0; r < RACK_ROWS.length; r += 2) {
    const y = RACK_ROWS[r];
    for (const [xa, xb] of [[5, 13], [15, 23]]) {
      for (let x = xa; x <= xb; x++) {
        for (const yy of [y + 0.03, y + 1, y + 1.97]) sc.rbox.add([x, RACK_TOP / 2, yy], [0.05, RACK_TOP, 0.07], q0, COLORS.upright, MAT.UPRIGHT + FADES, 0.008);
      }
      for (const level of LEVELS) {
        const h = Math.max(0.05, level - 0.06);
        for (const face of [y + 0.05, y + 1.95]) sc.rbox.add([(xa + xb) / 2, h, face], [xb - xa, 0.08, 0.045], q0, COLORS.beam, MAT.PAINT + FADES, 0.01);
      }
      sc.shadows.add([(xa + xb) / 2, 0, y + 1], [xb - xa + 0.5, 1, 2.5], q0, [0, 0, 0, 0.5], 0, 0.45);
    }
  }

  // dock door frames (the doors themselves roll, so they're dynamic)
  for (const dock of ws.docks) {
    const x = cellX(dock.cell) + 0.85;
    const y = cellY(dock.cell);
    sc.rbox.add([x, 1.2, y - 0.3], [0.2, 2.4, 0.14], q0, COLORS.dock, MAT.PAINT + FADES, 0.02);
    sc.rbox.add([x, 1.2, y + 1.3], [0.2, 2.4, 0.14], q0, COLORS.dock, MAT.PAINT + FADES, 0.02);
    sc.rbox.add([x, 2.42, y + 0.5], [0.22, 0.2, 1.74], q0, COLORS.dock, MAT.PAINT + FADES, 0.02);
    sc.rbox.add([x - 0.1, 0.1, y - 0.3], [0.08, 0.2, 0.12], q0, COLORS.rubber, MAT.RUBBER, 0.02);
    sc.rbox.add([x - 0.1, 0.1, y + 1.3], [0.08, 0.2, 0.12], q0, COLORS.rubber, MAT.RUBBER, 0.02);
  }
  // chargers: a wall unit and the contact plate on the floor
  for (const c of ws.chargers) {
    const x = cellX(c.cell);
    const y = cellY(c.cell);
    sc.rbox.add([x - 0.24, 0.55, y + 0.5], [0.18, 0.7, 0.5], q0, COLORS.charger, MAT.PAINT, 0.03);
    floor.add([x + 0.18, 0.004, y + 0.5], [0.08, 0.008, 0.36], q0, COLORS.brass, MAT.METAL);
  }
  // inbound pallets with cartons stacked on them
  for (let yy = 9; yy <= 14; yy++) {
    if (ws.grid[key(1, yy)] !== CELL.STAGING) continue;
    pallet(sc, T([1.5, 0, yy + 0.5]), 0.8, 0.8);
    carton(sc, T([1.36, 0.11, yy + 0.38]), [0.36, 0.34, 0.36], yy);
    carton(sc, T([1.66, 0.11, yy + 0.64]), [0.32, 0.48, 0.32], yy + 1);
    sc.shadows.add([1.5, 0, yy + 0.5], [1.0, 1, 1.0], q0, [0, 0, 0, 0.5], 0, 0.2);
  }
  return { floor, ...sc };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How visible a point is that might stand between the camera and the robot
 * it follows: down to a fifth inside a cone round the line of sight, and
 * close to the camera. The shader does the same sums; this is the
 * reference the tests check.
 */
export function occlusionAlpha(p, eye, focus) {
  const d = [focus[0] - eye[0], focus[1] - eye[1], focus[2] - eye[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const e = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const t = (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / len2;
  let alpha = 1;
  if (t > 0 && t < 0.92) {
    const c = [eye[0] + d[0] * t - p[0], eye[1] + d[1] * t - p[1], eye[2] + d[2] * t - p[2]];
    const dist = Math.hypot(...c);
    const radius = 0.5 + 0.5 * t;
    alpha = Math.min(alpha, 0.2 + 0.8 * smooth(radius * 0.7, radius, dist));
  }
  return Math.min(alpha, 0.2 + 0.8 * smooth(0.8, 1.6, Math.hypot(...e)));
}

/** A box on a shelf: the pallet under it and the carton itself. */
function bayBox(sc, bay, near, highlight) {
  const x = cellX(bay.cell) + 0.5;
  const z = cellY(bay.cell) + 0.5 - Math.sin(bay.facing) * BOX_OFFSET;
  const h = Math.max(0, LEVELS[bay.pkg.level] - 0.12);
  pallet(sc, T([x, h, z]), 0.62, 0.56, near);
  carton(sc, T([x, h + 0.12, z]), [0.44, 0.34, 0.44], tone(bay.pkg.id), near, FADES);
  if (bay.pkg.level === 0) sc.shadows.add([x, 0, z], [0.8, 1, 0.74], qY(0), [0, 0, 0, 0.5], 0, 0.18);
  if (highlight) outline(sc, x, h + 0.12, z, 0.47, 0.36);
}

/** Blue edges and a soft glow round the box the robot in focus is going for. */
function outline(sc, x, y, z, s, h) {
  const t = 0.016;
  const c = COLORS.blue;
  const q = qY(0);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) sc.rbox.add([x + (dx * s) / 2, y + h / 2, z + (dz * s) / 2], [t, h, t], q, c, MAT.EMISSIVE);
  for (const yy of [y + t / 2, y + h - t / 2]) {
    sc.rbox.add([x, yy, z - s / 2], [s, t, t], q, c, MAT.EMISSIVE);
    sc.rbox.add([x, yy, z + s / 2], [s, t, t], q, c, MAT.EMISSIVE);
    sc.rbox.add([x - s / 2, yy, z], [t, t, s], q, c, MAT.EMISSIVE);
    sc.rbox.add([x + s / 2, yy, z], [t, t, s], q, c, MAT.EMISSIVE);
  }
  sc.glows.add([x, y, z], [1.1, 1, 1.1], q, [0.23, 0.51, 0.96, 0.35], 0, 0.45);
}

/**
 * Everything that moves this frame. `views` maps robots and people to their
 * interpolated poses and `looks` to their visual state (see View3D); `eye`
 * is the camera, for the level of detail; `docks` how far each door is up.
 */
export function buildDynamic(world, views, focus, { looks, eye = null, docks = [], time = 0, charging = new Set() }) {
  const sc = bucket();
  const near = (x, z, d) => !eye || Math.hypot(x - eye[0], z - eye[2]) < d;
  const target = focus?.job?.kind === "order" && focus.stage <= 1 ? focus.job.bay : null;
  for (const bay of world.warehouse.bays) {
    if (bay.pkg) bayBox(sc, bay, near(cellX(bay.cell), cellY(bay.cell), 12), bay === target);
  }
  for (const r of world.robots) robot(sc, r, views.get(r), looks.get(r));
  for (const w of world.workers) person(sc, w, views.get(w), looks.get(w));
  // dock doors roll up as a robot comes to set something down
  world.warehouse.docks.forEach((dock, i) => {
    const open = docks[i] ?? 0;
    const x = cellX(dock.cell) + 0.85;
    const y = cellY(dock.cell) + 0.5;
    const bottom = 0.02 + open * 2.0;
    const height = 2.3 - bottom;
    if (height > 0.02) sc.rbox.add([x, bottom + height / 2, y], [0.05, height, 1.46], qY(0), COLORS.door, MAT.PAINT + FADES, 0.01);
    sc.cyl.add([x, 2.32, y], [0.16, 1.5, 0.16], qX(Math.PI / 2), COLORS.dock, MAT.PAINT + FADES);
    sc.cyl.add([x - 0.12, 2.08, y - 0.78], [0.07, 0.03, 0.07], qX(Math.PI / 2), open > 0.6 ? COLORS.green : COLORS.amber, MAT.EMISSIVE);
  });
  // chargers: the plug light pulses while a robot charges
  for (const c of world.warehouse.chargers) {
    const on = charging.has(c.id);
    const pulse = on ? 0.55 + 0.45 * Math.sin(time * 3) : 0;
    const col = on ? [0.13 + 0.2 * pulse, 0.77 * (0.5 + pulse / 2), 0.37 * (0.5 + pulse / 2), 1] : rgb("#2a2b30");
    sc.rbox.add([cellX(c.cell) - 0.14, 0.75, cellY(c.cell) + 0.5], [0.02, 0.06, 0.12], qY(0), col, MAT.EMISSIVE, 0.008);
    if (on) sc.glows.add([cellX(c.cell) + 0.2, 0, cellY(c.cell) + 0.5], [0.8, 1, 0.8], qY(0), [0.13, 0.77, 0.37, 0.2 * pulse], 0, 0.35);
  }
  // lidar returns of the robot in focus, as faint points
  if (focus) {
    const v = views.get(focus);
    const n = SPEC.lidarRays;
    for (let k = 0; k < n; k++) {
      const d = focus.lidar[k];
      if (d >= SPEC.lidarRange - 0.01) continue;
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      sc.rbox.add([v.x + Math.cos(a) * d, 0.32, v.y + Math.sin(a) * d], [0.03, 0.03, 0.03], qY(0), [0.7, 0.78, 0.95, 1], MAT.EMISSIVE);
    }
  }
  return sc;
}

/**
 * The route as a centerline from the robot along its planned cells, traced
 * with the robot's own path geometry (corners as the same curves it
 * drives), so the ribbon is exactly where it will go. Returns
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

/** The safety field as a fan on the floor: triangles from the robot, as (x, z) pairs. */
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
 * The label scanner's laser: a thin fan from the top of the backrest down
 * across the label on the box, sweeping once per read. One triangle, as
 * three (x, y, z) corners.
 */
export function laserFan(v, sweep) {
  const c = Math.cos(v.h);
  const s = Math.sin(v.h);
  const reach = v.fr * 0.62;
  const at = (u, w, h) => [v.x + u * c - w * s, h, v.y + u * s + w * c];
  const src = at(0.06 + reach, 0, v.fh + 0.56);
  const u = 0.22 + reach + (sweep - 0.5) * 0.24;
  return [...src, ...at(u, -0.15, v.fh + 0.345), ...at(u, 0.15, v.fh + 0.345)];
}
