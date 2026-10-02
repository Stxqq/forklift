// The three things the page can do with a World: let one robot work
// through orders, let several take orders from clicks, or hand one to
// the keyboard. Each turns real seconds into fixed 1/60 s steps; the
// speed buttons only change how many steps run per frame.

import { DT, World } from "../sim/world.js";

export const SPEEDS = [1, 4, 16];
export const ROBOT_COUNTS = [2, 3, 4];

class Session {
  constructor({ seed, say = () => {} }) {
    this.seed = seed;
    this.say = say;
    this.speed = 1;
    this.pending = 0;
    this.focusId = 0;
    this.alpha = 1;
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.world = this.build(seed);
    this.pending = 0;
  }

  get focus() {
    return this.world.robots[this.focusId] ?? this.world.robots[0];
  }

  /** Runs as many fixed steps as `dt` real seconds at this speed cover. */
  advance(dt, budgetMs = Infinity) {
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    this.pending += dt * this.speed;
    while (this.pending >= DT) {
      // a slow machine at 16x drops time instead of falling behind; the
      // steps it does run are the same steps, so results don't change
      if (budgetMs !== Infinity && performance.now() - started > budgetMs) {
        this.pending = 0;
        break;
      }
      this.world.step();
      this.pending -= DT;
    }
    // how far the clock is between the last step and the next one, so the
    // page can draw in between: smooth at any refresh rate and any speed
    this.alpha = Math.min(1, this.pending / DT);
    const notices = this.world.notices;
    while (notices.length) this.say(notices.shift().text);
  }
}

export class WatchSession extends Session {
  build(seed) {
    return new World({ seed, mode: "watch", robots: 1 });
  }
}

export class DispatchSession extends Session {
  constructor(options) {
    super(options);
  }

  build(seed) {
    const world = new World({ seed, mode: "dispatch", robots: this.robots ?? 3 });
    // something to watch from the first second: three orders spread out
    const stocked = world.warehouse.bays.filter((b) => world.orderable(b));
    for (const i of [0.15, 0.5, 0.85]) world.orderFor(stocked[Math.floor(stocked.length * i)], "you");
    return world;
  }

  setRobots(n) {
    this.robots = n;
    this.focusId = 0;
    this.reset();
  }

  /** A click on a bay: an order for what the records say is there. */
  order(bay) {
    const w = this.world;
    if (bay.reserved || w.book.active(bay.id)) {
      this.say(`Bay ${bay.id} is already on order`);
      return null;
    }
    if (bay.flagged) {
      this.say(`Bay ${bay.id} is waiting for a manual check`);
      return null;
    }
    const order = w.orderFor(bay, "you");
    if (!order) this.say(`Nothing on record in bay ${bay.id}`);
    else this.say(`Order ${order.id}: ${order.pkg} from ${bay.id} to dock ${order.dock}`);
    return order;
  }
}

export class DriveSession extends Session {
  build(seed) {
    return new World({ seed, mode: "drive", robots: 1 });
  }
}
