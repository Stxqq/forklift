// The forklift robot: a differential-drive base (it turns on the spot),
// a mast with a fork that lifts and reaches, a 270° lidar and a label
// scanner. Kinematics only, in SI units, one fixed step at a time.

import { center } from "./warehouse.js";
import { dirOf } from "./planner.js";
import { BODY, FORK, sweep } from "./collide.js";

export const SPEC = {
  length: BODY.x1 - BODY.x0, // chassis with outriggers, meters
  width: BODY.half * 2,
  forkLength: FORK.x1 - FORK.x0,
  reach: FORK.reach, // how far the fork slides out
  maxSpeed: 1.5, // m/s
  reverse: 0.6,
  accel: 1.0, // m/s²
  turnRate: 2.2, // rad/s on the spot
  turnAccel: 7, // rad/s²
  cornerSpeed: 0.8, // m/s on a corner arc
  jerk: 4, // m/s³
  forkSpeed: 0.6, // m/s up and down
  forkAccel: 1.6,
  reachTime: 0.9, // s to slide the fork all the way out
  maxFork: 1.6,
  payload: 30, // kg
  travelHeight: 0.1,
  scanHeight: 0.45,
  dockHeight: 0.35,
  lidarRange: 6,
  lidarRays: 37,
  lidarFov: (270 * Math.PI) / 180,
  // the safety field: stop if someone is this close in the path, slow down
  // from `slow` meters out
  stop: 1.35,
  slow: 3.2,
  corridor: 0.62,
  battery: { perMeter: 0.0011, perLift: 0.003, idle: 0.00002, charge: 0.02, low: 0.2, full: 0.95 },
};

// cells a robot asks for ahead of the one it's in
export const LOOKAHEAD = 2;

export const HEADINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * A corner from the entry edge of its cell to the exit edge, in the cell's
 * own frame: x along the way in, y along the way out, from (0, 0) to
 * (0.5, 0.5). The heading follows a smoothstep through the turn, so the
 * turn rate builds up from nothing and dies away again instead of jumping
 * to v/r at the edge of the cell the way it would on a quarter circle; the
 * path is that heading integrated once, scaled to meet the same two points.
 * It stays within 4.3 cm of the quarter circle.
 */
export const cornerTurn = (u) => u * u * (3 - 2 * u);
const CURVE = (() => {
  const n = 96;
  const pts = [[0, 0]];
  let x = 0;
  let y = 0;
  for (let k = 0; k < n; k++) {
    const a = (Math.PI / 2) * cornerTurn((k + 0.5) / n);
    x += Math.cos(a) / n;
    y += Math.sin(a) / n;
    pts.push([x, y]);
  }
  return pts.map(([px, py]) => [(px * 0.5) / x, (py * 0.5) / y]);
})();

/** Where on a corner, in the cell's frame, at u from 0 (entry) to 1 (exit). */
export function cornerPoint(u) {
  const f = Math.min(Math.max(u, 0), 1) * (CURVE.length - 1);
  const k = Math.min(Math.floor(f), CURVE.length - 2);
  const t = f - k;
  const a = CURVE[k];
  const b = CURVE[k + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * One axis moving toward a target with a speed limit and an acceleration
 * limit, braking in time: a smooth start and a smooth stop.
 */
export function ease(x, v, target, vmax, acc, dt) {
  const d = target - x;
  if (Math.abs(d) < 1e-5 && Math.abs(v) < acc * dt * 2) return [target, 0];
  const want = Math.sign(d) * Math.min(vmax, Math.sqrt(2 * acc * Math.abs(d)));
  const dv = want - v;
  const step = acc * 1.5 * dt;
  v += Math.abs(dv) <= step ? dv : Math.sign(dv) * step;
  if (Math.abs(v * dt) >= Math.abs(d) && Math.sign(v) === Math.sign(d)) return [target, 0];
  return [x + v * dt, v];
}
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Robot {
  constructor(id, cell, heading = 0, battery = 1) {
    const c = center(cell);
    this.id = id;
    this.x = c.x;
    this.y = c.y;
    this.h = heading;
    this.v = 0;
    this.w = 0;
    this.cell = cell;
    this.fork = { height: SPEC.travelHeight, target: SPEC.travelHeight, reach: 0, vh: 0, vr: 0 };
    this.acc = 0;
    this.prev = { x: this.x, y: this.y, h: heading, fh: SPEC.travelHeight, fr: 0 };
    this.load = null;
    this.battery = battery;
    this.meters = 0;
    this.lifts = 0;
    this.path = null;
    this.i = 0;
    this.seg = 0;
    this.held = [cell];
    this.waiting = null; // what it is yielding to
    this.safety = "clear"; // clear | slow | stop
    this.lidar = new Float32Array(SPEC.lidarRays).fill(SPEC.lidarRange);
    this.job = null;
    this.phase = "idle";
    this.timer = 0;
    this.stage = -1;
    this.scan = null;
    this.manual = null;
  }

  /** A route, with the planned arrival and departure time at each cell. */
  setPath(path, tin = null, tout = null, eta = null) {
    this.path = path;
    this.tin = tin;
    this.tout = tout;
    this.eta = eta;
    this.i = 0;
    this.seg = 0;
  }

  get arrived() {
    return !this.path || (this.i >= this.path.length - 1 && this.seg === 0);
  }

  /** Turn on the spot toward `target`, easing in and out; true once facing it. */
  turnTo(target, dt) {
    const err = wrap(target - this.h);
    this.v = 0;
    this.acc = 0;
    if (Math.abs(err) < 1e-4 && Math.abs(this.w) < 0.05) {
      this.h = target;
      this.w = 0;
      return true;
    }
    // the fastest turn rate it can still brake from in time, then a
    // limited angular acceleration toward it
    const want = Math.sign(err) * Math.min(SPEC.turnRate, Math.sqrt(2 * SPEC.turnAccel * Math.abs(err)));
    const dw = want - this.w;
    const step = SPEC.turnAccel * 1.5 * dt;
    this.w += Math.abs(dw) <= step ? dw : Math.sign(dw) * step;
    if (Math.abs(this.w * dt) >= Math.abs(err) && Math.sign(this.w) === Math.sign(err)) {
      this.h = target;
      this.w = 0;
      return true;
    }
    this.h = wrap(this.h + this.w * dt);
    this.battery -= SPEC.battery.idle * 4 * dt;
    return false;
  }

  /** Move the fork toward a height and reach, easing both; true when there. */
  forkTo(height, reach, dt) {
    const f = this.fork;
    f.target = height;
    [f.height, f.vh] = ease(f.height, f.vh, height, SPEC.forkSpeed, SPEC.forkAccel, dt);
    [f.reach, f.vr] = ease(f.reach, f.vr, reach, 1 / SPEC.reachTime, 6, dt);
    return f.height === height && f.reach === reach;
  }

  /** 0 on a straight, 1 where the path turns a corner, 2 where it doubles back. */
  corner(j) {
    const p = this.path;
    if (!p || j <= 0 || j >= p.length - 1) return 0;
    const a = dirOf(p[j - 1], p[j]);
    const b = dirOf(p[j], p[j + 1]);
    return a === b ? 0 : (a + 2) % 4 === b ? 2 : 1;
  }

  /**
   * Drive along the planned cells. `traffic` hands out cell reservations,
   * `limit` (0–1) is the safety field's cap on speed. Corners are driven
   * as smooth curves through the corner cell; the robot only turns on
   * the spot at the start of a route. Returns true on arrival.
   */
  follow(traffic, limit, dt, now = 0) {
    const path = this.path;
    if (!path || this.i >= path.length - 1) {
      this.v = 0;
      return true;
    }
    if (this.seg === 0) {
      const d = dirOf(path[this.i], path[this.i + 1]);
      if (this.corner(this.i) !== 1 && !this.turnTo(HEADINGS[d], dt)) return false;
      // a planned wait: someone else is booked on the way first
      if (this.tout && this.tout[this.i] - this.tin[this.i] > 0.3 && now < this.tout[this.i] - 0.05) {
        this.v = 0;
        this.acc = 0;
        this.waiting = { kind: "plan", until: this.tout[this.i] };
        return false;
      }
      if (!this.holds(path[this.i + 1]) && !traffic.request(this, path, this.i + 1)) {
        this.v = 0;
        this.acc = 0;
        this.waiting = traffic.blocker;
        return false;
      }
    }
    this.waiting = null;
    // reserve a few cells ahead while moving, so a free lane doesn't mean
    // stopping at every cell
    for (let j = this.i + 1; j < path.length && j <= this.i + LOOKAHEAD; j++) {
      if (this.holds(path[j])) continue;
      if (!traffic.request(this, path, j)) break;
    }
    // how far it may go: through every held cell, but into a corner only
    // when the cell after it is held too, and up to a reversal at most
    let max = this.i;
    for (let j = this.i + 1; j < path.length; j++) {
      if (!this.holds(path[j])) break;
      const c = this.corner(j);
      if (c === 1 && !this.holds(path[j + 1])) break;
      max = j;
      if (c === 2) break;
    }
    const at = this.i + this.seg;
    const room = Math.max(0, max - at);
    let want = Math.min(SPEC.maxSpeed * limit, Math.sqrt(2 * SPEC.accel * room));
    const onArc = (this.corner(this.i) === 1 && this.seg < 0.5) || (this.corner(this.i + 1) === 1 && this.seg >= 0.5);
    if (onArc) want = Math.min(want, SPEC.cornerSpeed);
    for (let j = this.i + 1; j <= max; j++) {
      if (this.corner(j) !== 1) continue;
      const d = j - 0.5 - at;
      if (d > 0) want = Math.min(want, Math.sqrt(SPEC.cornerSpeed * SPEC.cornerSpeed + 2 * SPEC.accel * d));
    }
    if (want < this.v) {
      this.acc = 0;
      this.v = Math.max(want, this.v - SPEC.accel * 1.8 * dt);
      if (this.v > want + 1e-9 && room < 0.02) this.v = want;
    } else {
      // jerk-limited start: the push builds up over a quarter second
      this.acc = Math.min(SPEC.accel, this.acc + SPEC.jerk * dt);
      this.v = Math.min(want, this.v + this.acc * dt);
    }
    let move = this.v * dt;
    if (move > room) move = room;
    this.seg += move;
    this.meters += move;
    this.battery -= SPEC.battery.perMeter * move;
    while (this.seg >= 1 - 1e-9) {
      this.seg = this.seg - 1 < 1e-9 ? 0 : this.seg - 1;
      this.i++;
      this.cell = path[this.i];
      if (this.i >= path.length - 1 || this.corner(this.i) === 2) {
        this.seg = 0;
        this.v = 0;
        break;
      }
    }
    if (room - move < 1e-9 && max === this.i && this.seg < 1e-6) {
      this.seg = 0;
      if (this.v < 0.05) this.v = 0;
    }
    this.place();
    traffic.releaseBehind(this);
    return this.arrived;
  }

  /** Position and heading from the progress along the path. */
  place() {
    const path = this.path;
    const i = this.i;
    const seg = this.seg;
    if (i >= path.length - 1) {
      const c = center(path[i]);
      this.x = c.x;
      this.y = c.y;
      return;
    }
    if (seg < 0.5 && this.corner(i) === 1) return this.arc(i, 0.5 + seg);
    if (seg >= 0.5 && this.corner(i + 1) === 1) return this.arc(i + 1, seg - 0.5);
    const a = center(path[i]);
    const b = center(path[i + 1]);
    this.x = a.x + (b.x - a.x) * seg;
    this.y = a.y + (b.y - a.y) * seg;
    if (seg > 0) this.h = HEADINGS[dirOf(path[i], path[i + 1])];
  }

  /** On the curve through corner cell j, u from 0 (entry) to 1 (exit). */
  arc(j, u) {
    const p = this.path;
    const c = center(p[j]);
    const d1 = DIRS[dirOf(p[j - 1], p[j])];
    const d2 = DIRS[dirOf(p[j], p[j + 1])];
    const turn = d1[0] * d2[1] - d1[1] * d2[0];
    const [lx, ly] = cornerPoint(u);
    this.x = c.x - 0.5 * d1[0] + lx * d1[0] + ly * d2[0];
    this.y = c.y - 0.5 * d1[1] + lx * d1[1] + ly * d2[1];
    this.h = wrap(Math.atan2(d1[1], d1[0]) + (turn * cornerTurn(u) * Math.PI) / 2);
  }

  holds(cell) {
    return this.held.includes(cell);
  }

  /** Free driving from the keyboard, with walls and the safety field. */
  /**
   * Free driving from the keyboard. The move is swept against walls,
   * racks, uprights, people and other robots with the whole footprint,
   * fork and load included; if it's blocked it slides along whatever is
   * in the way instead of overlapping it.
   */
  drive(ws, others, people, limit, dt) {
    const m = this.manual;
    const want = m.throttle >= 0 ? m.throttle * SPEC.maxSpeed * limit : m.throttle * SPEC.reverse;
    const dv = want - this.v;
    const step = SPEC.accel * 1.6 * dt;
    this.v += Math.abs(dv) <= step ? dv : Math.sign(dv) * step;
    const wantW = m.turn * SPEC.turnRate * 0.8;
    const dw = wantW - this.w;
    const wstep = SPEC.turnAccel * dt;
    this.w += Math.abs(dw) <= wstep ? dw : Math.sign(dw) * wstep;
    const opts = { reach: this.fork.reach, loaded: !!this.load, others, people };
    const from = { x: this.x, y: this.y, h: this.h };
    const h = wrap(this.h + this.w * dt);
    const dx = Math.cos(h) * this.v * dt;
    const dy = Math.sin(h) * this.v * dt;
    // the whole move, then sliding along x or y, then turning on the spot
    const tries = [
      { x: from.x + dx, y: from.y + dy, h },
      { x: from.x + dx, y: from.y, h },
      { x: from.x, y: from.y + dy, h },
      { x: from.x, y: from.y, h },
      { x: from.x + dx, y: from.y + dy, h: from.h },
    ];
    let done = null;
    for (let i = 0; i < tries.length; i++) {
      const res = sweep(ws, from, tries[i], opts);
      if (!res.blocked) {
        done = tries[i];
        // sliding along a wall keeps most of the speed; turning on the spot doesn't
        if (i > 0) this.v *= i < 3 ? 0.97 : 0.4;
        if (i === 4) this.w = 0;
        break;
      }
      if (i === 0) this.bumped = res.blocked;
    }
    if (!done) {
      done = from;
      this.v = 0;
      this.w = 0;
    } else if (done === tries[0]) {
      this.bumped = null;
    }
    const moved = Math.hypot(done.x - from.x, done.y - from.y);
    this.x = done.x;
    this.y = done.y;
    this.h = done.h;
    this.meters += moved;
    this.battery -= SPEC.battery.perMeter * moved;
  }
}
