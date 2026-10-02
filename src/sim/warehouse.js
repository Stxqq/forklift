// The warehouse floor: a 28 × 20 grid of one-meter cells. Robots drive on
// two-lane roads with right-hand traffic: five east–west roads (the three
// rack aisles plus one along the top and one along the bottom) and three
// north–south ones. Each lane is one way, so two robots never meet head
// on, but every road runs both ways. They pick from rack bays beside the
// aisles, drop at four docks on the east wall and charge or park in side
// pockets off the west road. People walk on two strips next to the racks
// and cross the aisles on marked crosswalks.
//
// The layout is fixed; the stock in it comes from the seed.

import { Rng, deriveSeed } from "./rng.js";
import { encode } from "./qr.js";

export const W = 28;
export const H = 20;

export const CELL = {
  WALL: 0,
  LANE: 1,
  RACK: 2,
  DOCK: 3,
  POCKET: 4, // charger or parking spot
  WALK: 5, // pedestrian strip
  STAGING: 6, // inbound pallets, not walkable
};

// east–west roads: [upper lane (westbound), lower lane (eastbound)]
export const H_ROADS = [[1, 2], [5, 6], [9, 10], [13, 14], [17, 18]];
// north–south roads: [left lane (southbound), right lane (northbound)]
export const V_ROADS = [[2, 3], [13, 14], [24, 25]];
export const RACK_ROWS = [3, 4, 7, 8, 11, 12, 15, 16];
const RACK_COLS = [5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21, 22];
export const WALK_COLS = [4, 23];
const ROW_LETTER = "ABCDEFGH";
// shelf heights of the three levels, meters to the fork
export const LEVELS = [0.15, 0.85, 1.55];
// boxes stand at the front of a bay, where the fork reaches them
export const BOX_OFFSET = 0.16;

export const key = (x, y) => y * W + x;
export const cellX = (k) => k % W;
export const cellY = (k) => Math.floor(k / W);
export const center = (k) => ({ x: cellX(k) + 0.5, y: cellY(k) + 0.5 });

// a share of the stock that doesn't match the records, the way real
// inventories drift
export const ANOMALIES = { swapped: 0.06, missing: 0.05, scuffed: 0.15, torn: 0.05 };

export class Warehouse {
  constructor(seed = 1) {
    this.seed = seed;
    this.grid = new Uint8Array(W * H);
    this.exits = Array.from({ length: W * H }, () => []);
    // the way each lane cell runs: [dx, dy] along its east–west lane and
    // its north–south lane (0 where it has none)
    this.flow = Array.from({ length: W * H }, () => ({ h: 0, v: 0 }));
    this.bays = [];
    this.bayAt = new Map();
    this.docks = [];
    this.chargers = [];
    this.parking = [];
    this.crosswalks = new Set();
    this.layout();
    this.rng = new Rng(deriveSeed(seed, "stock"));
    this.serial = 400 + this.rng.int(200);
    this.packages = new Map();
    this.stock();
  }

  layout() {
    const g = this.grid;
    const set = (x, y, t) => (g[key(x, y)] = t);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) set(x, y, CELL.STAGING);

    const x0 = V_ROADS[0][0];
    const x1 = V_ROADS[V_ROADS.length - 1][1];
    const y0 = H_ROADS[0][0];
    const y1 = H_ROADS[H_ROADS.length - 1][1];
    for (const [up, down] of H_ROADS) {
      for (let x = x0; x <= x1; x++) {
        set(x, up, CELL.LANE);
        set(x, down, CELL.LANE);
        this.flow[key(x, up)].h = -1;
        this.flow[key(x, down)].h = 1;
      }
    }
    for (const [left, right] of V_ROADS) {
      for (let y = y0; y <= y1; y++) {
        set(left, y, CELL.LANE);
        set(right, y, CELL.LANE);
        this.flow[key(left, y)].v = 1;
        this.flow[key(right, y)].v = -1;
      }
    }
    for (let k = 0; k < W * H; k++) {
      if (g[k] !== CELL.LANE) continue;
      const { h, v } = this.flow[k];
      if (h) this.link(k, k + h);
      if (v) this.link(k, k + v * W);
    }

    RACK_ROWS.forEach((y, r) => {
      // even rack rows face the lane above them, odd ones the lane below
      const faceY = r % 2 === 0 ? y - 1 : y + 1;
      RACK_COLS.forEach((x, c) => {
        set(x, y, CELL.RACK);
        const bay = {
          id: `${ROW_LETTER[r]}${c + 1}`,
          cell: key(x, y),
          from: key(x, faceY),
          facing: Math.atan2(y - faceY, 0),
          pkg: null,
          expected: null,
        };
        this.bays.push(bay);
        this.bayAt.set(bay.cell, bay);
      });
    });

    for (const x of WALK_COLS) {
      for (let y = RACK_ROWS[0]; y <= RACK_ROWS[RACK_ROWS.length - 1]; y++) {
        if (g[key(x, y)] === CELL.LANE) this.crosswalks.add(key(x, y));
        else set(x, y, CELL.WALK);
      }
    }

    [4, 8, 12, 16].forEach((y, i) => {
      set(W - 2, y, CELL.DOCK);
      this.docks.push({ id: i + 1, cell: key(W - 2, y), from: key(W - 3, y), facing: 0 });
    });
    const pocket = (y, list, label) => {
      set(1, y, CELL.POCKET);
      this.link(key(2, y), key(1, y));
      this.link(key(1, y), key(2, y));
      list.push({ id: `${label}${list.length + 1}`, cell: key(1, y), from: key(2, y), owner: null });
    };
    for (const y of [3, 4, 7, 8]) pocket(y, this.parking, "P");
    for (const y of [15, 16]) pocket(y, this.chargers, "C");

    // The two-cell stretches of north–south road between two crossings.
    // Both lanes of one stretch share an id: with U-turns at either end
    // they form a loop of only four cells a robot can stop in, so the
    // traffic rules let at most three robots into one at a time.
    this.stretch = new Int16Array(W * H).fill(-1);
    for (const [left, right] of V_ROADS) {
      for (let y = H_ROADS[0][1] + 1; y < H_ROADS[H_ROADS.length - 1][0]; y++) {
        if (this.isJunction(key(left, y))) continue;
        let y0 = y;
        while (!this.isJunction(key(left, y0 - 1))) y0--;
        this.stretch[key(left, y)] = this.stretch[key(right, y)] = left * 100 + y0;
      }
    }
  }

  link(a, b) {
    const t = this.grid[b];
    if (t !== CELL.LANE && t !== CELL.POCKET) return;
    if (!this.exits[a].includes(b)) this.exits[a].push(b);
  }

  /**
   * Lane cells where two lanes meet; robots don't stop inside one. The
   * side pockets don't count: only their owner ever turns in there.
   */
  isJunction(k) {
    if (this.grid[k] !== CELL.LANE) return false;
    const { h, v } = this.flow[k];
    return h !== 0 && v !== 0;
  }

  /** Cells a robot may not stop in: the crossings. */
  noStop(k) {
    return this.isJunction(k);
  }

  walkable(k) {
    const t = this.grid[k];
    return t === CELL.LANE || t === CELL.POCKET || t === CELL.WALK;
  }

  /** Solid for a robot driving by hand: walls, racks, docks, staging. */
  solidAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const t = this.grid[key(Math.floor(x), Math.floor(y))];
    return t === CELL.WALL || t === CELL.RACK || t === CELL.DOCK || t === CELL.STAGING;
  }

  newPackage(bay, rng = this.rng) {
    const id = `PKG-${String(this.serial).padStart(5, "0")}`;
    this.serial += 1 + rng.int(9);
    const roll = rng.next();
    const damage = roll < ANOMALIES.torn ? 2 : roll < ANOMALIES.torn + ANOMALIES.scuffed ? 1 : 0;
    const pkg = {
      id,
      bay: bay.id,
      dock: 1 + rng.int(this.docks.length),
      level: rng.int(LEVELS.length),
      kg: Math.round(rng.range(2, 24) * 10) / 10,
      damage,
      marks: [],
      code: null,
    };
    pkg.payload = `${pkg.id} ${pkg.bay} D${pkg.dock}`;
    pkg.code = encode(pkg.payload, { level: "M" });
    pkg.marks = damageMarks(pkg, rng);
    this.packages.set(id, pkg);
    return pkg;
  }

  /** Fill about 70 % of the bays, with some records gone stale. */
  stock() {
    const rng = this.rng;
    for (const bay of this.bays) {
      if (!rng.chance(0.7)) continue;
      const pkg = this.newPackage(bay, rng);
      bay.pkg = pkg;
      bay.expected = pkg.id;
    }
    const filled = this.bays.filter((b) => b.pkg);
    for (const bay of filled) {
      if (rng.chance(ANOMALIES.missing)) {
        bay.pkg = null; // the records still say it's there
      } else if (rng.chance(ANOMALIES.swapped / 2)) {
        const other = filled[rng.int(filled.length)];
        if (other !== bay && other.pkg && bay.pkg) [bay.pkg, other.pkg] = [other.pkg, bay.pkg];
      }
    }
  }

  /** A truck delivery: a new package into an empty bay. */
  restock(rng) {
    const empty = this.bays.filter((b) => !b.pkg && !b.expected && !b.reserved);
    if (!empty.length) return null;
    const bay = empty[rng.int(empty.length)];
    const pkg = this.newPackage(bay, rng);
    bay.pkg = pkg;
    bay.expected = pkg.id;
    return bay;
  }

  bay(id) {
    return this.bays.find((b) => b.id === id);
  }
}

/**
 * Damage on a package label, in module coordinates. Scuffs are a few small
 * smudges a scanner can correct; a torn label has a quarter of its data
 * area gone, which is past what level M can recover.
 */
function damageMarks(pkg, rng) {
  const size = pkg.code.size;
  const marks = [];
  if (pkg.damage === 1) {
    for (let i = 0; i < 3; i++) {
      marks.push({
        x: rng.range(10, size - 2),
        y: rng.range(10, size - 2),
        r: rng.range(0.7, 1.1),
        shade: rng.chance(0.5) ? 40 : 225,
      });
    }
  } else if (pkg.damage === 2) {
    marks.push({ x: size * 0.68, y: size * 0.62, w: size * 0.5, h: size * 0.5, shade: 214 });
  }
  return marks;
}
