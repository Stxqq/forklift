// Route planning for travel time, not distance. A* over cells and the way
// the robot faces, timed with the robot's real limits: a cell at cruise
// speed, a corner taken as a slower arc, a turn on the spot, the time to
// get going after a stop. With a reservation table it becomes space-time
// A* (safe-interval path planning): every cell has the stretches of time
// when no other robot is booked on it, and the search may wait in a cell
// for one to open, so a robot weighs waiting a moment against a detour.

import { W, cellX, cellY } from "./warehouse.js";

// seconds, from the robot's spec (1.5 m/s, 1 m/s², 0.8 m/s on an arc,
// 2.2 rad/s turning on the spot)
export const TIME = {
  cell: 1 / 1.5,
  arc: 0.45, // extra for a corner
  start: 0.75, // getting up to speed from a stop, over cruising
  stop: 0.75, // and slowing down at the end
  turn90: 1.0,
  turn180: 1.7,
};

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

// the layout is the same for every seed, so one table per goal will do
const heuristics = new Map();
/** Lower bound on the travel time from every cell to `goal`: cells at cruise speed. */
export function timesTo(ws, goal) {
  const h = heuristics;
  if (h.has(goal)) return h.get(goal);
  const into = Array.from({ length: ws.grid.length }, () => []);
  for (let c = 0; c < ws.grid.length; c++) for (const n of ws.exits[c]) into[n].push(c);
  const dist = new Float64Array(ws.grid.length).fill(Infinity);
  dist[goal] = 0;
  const queue = [goal];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (const p of into[c]) {
      if (dist[p] !== Infinity) continue;
      dist[p] = dist[c] + TIME.cell;
      queue.push(p);
    }
  }
  h.set(goal, dist);
  return dist;
}

/** Merge booked intervals and return the free ones from `now` on. */
function freeIntervals(booked, now) {
  if (!booked || !booked.length) return [[now, Infinity]];
  const list = booked.filter((b) => b[1] > now).sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = now;
  for (const [a, b] of list) {
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  out.push([t, Infinity]);
  return out;
}

/**
 * Space-time A*. `reserved` maps a cell to the [from, to] times other
 * robots are booked on it; the robot stands on `start` at time `now`
 * facing direction `heading` (0 east, 1 south, 2 west, 3 north), at rest.
 * It must be able to stay `dwell` seconds at the goal. Returns
 * { path, tin, tout, eta } (arrival and departure time per cell, eta the
 * time it comes to a stop at the goal) or null.
 */
export function planTimed(ws, start, goal, heading = 0, { now = 0, reserved = null, dwell = 0, trace = null, limit = 40000 } = {}) {
  const h = timesTo(ws, goal);
  if (h[start] === Infinity) return null;
  const cache = new Map();
  const intervals = (c) => {
    let iv = cache.get(c);
    if (!iv) {
      iv = c === start ? [[now, Infinity]] : freeIntervals(reserved?.get(c), now);
      cache.set(c, iv);
    }
    return iv;
  };
  // is cell c free for the whole of [a, b]? the end of that free stretch if so
  const freeOver = (c, a, b) => {
    for (const [s, e] of intervals(c)) if (s <= a + 1e-9 && e >= b - 1e-9) return e;
    return -1;
  };
  const best = new Map();
  const closed = new Set();
  const open = new Heap();
  let n = 0;
  const root = { c: start, d: heading, ii: 0, t: now, rest: true, parent: null, cells: [], times: [] };
  open.push({ node: root, f: now + h[start], n: n++ });
  let expanded = 0;
  while (open.size) {
    const { node } = open.pop();
    const id = `${node.c},${node.d},${node.ii}`;
    if (closed.has(id)) continue;
    closed.add(id);
    trace?.push([1, node.c, node.t]);
    if (++expanded > limit) return null;
    const here = intervals(node.c)[node.ii];
    if (node.c === goal && here[1] - node.t >= dwell) return build(node, dwell);
    // A robot only ever waits on a plain lane cell, never inside a
    // crossing (that would block the other road), so a move runs from
    // here through any crossing to the next plain cell in one go.
    for (const chain of chains(ws, node, goal)) {
      if (chain.cells.some((c) => visits(node, c))) continue;
      const exit = chain.cells[chain.cells.length - 1];
      const iv = intervals(exit);
      for (let jj = 0; jj < iv.length; jj++) {
        const timed = fit(chain, node, iv[jj], here, freeOver);
        if (!timed) continue;
        const arr = timed.arrive[timed.arrive.length - 1];
        const key = `${exit},${chain.dir},${jj}`;
        if (closed.has(key) || (best.get(key) ?? Infinity) <= arr) continue;
        best.set(key, arr);
        const child = { c: exit, d: chain.dir, ii: jj, t: arr, rest: false, parent: node, cells: chain.cells, times: timed.arrive, dep: timed.dep };
        for (const c of chain.cells) trace?.push([0, c, arr]);
        open.push({ node: child, f: arr + h[exit], n: n++ });
      }
    }
  }
  return null;
}

/** Every way from a node's cell through crossings to the next plain cell (or the goal). */
function chains(ws, node, goal) {
  const out = [];
  const walk = (cell, dir, cells, durs, first) => {
    for (const next of ws.exits[cell]) {
      const nd = dirOf(cell, next);
      let dur;
      if (first && node.rest) dur = (nd === dir ? 0 : (nd + 2) % 4 === dir ? TIME.turn180 : TIME.turn90) + TIME.cell + TIME.start;
      else if ((nd + 2) % 4 === dir) continue;
      else dur = TIME.cell + (nd === dir ? 0 : TIME.arc);
      if (cells.includes(next) || next === node.c) continue;
      const c2 = [...cells, next];
      const d2 = [...durs, dur];
      if (next === goal || !ws.noStop(next)) out.push({ cells: c2, durs: d2, dir: nd });
      else if (c2.length < 30) walk(next, nd, c2, d2, false);
    }
  };
  walk(node.c, node.d, [], [], true);
  return out;
}

/**
 * The earliest departure that gets through every cell of a chain while it
 * is free and arrives at the end inside the exit cell's free stretch.
 * Waiting happens before the chain, in the node's own cell.
 */
function fit(chain, node, [s, e], here, freeOver) {
  const k = chain.cells.length;
  let dep = node.t;
  for (let tries = 0; tries < 12; tries++) {
    const waited = dep > node.t + 1e-9 && !node.rest;
    const arrive = [];
    let t = dep + (waited ? TIME.start : 0);
    for (const d of chain.durs) arrive.push((t += d));
    const end = arrive[k - 1];
    if (end > e) return null;
    if (end < s) {
      dep += s - end;
      continue;
    }
    // stays in its own cell until it is half into the next one
    if (arrive[0] - TIME.cell * 0.5 > here[1]) return null;
    let pushed = false;
    for (let j = 0; j < k - 1; j++) {
      const c = chain.cells[j];
      const from = arrive[j];
      const to = arrive[j + 1];
      if (freeOver(c, from, to) < 0) {
        // the earliest moment this crossing cell is free long enough
        const later = nextFree(freeOver, c, from, to - from);
        if (later === Infinity) return null;
        dep += later - from;
        pushed = true;
        break;
      }
    }
    if (!pushed) return { dep, arrive };
  }
  return null;
}

function nextFree(freeOver, c, from, len) {
  // freeOver only answers yes or no; step forward in small hops
  for (let t = from; t < from + 120; t += 0.1) if (freeOver(c, t, t + len) >= 0) return t;
  return Infinity;
}

function visits(node, cell) {
  for (let x = node; x; x = x.parent) if (x.c === cell || x.cells.includes(cell)) return true;
  return false;
}

function build(goal, dwell) {
  const nodes = [];
  for (let x = goal; x; x = x.parent) nodes.push(x);
  nodes.reverse();
  const path = [nodes[0].c];
  const tin = [nodes[0].t];
  const tout = [];
  for (let i = 1; i < nodes.length; i++) {
    const x = nodes[i];
    // leave the previous stop at the planned departure
    tout.push(x.dep);
    x.cells.forEach((c, j) => {
      path.push(c);
      tin.push(x.times[j]);
      if (j + 1 < x.cells.length) tout.push(x.times[j]);
    });
  }
  tout.push(goal.t + dwell);
  return { path, tin, tout, eta: goal.t + TIME.stop };
}

/**
 * Quickest route from `start` (facing direction `heading`) to `goal`
 * along the directed lanes, ignoring everyone else. Returns the cells
 * from start to goal, or null if the goal can't be reached.
 */
export function plan(warehouse, start, goal, heading = 0) {
  if (start === goal) return [start];
  return planTimed(warehouse, start, goal, heading)?.path ?? null;
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
