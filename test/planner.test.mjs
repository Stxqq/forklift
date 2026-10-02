import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/sim/rng.js";
import { Warehouse, key } from "../src/sim/warehouse.js";
import { TIME, dirOf, plan, planTimed, walkPath } from "../src/sim/planner.js";

const ws = new Warehouse(1);
const turns = (path) => {
  let n = 0;
  for (let i = 2; i < path.length; i++) if (dirOf(path[i - 2], path[i - 1]) !== dirOf(path[i - 1], path[i])) n++;
  return n;
};
const stops = [...new Set([...ws.bays.map((b) => b.from), ...ws.docks.map((d) => d.from), ...ws.parking.map((p) => p.cell), ...ws.chargers.map((c) => c.cell)])];

test("every bay can reach every dock and back to every pocket", () => {
  for (const a of stops) {
    for (const b of stops) {
      const path = plan(ws, a, b, 0);
      assert.ok(path, `no route from ${a} to ${b}`);
      assert.equal(path[0], a);
      assert.equal(path.at(-1), b);
    }
  }
});

test("routes keep to the right: every step goes the way its lane runs", () => {
  for (const [a, b] of [[key(5, 2), key(25, 8)], [key(20, 5), key(10, 6)], [key(1, 3), key(25, 12)], [key(25, 4), key(1, 16)]]) {
    const path = plan(ws, a, b, 0);
    for (let i = 1; i < path.length; i++) assert.ok(ws.exits[path[i - 1]].includes(path[i]), `illegal step ${path[i - 1]} -> ${path[i]}`);
  }
});

test("every road runs both ways", () => {
  // east and west along an aisle, north and south along a road
  assert.ok(ws.exits[key(8, 6)].includes(key(9, 6)));
  assert.ok(ws.exits[key(9, 5)].includes(key(8, 5)));
  assert.ok(ws.exits[key(13, 8)].includes(key(13, 9)));
  assert.ok(ws.exits[key(14, 9)].includes(key(14, 8)));
});

test("A* finds the quickest route on an empty floor (checked against Dijkstra)", () => {
  // Dijkstra over the same states and the same time model
  const quickest = (start, goal, heading) => {
    const best = new Map([[`${start},${heading},1`, 0]]);
    const queue = [[0, start, heading, true]];
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [g, cell, dir, rest] = queue.shift();
      if (cell === goal) return g;
      if (g > (best.get(`${cell},${dir},${rest ? 1 : 0}`) ?? Infinity)) continue;
      for (const next of ws.exits[cell]) {
        const d = dirOf(cell, next);
        let c;
        if (rest) c = g + (d === dir ? 0 : (d + 2) % 4 === dir ? TIME.turn180 : TIME.turn90) + TIME.cell + TIME.start;
        else if ((d + 2) % 4 === dir) continue;
        else c = g + TIME.cell + (d === dir ? 0 : TIME.arc);
        const k = `${next},${d},0`;
        if (c < (best.get(k) ?? Infinity)) {
          best.set(k, c);
          queue.push([c, next, d, false]);
        }
      }
    }
    return Infinity;
  };
  for (let i = 0; i < 40; i++) {
    const a = stops[(i * 7) % stops.length];
    const b = stops[(i * 13 + 5) % stops.length];
    if (a === b) continue;
    const h = i % 4;
    const got = planTimed(ws, a, b, h);
    assert.ok(Math.abs(got.eta - TIME.stop - quickest(a, b, h)) < 1e-9, `${a} -> ${b}`);
  }
});

test("corners cost time: of two equally long routes it takes the straighter one", () => {
  const path = plan(ws, key(5, 2), key(20, 2), 0);
  assert.equal(turns(path), 0);
  assert.equal(path.length, 16);
});

test("no route into a rack, and a route to where you are is just that cell", () => {
  assert.equal(plan(ws, key(5, 2), ws.bays[0].cell, 0), null);
  assert.deepEqual(plan(ws, key(5, 2), key(5, 2), 0), [key(5, 2)]);
});

test("space-time A* never plans into someone else's booking", () => {
  const rng = new Rng(4);
  for (let trial = 0; trial < 60; trial++) {
    const a = stops[rng.int(stops.length)];
    const b = stops[rng.int(stops.length)];
    if (a === b) continue;
    const free = planTimed(ws, a, b, 0);
    const reserved = new Map();
    // book a few cells along the quickest route, at the times it would use them
    for (let k = 1; k < free.path.length; k += 2 + rng.int(3)) {
      const t = free.tin[k] + rng.range(-2, 1);
      reserved.set(free.path[k], [[t, t + rng.range(1, 8)]]);
    }
    const got = planTimed(ws, a, b, 0, { reserved });
    assert.ok(got, "found a way");
    for (let k = 1; k < got.path.length; k++) {
      for (const [x, y] of reserved.get(got.path[k]) ?? []) {
        assert.ok(got.tout[k] <= x + 1e-9 || got.tin[k] >= y - 1e-9, `cell ${got.path[k]} at ${got.tin[k].toFixed(2)}–${got.tout[k].toFixed(2)} overlaps ${x.toFixed(2)}–${y.toFixed(2)}`);
      }
    }
    assert.ok(got.eta >= free.eta - 1e-9);
  }
});

test("it waits for a short hold-up and drives round a long one", () => {
  // north up the east road from dock 4 to dock 1
  const start = key(25, 16);
  const goal = key(25, 4);
  const free = planTimed(ws, start, goal, 3);
  const block = key(25, 10);
  assert.ok(free.path.includes(block));
  const k = free.path.indexOf(block);
  const short = planTimed(ws, start, goal, 3, { reserved: new Map([[block, [[0, free.tin[k] + 1.5]]]]) });
  assert.ok(short.path.includes(block), "waited");
  assert.ok(short.eta > free.eta && short.eta < free.eta + 4);
  const long = planTimed(ws, start, goal, 3, { reserved: new Map([[block, [[0, 300]]]]) });
  assert.ok(!long.path.includes(block), "drove round");
  assert.ok(long.eta < free.eta + 40);
});

test("people walk the strips and cross aisles only at crosswalks", () => {
  const path = walkPath(ws, key(4, 3), key(4, 16));
  assert.ok(path);
  for (const c of path) assert.ok(ws.grid[c] === 5 || ws.crosswalks.has(c));
});
