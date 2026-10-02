// The warehouse floor: a 26 × 15 grid of one-meter cells. Robots drive on
// one-way lanes (an outer ring run clockwise, three cross aisles and a
// southbound shortcut down the middle), pick from rack bays beside the
// aisles, drop at four docks on the east wall and charge or park in
// side pockets off the west lane. People walk on two strips next to the
// racks and cross the aisles on marked crosswalks.
//
// The layout is fixed; the stock in it comes from the seed.

import { Rng, deriveSeed } from "./rng.js";
import { encode } from "./qr.js";

export const W = 26;
export const H = 15;

export const CELL = {
  WALL: 0,
  LANE: 1,
  RACK: 2,
  DOCK: 3,
  POCKET: 4, // charger or parking spot
  WALK: 5, // pedestrian strip
  STAGING: 6, // inbound pallets, not walkable
};

const RACK_ROWS = [2, 3, 5, 6, 8, 9, 11, 12];
const RACK_COLS = [5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21];
const ROW_LETTER = "ABCDEFGH";
// shelf heights of the three levels, meters to the fork
export const LEVELS = [0.15, 0.85, 1.55];

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
    this.incoming = new Uint8Array(W * H);
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

    const lane = (cells, dx, dy) => {
      for (const [x, y] of cells) set(x, y, CELL.LANE);
      for (const [x, y] of cells) this.link(key(x, y), key(x + dx, y + dy));
    };
    const row = (y, x0, x1) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);
    const col = (x, y0, y1) => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i]);
    // lay out cells first so link() only joins lane to lane
    for (const y of [1, 4, 7, 10, 13]) for (const [x] of row(y, 2, 23)) set(x, y, CELL.LANE);
    for (const x of [2, 13, 23]) for (const [, y] of col(x, 1, 13)) set(x, y, CELL.LANE);
    lane(row(1, 2, 22), 1, 0); // top, east
    lane(row(4, 2, 22), 1, 0); // east
    lane(row(7, 3, 23), -1, 0); // west
    lane(row(10, 2, 22), 1, 0); // east
    lane(row(13, 3, 23), -1, 0); // bottom, west
    lane(col(23, 1, 12), 0, 1); // east side, south
    lane(col(2, 2, 13), 0, -1); // west side, north
    lane(col(13, 1, 12), 0, 1); // middle, south

    RACK_ROWS.forEach((y, r) => {
      // even rack rows face the aisle above them, odd ones the aisle below
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

    for (const x of [3, 4, 22]) {
      for (let y = 2; y <= 12; y++) {
        if (g[key(x, y)] === CELL.LANE) this.crosswalks.add(key(x, y));
        else set(x, y, CELL.WALK);
      }
    }

    [2, 5, 8, 11].forEach((y, i) => {
      set(24, y, CELL.DOCK);
      this.docks.push({ id: i + 1, cell: key(24, y), from: key(23, y), facing: 0 });
    });
    const pocket = (y, list, label) => {
      set(1, y, CELL.POCKET);
      this.link(key(2, y), key(1, y));
      this.link(key(1, y), key(2, y));
      list.push({ id: `${label}${list.length + 1}`, cell: key(1, y), from: key(2, y), owner: null });
    };
    for (const y of [2, 3, 5, 6]) pocket(y, this.parking, "P");
    for (const y of [11, 12]) pocket(y, this.chargers, "C");
  }

  link(a, b) {
    const t = this.grid[b];
    if (t !== CELL.LANE && t !== CELL.POCKET) return;
    if (!this.exits[a].includes(b)) {
      this.exits[a].push(b);
      this.incoming[b]++;
    }
  }

  /** Lane cells where two lanes meet; robots don't stop inside one. */
  isJunction(k) {
    return this.exits[k].length > 1 || this.incoming[k] > 1;
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
