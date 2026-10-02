// A* over the lane graph. The state is a cell and the way the robot faces,
// because a differential-drive robot has to stop and turn on the spot at
// every corner: a turn costs extra, so of two equally long routes the one
// with fewer corners wins.

import { W, cellX, cellY } from "./warehouse.js";

export const TURN_COST = 0.6;
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function dirOf(a, b) {
  const dx = cellX(b) - cellX(a);
  const dy = cellY(b) - cellY(a);
  return DIRS.findIndex(([x, y]) => x === dx && y === dy);
}

/** Nearest of the four directions to a heading in radians (y down). */
export function dirFromHeading(h) {
  const q = Math.round(h / (Math.PI / 2));
  return ((q % 4) + 4) % 4;
}

class Heap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
// ties broken by insertion order, so the result never depends on the heap
const less = (a, b) => (a.f !== b.f ? a.f < b.f : a.n < b.n);

const manhattan = (a, b) => Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));

/**
 * Cheapest route from `start` (facing `heading`, a direction index) to
 * `goal` along the warehouse's directed lanes. Returns the list of cells
 * from start to goal, or null if the goal can't be reached.
 */
export function plan(warehouse, start, goal, heading = 0) {
  if (start === goal) return [start];
  const states = warehouse.grid.length * 4;
  const g = new Float64Array(states).fill(Infinity);
  const prev = new Int32Array(states).fill(-1);
  const open = new Heap();
  let n = 0;
  const s0 = start * 4 + heading;
  g[s0] = 0;
  open.push({ s: s0, f: manhattan(start, goal), n: n++ });
  while (open.size) {
    const { s } = open.pop();
    const cell = s >> 2;
    const dir = s & 3;
    if (cell === goal) return trace(prev, s);
    for (const next of warehouse.exits[cell]) {
      const d = dirOf(cell, next);
      const turn = d === dir ? 0 : (d + 2) % 4 === dir ? 2 * TURN_COST : TURN_COST;
      const cost = g[s] + 1 + turn;
      const t = next * 4 + d;
      if (cost < g[t]) {
        g[t] = cost;
        prev[t] = s;
        open.push({ s: t, f: cost + manhattan(next, goal), n: n++ });
      }
    }
  }
  return null;
}

function trace(prev, s) {
  const cells = [];
  for (let t = s; t >= 0; t = prev[t]) cells.push(t >> 2);
  return cells.reverse();
}

/** Undirected shortest path for people on foot (walk strips and crosswalks). */
export function walkPath(warehouse, start, goal) {
  const seen = new Int32Array(warehouse.grid.length).fill(-1);
  seen[start] = start;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    if (c === goal) break;
    for (const [dx, dy] of DIRS) {
      const x = cellX(c) + dx;
      const y = cellY(c) + dy;
      const k = y * W + x;
      if (seen[k] >= 0 || !(warehouse.grid[k] === 5 || warehouse.crosswalks.has(k))) continue;
      seen[k] = c;
      queue.push(k);
    }
  }
  if (seen[goal] < 0) return null;
  const path = [];
  for (let c = goal; c !== start; c = seen[c]) path.push(c);
  path.push(start);
  return path.reverse();
}
