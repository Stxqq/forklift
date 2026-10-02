// The robot's real outline, and what it may not overlap. The footprint is
// two oriented boxes, the chassis and the fork with whatever is on it,
// tested with the separating axis theorem against walls, racks, rack
// uprights, docks, other robots and people.

import { CELL, H, W, cellX, cellY, key } from "./warehouse.js";

export const BODY = { x0: -0.35, x1: 0.35, half: 0.26 };
// the fork at reach 0 sits between the outriggers; reach slides it out
export const FORK = { x0: 0.06, x1: 0.38, half: 0.2, reach: 0.62 };
export const LOAD = { x0: 0.03, x1: 0.41, half: 0.19 };
export const UPRIGHT = 0.045; // half the side of a rack post
export const PERSON = 0.22;

/** Corners of a box given in the robot frame, placed at a pose. */
function corners(pose, x0, x1, half) {
  const c = Math.cos(pose.h);
  const s = Math.sin(pose.h);
  const pts = [
    [x0, -half],
    [x1, -half],
    [x1, half],
    [x0, half],
  ];
  return pts.map(([u, v]) => [pose.x + u * c - v * s, pose.y + u * s + v * c]);
}

/** The footprint at a pose: the chassis, and the fork (with load) at its reach. */
export function footprint(pose, reach = 0, loaded = false) {
  const r = reach * FORK.reach;
  const fork = loaded ? { x0: LOAD.x0 + r, x1: LOAD.x1 + r, half: Math.max(LOAD.half, FORK.half) } : { x0: FORK.x0 + r, x1: FORK.x1 + r, half: FORK.half };
  return {
    body: corners(pose, BODY.x0, BODY.x1, BODY.half),
    fork: corners(pose, fork.x0, fork.x1, fork.half),
  };
}

function project(pts, ax, ay) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of pts) {
    const d = x * ax + y * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** Do two convex quads overlap (separating axis theorem)? */
export function overlap(a, b, gap = 0) {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % 4];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ax = -(y2 - y1) / len;
      const ay = (x2 - x1) / len;
      const [a0, a1] = project(a, ax, ay);
      const [b0, b1] = project(b, ax, ay);
      if (a1 + gap <= b0 || b1 + gap <= a0) return false;
    }
  }
  return true;
}

const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

function circleHits(poly, cx, cy, r) {
  // distance from the circle center to the polygon
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % 4];
    const ex = x2 - x1;
    const ey = y2 - y1;
    if (ex * (cy - y1) - ey * (cx - x1) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((cx - x1) * ex + (cy - y1) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x1 + ex * t - cx, y1 + ey * t - cy));
  }
  return inside || best < r;
}

/**
 * Is a bay or dock cell open to the fork? Only straight through its open
 * face, from the cell in front of it, lined up: that's how a pick works.
 */
function openTo(ws, k, pose) {
  const bay = ws.bayAt.get(k);
  const target = bay ?? ws.docks.find((d) => d.cell === k);
  if (!target) return false;
  const fx = cellX(target.from) + 0.5;
  const fy = cellY(target.from) + 0.5;
  const along = Math.atan2(Math.sin(pose.h - target.facing), Math.cos(pose.h - target.facing));
  const lateral = Math.abs(-(pose.x - fx) * Math.sin(target.facing) + (pose.y - fy) * Math.cos(target.facing));
  return Math.abs(along) < 0.12 && lateral < 0.12 && Math.hypot(pose.x - fx, pose.y - fy) < 0.2;
}

const solidCell = (t) => t === CELL.WALL || t === CELL.RACK || t === CELL.DOCK || t === CELL.STAGING;

/**
 * What a robot at `pose` would hit, or null. `others` are other robots
 * ({ x, y, h, fork, load }), `people` anything with x and y.
 */
export function hit(ws, pose, { reach = 0, loaded = false, others = [], people = [] } = {}) {
  const fp = footprint(pose, reach, loaded);
  const parts = [
    ["body", fp.body],
    ["fork", fp.fork],
  ];
  for (const [part, poly] of parts) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x0 < 0 || y0 < 0 || x1 > W || y1 > H) return { kind: "wall" };
    for (let cy = Math.floor(y0); cy <= Math.floor(y1 - 1e-9); cy++) {
      for (let cx = Math.floor(x0); cx <= Math.floor(x1 - 1e-9); cx++) {
        const k = key(cx, cy);
        const t = ws.grid[k];
        if (t === CELL.RACK || t === CELL.DOCK) {
          if (part === "fork" && openTo(ws, k, pose)) continue;
          if (overlap(poly, rect(cx, cy, cx + 1, cy + 1))) return { kind: t === CELL.RACK ? "rack" : "dock", cell: k };
        } else if (solidCell(t) && overlap(poly, rect(cx, cy, cx + 1, cy + 1))) {
          return { kind: "wall", cell: k };
        }
      }
    }
    // rack uprights stand on the corners of every bay and poke into the aisle
    for (let gy = Math.round(y0 - 0.5); gy <= Math.round(y1 + 0.5); gy++) {
      for (let gx = Math.round(x0 - 0.5); gx <= Math.round(x1 + 0.5); gx++) {
        if (!uprightAt(ws, gx, gy)) continue;
        const u = UPRIGHT;
        if (overlap(poly, rect(gx - u, gy - u, gx + u, gy + u))) return { kind: "upright" };
      }
    }
    for (const o of others) {
      const ofp = footprint(o, o.fork.reach, !!o.load);
      if (overlap(poly, ofp.body) || overlap(poly, ofp.fork)) return { kind: "robot", id: o.id };
    }
    for (const p of people) if (circleHits(poly, p.x, p.y, PERSON)) return { kind: "person", id: p.id };
  }
  return null;
}

/** A rack post stands on grid point (gx, gy) if a bay touches it. */
export function uprightAt(ws, gx, gy) {
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const x = gx + dx;
    const y = gy + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && ws.grid[key(x, y)] === CELL.RACK) return true;
  }
  return false;
}

/**
 * Move from one pose to another in small enough pieces that nothing can
 * be skipped over, and stop at the last free one. Returns the pose
 * reached and what blocked it, if anything.
 */
export function sweep(ws, from, to, opts) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const dh = Math.atan2(Math.sin(to.h - from.h), Math.cos(to.h - from.h));
  const n = Math.max(1, Math.ceil(Math.max(dist / 0.03, Math.abs(dh) / 0.03)));
  let last = from;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, h: from.h + dh * t };
    const blocked = hit(ws, p, opts);
    if (blocked) return { pose: last, blocked };
    last = p;
  }
  return { pose: to, blocked: null };
}
