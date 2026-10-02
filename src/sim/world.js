// Everything on the floor, advanced in fixed 1/60 s steps: robots and
// their jobs, the people walking through, the cell reservations that
// keep robots apart, the scanner, the order book and the restocking.
// No DOM; the same code runs the page and the tests.

import { Rng, deriveSeed } from "./rng.js";
import { Warehouse, W, CELL, LEVELS, center, key } from "./warehouse.js";
import { dirFromHeading, plan, walkPath } from "./planner.js";
import { Robot, SPEC, wrap } from "./robot.js";
import { OrderBook, parsePayload } from "./orders.js";
import { decode, rasterize } from "./qr.js";

export const DT = 1 / 60;
export const SCAN_TIME = 0.9;
const RESTOCK_EVERY = 18;
const RELABEL_AFTER = 45;
const LIDAR_EVERY = 6;
const WORKER_TAG = 100;

/** Cell reservations: a robot may only drive into cells it holds. */
export class Traffic {
  constructor(warehouse) {
    this.warehouse = warehouse;
    this.owner = new Int16Array(warehouse.grid.length).fill(-1);
    this.blocker = null;
  }

  claim(cell, tag) {
    this.owner[cell] = tag;
  }

  free(cell, tag) {
    const o = this.owner[cell];
    return o === -1 || o === tag;
  }

  /**
   * Reserve path[j] for a robot. A junction is only taken together with
   * the cell after it, so nobody ever stops inside a crossing and blocks
   * the other lane: that's the yield.
   */
  request(robot, path, j) {
    const cells = [path[j]];
    for (let k = j; k < path.length - 1 && this.warehouse.isJunction(path[k]); k++) cells.push(path[k + 1]);
    for (const c of cells) {
      if (!this.free(c, robot.id)) {
        const o = this.owner[c];
        this.blocker = o >= WORKER_TAG ? { kind: "person", id: o - WORKER_TAG } : { kind: "robot", id: o };
        return false;
      }
    }
    for (const c of cells) {
      this.owner[c] = robot.id;
      if (!robot.held.includes(c)) robot.held.push(c);
    }
    return true;
  }

  /**
   * Hand back the cells behind a robot, but only once its center is a
   * full cell away from them, so whoever moves in next can't touch it,
   * even while it is still swinging round a corner.
   */
  releaseBehind(robot) {
    const keep = [];
    for (const c of robot.held) {
      const at = robot.path.indexOf(c);
      const p = center(c);
      if (at >= 0 && at < robot.i && Math.hypot(robot.x - p.x, robot.y - p.y) >= 0.999) {
        if (this.owner[c] === robot.id) this.owner[c] = -1;
      } else {
        keep.push(c);
      }
    }
    robot.held = keep;
  }

  /** Before a new route: drop everything except the cell it stands on. */
  reset(robot) {
    for (const c of robot.held) if (c !== robot.cell && this.owner[c] === robot.id) this.owner[c] = -1;
    robot.held = [robot.cell];
    this.owner[robot.cell] = robot.id;
  }
}

class Worker {
  constructor(id, cell, rng) {
    const c = center(cell);
    this.id = id;
    this.tag = WORKER_TAG + id;
    this.x = c.x;
    this.y = c.y;
    this.h = Math.PI / 2;
    this.cell = cell;
    this.path = null;
    this.i = 0;
    this.seg = 0;
    this.speed = rng.range(1.0, 1.3);
    this.pause = rng.range(0, 3);
    this.held = [];
    this.prev = { x: this.x, y: this.y, h: this.h };
    this.waiting = false;
    this.moving = false;
  }
}

export class World {
  /**
   * mode: "watch" (one robot, endless orders), "dispatch" (2–4 robots,
   * orders from clicks) or "drive" (one robot on the keyboard).
   */
  constructor({ seed = 1, robots = 1, mode = "watch", workers = 3 } = {}) {
    this.seed = seed;
    this.mode = mode;
    this.time = 0;
    this.steps = 0;
    this.warehouse = new Warehouse(seed);
    this.traffic = new Traffic(this.warehouse);
    this.book = new OrderBook();
    this.rng = {
      orders: new Rng(deriveSeed(seed, "orders")),
      scan: new Rng(deriveSeed(seed, "scan")),
      restock: new Rng(deriveSeed(seed, "restock")),
      workers: new Rng(deriveSeed(seed, "workers")),
      robots: new Rng(deriveSeed(seed, "robots")),
    };
    this.notices = [];
    this.stats = { delivered: 0, scans: 0, failedScans: 0, corrected: 0, picks: 0 };
    this.lastScan = null;
    this.restockIn = RESTOCK_EVERY;

    const ws = this.warehouse;
    this.robots = [];
    for (let i = 0; i < robots; i++) {
      const spot = ws.parking[i];
      const battery = mode === "drive" ? 0.9 : this.rng.robots.range(0.32, 0.6);
      const r = new Robot(i, spot.cell, 0, battery);
      r.home = spot;
      spot.owner = i;
      this.traffic.claim(spot.cell, i);
      if (mode === "drive") r.manual = { throttle: 0, turn: 0 };
      this.robots.push(r);
    }
    this.workers = [];
    const walks = [];
    for (let k = 0; k < ws.grid.length; k++) if (ws.grid[k] === CELL.WALK) walks.push(k);
    this.walkCells = walks;
    const starts = [key(3, 3), key(4, 9), key(22, 6)];
    for (let i = 0; i < workers; i++) this.workers.push(new Worker(i, starts[i % starts.length], this.rng.workers));

    if (mode === "watch" || mode === "drive") this.topUpOrders();
  }

  say(text) {
    this.notices.push({ t: this.time, text });
  }

  // ------------------------------------------------------------- orders

  orderable(bay) {
    return bay.expected && !bay.reserved && !bay.flagged && !this.book.active(bay.id);
  }

  /** Watch keeps three orders waiting; they come from the stock records. */
  topUpOrders() {
    const rng = this.rng.orders;
    while (this.book.queued().length < 3) {
      const options = this.warehouse.bays.filter((b) => this.orderable(b));
      if (!options.length) return;
      this.orderFor(options[rng.int(options.length)], "auto");
    }
  }

  /** An order for whatever the records say is in a bay. */
  orderFor(bay, source = "you") {
    if (!bay.expected) return null;
    const existing = this.book.active(bay.id);
    if (existing) return existing;
    const record = this.warehouse.packages.get(bay.expected);
    if (!record) {
      bay.expected = null;
      return null;
    }
    return this.book.add({ pkg: bay.expected, bay: bay.id, dock: record.dock, source }, this.time);
  }

  // --------------------------------------------------------------- step

  step() {
    const dt = DT;
    this.time = ++this.steps * DT;
    // the state before this step, for drawing between steps
    for (const r of this.robots) {
      const p = r.prev;
      p.x = r.x;
      p.y = r.y;
      p.h = r.h;
      p.fh = r.fork.height;
      p.fr = r.fork.reach;
    }
    for (const w of this.workers) {
      w.prev.x = w.x;
      w.prev.y = w.y;
      w.prev.h = w.h;
    }
    for (const w of this.workers) this.stepWorker(w, dt);
    for (const r of this.robots) {
      const limit = this.safety(r);
      if (r.manual) this.stepManual(r, limit, dt);
      else this.stepRobot(r, limit, dt);
      if (r.battery < 0) r.battery = 0;
    }
    if (this.steps % LIDAR_EVERY === 0) for (const r of this.robots) this.scanLidar(r);

    this.restockIn -= dt;
    if (this.restockIn <= 0) {
      this.restockIn = RESTOCK_EVERY;
      this.warehouse.restock(this.rng.restock);
    }
    for (const bay of this.warehouse.bays) {
      if (bay.flagged && this.time - bay.flagged > RELABEL_AFTER && !bay.reserved) {
        bay.flagged = 0;
        if (bay.pkg) {
          bay.pkg.damage = 0;
          bay.pkg.marks = [];
          bay.expected = bay.pkg.id;
        }
        this.say(`Staff checked bay ${bay.id} and put on a new label`);
      }
    }
    if (this.mode !== "dispatch") this.topUpOrders();
  }

  /**
   * The safety field: how fast a robot may go given who's in front of it.
   * A robot on a route watches the stretch of route ahead of it, bends
   * included; one driven by hand watches straight ahead.
   */
  safety(r) {
    let limit = 1;
    let state = "clear";
    if (r.v < -0.01) {
      r.safety = state;
      return 1;
    }
    const ahead = this.lookahead(r);
    for (const w of this.workers) {
      for (const [px, py, s] of ahead) {
        const d = Math.hypot(w.x - px, w.y - py);
        if (d > 0.95) continue;
        if (s < SPEC.stop && d < SPEC.corridor) {
          limit = 0;
          state = "stop";
        } else {
          limit = Math.min(limit, 0.3 + (0.7 * Math.max(0, s - SPEC.stop)) / (SPEC.slow - SPEC.stop));
          if (state === "clear") state = "slow";
        }
      }
    }
    const c = Math.cos(r.h);
    const sn = Math.sin(r.h);
    for (const o of this.robots) {
      if (o === r) continue;
      const dx = o.x - r.x;
      const dy = o.y - r.y;
      const fwd = dx * c + dy * sn;
      const lat = -dx * sn + dy * c;
      if (fwd > 0 && fwd < 0.85 && Math.abs(lat) < 0.6) {
        limit = 0;
        state = "stop";
      }
    }
    r.safety = state;
    return Math.max(0, limit);
  }

  /** Points along where the robot is about to drive, with the distance to each. */
  lookahead(r) {
    const pts = [];
    const step = 0.25;
    if (r.manual) {
      for (let s = 0.3; s <= SPEC.slow; s += step) pts.push([r.x + Math.cos(r.h) * s, r.y + Math.sin(r.h) * s, s]);
      return pts;
    }
    if (!r.path || r.i >= r.path.length - 1 || !/^to/.test(r.phase)) return pts;
    let px = r.x;
    let py = r.y;
    let s = 0;
    for (let j = r.i + 1; j < r.path.length && s < SPEC.slow; j++) {
      const c = center(r.path[j]);
      const len = Math.hypot(c.x - px, c.y - py);
      for (let t = step; t <= len && s + t <= SPEC.slow; t += step) pts.push([px + ((c.x - px) * t) / len, py + ((c.y - py) * t) / len, s + t]);
      s += len;
      px = c.x;
      py = c.y;
    }
    return pts;
  }

  scanLidar(r) {
    const ws = this.warehouse;
    const n = SPEC.lidarRays;
    const near = [];
    for (const w of this.workers) if (Math.hypot(w.x - r.x, w.y - r.y) < SPEC.lidarRange + 1) near.push([w.x, w.y, 0.26]);
    for (const o of this.robots) if (o !== r && Math.hypot(o.x - r.x, o.y - r.y) < SPEC.lidarRange + 1) near.push([o.x, o.y, 0.36]);
    for (let k = 0; k < n; k++) {
      const a = r.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let d = 0.3;
      for (; d < SPEC.lidarRange; d += 0.08) {
        const px = r.x + ca * d;
        const py = r.y + sa * d;
        if (ws.solidAt(px, py)) break;
        let hit = false;
        for (const [x, y, rad] of near) {
          const ex = px - x;
          const ey = py - y;
          if (ex * ex + ey * ey < rad * rad) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      r.lidar[k] = Math.min(d, SPEC.lidarRange);
    }
  }

  // ------------------------------------------------------------ workers

  stepWorker(w, dt) {
    const ws = this.warehouse;
    w.moving = false;
    if (w.pause > 0) {
      w.pause -= dt;
      return;
    }
    if (!w.path || w.i >= w.path.length - 1) {
      const side = (k) => (k % W > 12 ? 1 : 0);
      const options = this.walkCells.filter((k) => side(k) === side(w.cell) && k !== w.cell);
      const goal = options[this.rng.workers.int(options.length)];
      w.path = walkPath(ws, w.cell, goal);
      w.i = 0;
      w.seg = 0;
      // stop at a shelf for a while, like someone checking stock
      w.pause = this.rng.workers.range(1.5, 5);
      return;
    }
    const next = w.path[w.i + 1];
    if (w.seg === 0 && ws.crosswalks.has(next) && !w.held.includes(next)) {
      const c = center(next);
      const close = this.robots.some((r) => Math.hypot(r.x - c.x, r.y - c.y) < 1.7);
      if (this.traffic.owner[next] !== -1 || close) {
        w.waiting = true;
        return;
      }
      this.traffic.claim(next, w.tag);
      w.held.push(next);
    }
    w.waiting = false;
    w.moving = true;
    const a = center(w.path[w.i]);
    const b = center(next);
    w.h = Math.atan2(b.y - a.y, b.x - a.x);
    w.seg += w.speed * dt;
    if (w.seg >= 1) {
      w.seg = 0;
      w.i++;
      const prev = w.cell;
      w.cell = next;
      if (w.held.includes(prev)) {
        this.traffic.owner[prev] = -1;
        w.held = w.held.filter((c) => c !== prev);
      }
    }
    const p = center(w.path[w.i]);
    const q = center(w.path[Math.min(w.i + 1, w.path.length - 1)]);
    w.x = p.x + (q.x - p.x) * w.seg;
    w.y = p.y + (q.y - p.y) * w.seg;
  }

  // ------------------------------------------------------------- robots

  route(r, goal) {
    this.traffic.reset(r);
    const path = plan(this.warehouse, r.cell, goal, dirFromHeading(r.h));
    if (!path) return false;
    r.setPath(path);
    return true;
  }

  assign(r) {
    const ws = this.warehouse;
    if (r.battery < SPEC.battery.low) {
      const charger = ws.chargers.find((c) => c.owner === null);
      if (charger && r.cell !== charger.cell) {
        charger.owner = r.id;
        r.job = { kind: "charge", spot: charger };
        this.say(`Robot ${r.id + 1}: battery ${Math.round(r.battery * 100)} %, going to charge`);
        if (this.route(r, charger.cell)) r.phase = "toCharge";
        return;
      }
    }
    const order = this.book.queued().find((o) => {
      const bay = ws.bay(o.bay);
      return !bay.reserved;
    });
    if (order) {
      const bay = ws.bay(order.bay);
      const dock = ws.docks[order.dock - 1];
      bay.reserved = true;
      order.started = this.time;
      order.robot = r.id;
      r.job = { kind: "order", order, bay, dock, attempt: 0 };
      if (this.route(r, bay.from)) {
        r.phase = "toPick";
        r.stage = 0;
      }
      return;
    }
    if (r.cell !== r.home.cell) {
      r.job = { kind: "park" };
      if (this.route(r, r.home.cell)) r.phase = "toPark";
      return;
    }
    r.phase = "idle";
    r.stage = -1;
  }

  finish(r) {
    const job = r.job;
    if (job?.kind === "order") {
      job.order.finished = this.time;
      job.bay.reserved = false;
      const status = this.book.status(job.order);
      if (status === "arrived") {
        this.stats.delivered++;
        job.bay.expected = job.bay.expected === job.order.pkg ? null : job.bay.expected;
      }
    }
    r.job = null;
    r.phase = "idle";
  }

  scanLabel(r, pkg) {
    const rng = this.rng.scan;
    const size = pkg.code.size;
    // light from the roof: now and then a hard reflection on the film
    let glare = null;
    if (rng.chance(0.12)) glare = { x: rng.range(2, size - 2), y: rng.range(2, size - 2), r: rng.range(3, 7), strength: rng.range(0.8, 0.97) };
    else if (rng.chance(0.5)) glare = { x: rng.range(0, size), y: rng.range(0, size), r: rng.range(3, 6), strength: rng.range(0.2, 0.4) };
    const image = rasterize(pkg.code, { scale: 4, quiet: 3, marks: pkg.marks, glare, noise: 20, rng });
    const result = decode(image);
    this.stats.scans++;
    if (!result.ok) this.stats.failedScans++;
    else this.stats.corrected += result.corrected;
    r.scan = { robot: r.id, pkg: pkg.id, image, result, t: this.time, attempt: (r.job?.attempt ?? 0) + 1, verdict: null };
    this.lastScan = r.scan;
    return result;
  }

  stepRobot(r, limit, dt) {
    const job = r.job;
    const f = SPEC;
    switch (r.phase) {
      case "idle":
      case "parked":
        r.v = 0;
        r.battery -= f.battery.idle * dt;
        this.assign(r);
        break;
      case "toPark":
        if (r.follow(this.traffic, limit, dt)) {
          r.job = null;
          r.phase = "parked";
        }
        break;
      case "toCharge":
        if (r.follow(this.traffic, limit, dt)) r.phase = "charging";
        break;
      case "charging":
        r.battery = Math.min(1, r.battery + f.battery.charge * dt);
        if (r.battery >= f.battery.full) {
          job.spot.owner = null;
          r.job = null;
          r.phase = "idle";
        }
        break;
      case "toPick":
        if (r.follow(this.traffic, limit, dt)) r.phase = "facePick";
        break;
      case "facePick":
        r.stage = 1;
        if (r.turnTo(job.bay.facing, dt)) r.phase = "raise";
        break;
      case "raise":
        if (r.forkTo(this.shelf(job), 0, dt)) r.phase = "reach";
        break;
      case "reach":
        if (r.forkTo(this.shelf(job), 1, dt)) {
          if (job.bay.pkg) {
            r.phase = "lift";
          } else {
            this.book.log(job.order, "empty", this.time);
            job.bay.expected = null;
            this.say(`Bay ${job.bay.id} is empty: ${job.order.pkg} is missing`);
            r.phase = "retractEmpty";
          }
        }
        break;
      case "lift":
        if (r.forkTo(this.shelf(job) + 0.06, 1, dt)) {
          r.load = job.bay.pkg;
          job.bay.pkg = null;
          r.lifts++;
          this.stats.picks++;
          r.battery -= f.battery.perLift;
          r.phase = "retract";
        }
        break;
      case "retract":
        if (r.forkTo(this.shelf(job) + 0.06, 0, dt)) r.phase = "lower";
        break;
      case "lower":
        if (r.forkTo(f.scanHeight, 0, dt)) {
          r.phase = "scan";
          r.timer = 0;
          r.stage = 2;
        }
        break;
      case "scan":
        this.stepScan(r, dt);
        break;
      case "putBack":
        if (r.forkTo(this.shelf(job) + 0.06, 0, dt)) r.phase = "putReach";
        break;
      case "putReach":
        if (r.forkTo(this.shelf(job) + 0.06, 1, dt)) r.phase = "putSet";
        break;
      case "putSet":
        if (r.forkTo(this.shelf(job), 1, dt)) {
          job.bay.pkg = r.load;
          r.load = null;
          r.phase = "retractEmpty";
        }
        break;
      case "retractEmpty":
        if (r.forkTo(this.shelf(job), 0, dt)) r.phase = "stow";
        break;
      case "stow":
        if (r.forkTo(f.travelHeight, 0, dt)) this.finish(r);
        break;
      case "toDrop":
        if (r.forkTo(f.travelHeight, 0, dt) && r.follow(this.traffic, limit, dt)) r.phase = "faceDock";
        break;
      case "faceDock":
        if (r.turnTo(job.dock.facing, dt)) r.phase = "dropRaise";
        break;
      case "dropRaise":
        if (r.forkTo(f.dockHeight + 0.06, 0, dt)) r.phase = "dropReach";
        break;
      case "dropReach":
        if (r.forkTo(f.dockHeight + 0.06, 1, dt)) r.phase = "dropSet";
        break;
      case "dropSet":
        if (r.forkTo(f.dockHeight, 1, dt)) {
          this.drop(r, job.dock, job.order);
          r.phase = "dropRetract";
        }
        break;
      case "dropRetract":
        if (r.forkTo(f.dockHeight, 0, dt)) {
          r.phase = "confirm";
          r.timer = 0;
          r.stage = 4;
        }
        break;
      case "confirm":
        r.forkTo(f.travelHeight, 0, dt);
        r.timer += dt;
        if (r.timer > 0.6) this.finish(r);
        break;
    }
  }

  shelf(job) {
    return LEVELS[(job.bay.pkg ?? job.load ?? this.warehouse.packages.get(job.order.pkg))?.level ?? 0];
  }

  drop(r, dock, order) {
    const pkg = r.load;
    this.book.log(order, "drop", this.time, { pkg: pkg.id, dock: dock.id });
    r.load = null;
    this.warehouse.packages.delete(pkg.id);
    // it's gone from the building: no record may point at it any more
    for (const bay of this.warehouse.bays) if (bay.expected === pkg.id && !bay.reserved) bay.expected = null;
    const status = this.book.status(order);
    if (status === "arrived") this.say(`${pkg.id} arrived at dock ${dock.id}`);
    else this.say(`${pkg.id} set down at dock ${dock.id}, but order ${order.id} wanted ${order.pkg} at dock ${order.dock}`);
  }

  stepScan(r, dt) {
    const job = r.job;
    if (r.timer === 0) {
      job.load = r.load;
      this.scanLabel(r, r.load);
    }
    r.timer += dt;
    if (r.timer < SCAN_TIME) return;
    const { result } = r.scan;
    const order = job.order;
    if (!result.ok) {
      this.book.log(order, "unreadable", this.time, { reason: result.reason });
      job.attempt++;
      if (job.attempt < 2) {
        r.scan.verdict = "retry";
        r.timer = 0;
        return;
      }
      r.scan.verdict = "manual";
      job.bay.flagged = this.time;
      this.say(`Label on ${order.pkg} in ${job.bay.id} won't read twice: check manually`);
      r.phase = "putBack";
      return;
    }
    this.book.log(order, "scan", this.time, { text: result.text, corrected: result.corrected });
    const label = parsePayload(result.text);
    if (!label || label.id !== order.pkg) {
      r.scan.verdict = "wrong";
      // the records learn what's really in the bay
      job.bay.expected = label ? label.id : null;
      this.say(`Wrong package in ${job.bay.id}: found ${label ? label.id : "an unknown label"}, wanted ${order.pkg}`);
      r.phase = "putBack";
      return;
    }
    r.scan.verdict = "ok";
    if (this.route(r, job.dock.from)) {
      r.phase = "toDrop";
      r.stage = 3;
    }
  }

  // ----------------------------------------------------- drive by hand

  /** What's right in front of the forks: a bay, a dock, or nothing. */
  facing(r) {
    const ws = this.warehouse;
    const fx = r.x + Math.cos(r.h) * 0.9;
    const fy = r.y + Math.sin(r.h) * 0.9;
    const cell = key(Math.floor(fx), Math.floor(fy));
    const near = (from, heading) => {
      const c = center(from);
      return Math.hypot(c.x - r.x, c.y - r.y) < 0.45 && Math.abs(wrap(r.h - heading)) < 0.5;
    };
    const bay = ws.bayAt.get(cell);
    if (bay && near(bay.from, bay.facing)) return { bay };
    const dock = ws.docks.find((d) => d.cell === cell);
    if (dock && near(dock.from, dock.facing)) return { dock };
    return {};
  }

  /** Space in Drive: pick up, put back or set down, depending on what's in front. */
  forkCommand(r) {
    if (r.phase !== "idle" && r.phase !== "carry") return;
    const { bay, dock } = this.facing(r);
    if (bay && !r.load) {
      if (!bay.pkg && !bay.expected) return this.say(`Bay ${bay.id} is empty`);
      const order = this.orderFor(bay, "you") ?? this.book.add({ pkg: "?", bay: bay.id, dock: 0, source: "you" }, this.time);
      order.started ??= this.time;
      order.robot = r.id;
      bay.reserved = true;
      r.job = { kind: "order", order, bay, dock: null, attempt: 0, manual: true };
      r.scanned = false;
      r.phase = "mFace";
      r.stage = 1;
      return;
    }
    if (bay && r.load) {
      if (bay.pkg) return this.say(`Bay ${bay.id} is taken`);
      if (r.job?.bay !== bay) return this.say(`That package came from bay ${r.job?.bay.id}`);
      r.phase = "mPut";
      return;
    }
    if (dock && r.load) {
      if (!r.scanned) return this.say("Scan it first: press S");
      r.job.dock = dock;
      r.phase = "mDrop";
      r.stage = 3;
      return;
    }
    if (r.load) this.say("Drive up to a dock on the right wall to set it down");
    else this.say("Face a bay with a package, close up, and press Space");
  }

  scanCommand(r) {
    if (r.phase !== "carry") {
      if (!r.load) this.say("Pick a package up first: Space at a bay");
      return;
    }
    r.phase = "mScan";
    r.timer = 0;
    r.stage = 2;
  }

  stepManual(r, limit, dt) {
    const job = r.job;
    const f = SPEC;
    const empty = r.battery <= 0;
    if (r.phase === "idle" || r.phase === "carry") {
      r.manual.limit = empty ? 0.25 : limit;
      r.drive((x, y) => this.warehouse.solidAt(x, y), empty ? Math.min(limit, 0.25) : limit, dt);
      const charger = this.warehouse.chargers.find((c) => {
        const p = center(c.cell);
        return Math.hypot(p.x - r.x, p.y - r.y) < 0.4;
      });
      r.charging = !!charger && Math.abs(r.v) < 0.05;
      if (r.charging) r.battery = Math.min(1, r.battery + f.battery.charge * dt);
      else r.battery -= f.battery.idle * dt;
      r.cell = key(Math.floor(r.x), Math.floor(r.y));
      return;
    }
    r.v = 0;
    const height = job ? this.shelf(job) : f.travelHeight;
    switch (r.phase) {
      case "mFace":
        if (r.turnTo(job.bay.facing, dt)) r.phase = "mRaise";
        break;
      case "mRaise":
        if (r.forkTo(height, 0, dt)) r.phase = "mReach";
        break;
      case "mReach":
        if (r.forkTo(height, 1, dt)) {
          if (job.bay.pkg) {
            r.phase = "mLift";
          } else {
            this.book.log(job.order, "empty", this.time);
            job.order.finished = this.time;
            job.bay.expected = null;
            job.bay.reserved = false;
            this.say(`Bay ${job.bay.id} is empty: ${job.order.pkg} is missing`);
            r.phase = "mStowEmpty";
          }
        }
        break;
      case "mLift":
        if (r.forkTo(height + 0.06, 1, dt)) {
          r.load = job.bay.pkg;
          job.load = r.load;
          job.bay.pkg = null;
          r.lifts++;
          this.stats.picks++;
          r.battery -= f.battery.perLift;
          r.phase = "mStow";
        }
        break;
      case "mStow":
        if (r.forkTo(f.scanHeight, 0, dt)) {
          r.phase = "carry";
          r.stage = 2;
          this.say("Got it. Press S to scan the label");
        }
        break;
      case "mStowEmpty":
        if (r.forkTo(f.travelHeight, 0, dt)) {
          r.job = null;
          r.phase = "idle";
          r.stage = -1;
        }
        break;
      case "mScan": {
        if (r.timer === 0) this.scanLabel(r, r.load);
        r.timer += dt;
        if (r.timer < SCAN_TIME) break;
        const { result } = r.scan;
        r.phase = "carry";
        if (!result.ok) {
          this.book.log(job.order, "unreadable", this.time, { reason: result.reason });
          job.attempt++;
          r.scan.verdict = job.attempt >= 2 ? "manual" : "retry";
          this.say(job.attempt >= 2 ? "Unreadable twice: put it back and flag it" : "Couldn't read it. Press S to try again");
          if (job.attempt >= 2) job.bay.flagged = this.time;
          break;
        }
        this.book.log(job.order, "scan", this.time, { text: result.text, corrected: result.corrected });
        const label = parsePayload(result.text);
        if (!label || label.id !== job.order.pkg) {
          r.scan.verdict = "wrong";
          job.bay.expected = label ? label.id : null;
          this.say(`That's ${label ? label.id : "not ours"}, the records said ${job.order.pkg}. Put it back`);
        } else {
          r.scan.verdict = "ok";
          r.scanned = true;
          r.stage = 3;
          this.say(`${label.id} for dock ${label.dock}`);
        }
        break;
      }
      case "mPut":
        if (r.turnTo(job.bay.facing, dt) && r.forkTo(height + 0.06, 1, dt)) {
          job.bay.pkg = r.load;
          r.load = null;
          job.bay.reserved = false;
          // put back unscanned or correct: the order goes back in the queue
          const status = this.book.status(job.order);
          if (status === "transit") {
            job.order.started = null;
            job.order.robot = null;
          } else {
            job.order.finished = this.time;
          }
          r.phase = "mStowEmpty";
        }
        break;
      case "mDrop":
        if (r.turnTo(job.dock.facing, dt) && r.forkTo(f.dockHeight, 1, dt)) {
          this.drop(r, job.dock, job.order);
          job.order.finished = this.time;
          job.bay.reserved = false;
          if (this.book.status(job.order) === "arrived") {
            this.stats.delivered++;
            if (job.bay.expected === job.order.pkg) job.bay.expected = null;
          }
          r.stage = 4;
          r.phase = "mStowEmpty";
        }
        break;
    }
  }

  // ------------------------------------------------------------ queries

  /** Orders shown in the log: newest first. */
  log(limit = 8) {
    return this.book.orders
      .filter((o) => o.started !== null || o.finished !== null)
      .slice(-limit)
      .reverse()
      .map((o) => ({ order: o, status: this.book.status(o) }));
  }
}
