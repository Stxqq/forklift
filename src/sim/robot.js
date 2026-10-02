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
  forkSpeed: 0.6, // m/s up and down
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
    this.fork = { height: SPEC.travelHeight, target: SPEC.travelHeight, reach: 0 };
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

  /** Turn on the spot toward `target`; true once facing it. */
  turnTo(target, dt) {
    const err = wrap(target - this.h);
    const step = SPEC.turnRate * dt;
    this.v = 0;
    if (Math.abs(err) <= step) {
      this.h = target;
      this.w = 0;
      return true;
    }
    this.w = Math.sign(err) * SPEC.turnRate;
    this.h = wrap(this.h + this.w * dt);
    this.battery -= SPEC.battery.idle * 4 * dt;
    return false;
  }

  /** Move the fork toward a height and reach; true when both are there. */
  forkTo(height, reach, dt) {
    const f = this.fork;
    f.target = height;
    const dh = height - f.height;
    const step = SPEC.forkSpeed * dt;
    f.height = Math.abs(dh) <= step ? height : f.height + Math.sign(dh) * step;
    const dr = reach - f.reach;
    const rstep = dt / SPEC.reachTime;
    f.reach = Math.abs(dr) <= rstep ? reach : f.reach + Math.sign(dr) * rstep;
    return f.height === height && f.reach === reach;
  }

  /**
   * Drive along the planned cells. `traffic` hands out cell reservations,
   * `limit` (0–1) is the safety field's cap on speed. Returns true on arrival.
   */
  follow(traffic, limit, dt) {
    const path = this.path;
    if (!path || this.i >= path.length - 1) {
      this.v = 0;
      return true;
    }
    const from = path[this.i];
    const to = path[this.i + 1];
    const d = dirOf(from, to);
    if (this.seg === 0) {
      if (!this.turnTo(HEADINGS[d], dt)) return false;
      if (!this.holds(to) && !traffic.request(this, path, this.i + 1)) {
        this.v = 0;
        this.waiting = traffic.blocker;
        return false;
      }
    }
    this.waiting = null;
    // reserve a little further ahead while moving, so a free lane doesn't
    // mean stopping at every cell
    let ahead = this.i + 1;
    while (ahead < path.length - 1 && ahead < this.i + 3 && this.holds(path[ahead])) {
      const next = path[ahead + 1];
      if (dirOf(path[ahead], next) !== d) break;
      if (!this.holds(next) && !traffic.request(this, path, ahead + 1)) break;
      ahead++;
    }
    // room to stop: up to the last reserved cell, or the next corner
    let room = 1 - this.seg;
    for (let j = this.i + 1; j < path.length - 1; j++) {
      const next = path[j + 1];
      if (!this.holds(next) || dirOf(path[j], next) !== d) break;
      room += 1;
    }
    const brake = Math.sqrt(2 * SPEC.accel * room);
    const target = Math.min(SPEC.maxSpeed * limit, brake);
    this.v = target < this.v ? target : Math.min(target, this.v + SPEC.accel * dt);
    let move = this.v * dt;
    if (move > room) move = room;
    this.seg += move;
    this.meters += move;
    this.battery -= SPEC.battery.perMeter * move;
    while (this.seg >= 1 - 1e-9) {
      this.seg = this.seg - 1 < 1e-9 ? 0 : this.seg - 1;
      this.i++;
      this.cell = path[this.i];
      traffic.releaseBehind(this);
      if (this.i >= path.length - 1) {
        this.seg = 0;
        break;
      }
      // a corner: stop on the cell center and turn
      if (dirOf(path[this.i], path[this.i + 1]) !== d) {
        this.seg = 0;
        this.v = 0;
        break;
      }
    }
    const a = center(path[this.i]);
    const nextCell = path[Math.min(this.i + 1, path.length - 1)];
    const b = center(nextCell);
    this.x = a.x + (b.x - a.x) * this.seg;
    this.y = a.y + (b.y - a.y) * this.seg;
    return this.arrived;
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
    this.w = m.turn * SPEC.turnRate * 0.8;
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
