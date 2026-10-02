// The forklift robot: a differential-drive base (it turns on the spot),
// a mast with a fork that lifts and reaches, a 270° lidar and a label
// scanner. Kinematics only, in SI units, one fixed step at a time.

import { LEVELS, center } from "./warehouse.js";
import { dirOf } from "./planner.js";

export const SPEC = {
  length: 0.72, // body, meters
  width: 0.56,
  forkLength: 0.32,
  maxSpeed: 1.5, // m/s
  reverse: 0.6,
  accel: 1.0, // m/s²
  turnRate: 2.2, // rad/s on the spot
  turnAccel: 7, // rad/s²
  cornerSpeed: 0.8, // m/s on a corner arc
  jerk: 4, // m/s³
  forkSpeed: 0.6, // m/s up and down
  forkAccel: 1.6,
  reachTime: 0.7, // s to slide the fork in or out
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

export const HEADINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

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

  get pose() {
    return { x: this.x, y: this.y, h: this.h };
  }

  /** Where the fork tips are, for scanning and picking. */
  get forkTip() {
    const d = SPEC.length / 2 + SPEC.forkLength * (0.6 + 0.4 * this.fork.reach);
    return { x: this.x + Math.cos(this.h) * d, y: this.y + Math.sin(this.h) * d };
  }

  setPath(path) {
    this.path = path;
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
   * as quarter circles through the corner cell; the robot only turns on
   * the spot at the start of a route. Returns true on arrival.
   */
  follow(traffic, limit, dt) {
    const path = this.path;
    if (!path || this.i >= path.length - 1) {
      this.v = 0;
      return true;
    }
    if (this.seg === 0) {
      const d = dirOf(path[this.i], path[this.i + 1]);
      if (this.corner(this.i) !== 1 && !this.turnTo(HEADINGS[d], dt)) return false;
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
    for (let j = this.i + 1; j < path.length && j <= this.i + 3; j++) {
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

  /** On the quarter circle through corner cell j, u from 0 (entry) to 1 (exit). */
  arc(j, u) {
    const p = this.path;
    const c = center(p[j]);
    const d1 = DIRS[dirOf(p[j - 1], p[j])];
    const d2 = DIRS[dirOf(p[j], p[j + 1])];
    const turn = d1[0] * d2[1] - d1[1] * d2[0];
    const ox = c.x - 0.5 * d1[0] + 0.5 * d2[0];
    const oy = c.y - 0.5 * d1[1] + 0.5 * d2[1];
    const a = Math.atan2(-d2[1], -d2[0]) + (turn * u * Math.PI) / 2;
    this.x = ox + 0.5 * Math.cos(a);
    this.y = oy + 0.5 * Math.sin(a);
    this.h = wrap(Math.atan2(d1[1], d1[0]) + (turn * u * Math.PI) / 2);
  }

  /** Meters of straight path left before the next corner or the end. */
  straightAhead() {
    const path = this.path;
    if (!path || this.i >= path.length - 1) return 0;
    const d = dirOf(path[this.i], path[this.i + 1]);
    let run = 1 - this.seg;
    for (let j = this.i + 1; j < path.length - 1 && dirOf(path[j], path[j + 1]) === d; j++) run += 1;
    return run;
  }

  holds(cell) {
    return this.held.includes(cell);
  }

  /** Free driving from the keyboard, with walls and the safety field. */
  drive(solidAt, limit, dt) {
    const m = this.manual;
    const want = m.throttle >= 0 ? m.throttle * SPEC.maxSpeed * limit : m.throttle * SPEC.reverse;
    const dv = want - this.v;
    const step = SPEC.accel * 1.6 * dt;
    this.v += Math.abs(dv) <= step ? dv : Math.sign(dv) * step;
    const wantW = m.turn * SPEC.turnRate * 0.8;
    const dw = wantW - this.w;
    const wstep = SPEC.turnAccel * dt;
    this.w += Math.abs(dw) <= wstep ? dw : Math.sign(dw) * wstep;
    const h = wrap(this.h + this.w * dt);
    const nx = this.x + Math.cos(h) * this.v * dt;
    const ny = this.y + Math.sin(h) * this.v * dt;
    const r = SPEC.width / 2 + 0.04;
    const blocked = (x, y) => {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (solidAt(x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
      }
      return false;
    };
    this.h = h;
    let moved = 0;
    if (!blocked(nx, ny)) {
      moved = Math.hypot(nx - this.x, ny - this.y);
      this.x = nx;
      this.y = ny;
    } else if (!blocked(nx, this.y)) {
      moved = Math.abs(nx - this.x);
      this.x = nx;
      this.v *= 0.7;
    } else if (!blocked(this.x, ny)) {
      moved = Math.abs(ny - this.y);
      this.y = ny;
      this.v *= 0.7;
    } else {
      this.v = 0;
    }
    this.meters += moved;
    this.battery -= SPEC.battery.perMeter * moved;
  }

  forkHeightFor(level) {
    return LEVELS[level];
  }
}
