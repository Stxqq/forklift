import { test } from "node:test";
import assert from "node:assert/strict";
import { Warehouse, key } from "../src/sim/warehouse.js";
import { TURN_COST, dirOf, plan, walkPath } from "../src/sim/planner.js";

const ws = new Warehouse(1);
const turns = (path) => {
  let n = 0;
  for (let i = 2; i < path.length; i++) if (dirOf(path[i - 2], path[i - 1]) !== dirOf(path[i - 1], path[i])) n++;
  return n;
};

test("every bay can reach every dock and back to every pocket", () => {
  const stops = [...ws.bays.map((b) => b.from), ...ws.docks.map((d) => d.from), ...ws.parking.map((p) => p.cell), ...ws.chargers.map((c) => c.cell)];
  const unique = [...new Set(stops)];
  for (const a of unique) {
    for (const b of unique) {
      const path = plan(ws, a, b, 0);
      assert.ok(path, `no route from ${a} to ${b}`);
      assert.equal(path[0], a);
      assert.equal(path.at(-1), b);
    }
  }
});

test("routes only use one-way lanes in their direction", () => {
  for (const [a, b] of [[key(5, 1), key(23, 8)], [key(20, 7), key(10, 4)], [key(1, 2), key(23, 11)], [key(23, 5), key(1, 12)]]) {
    const path = plan(ws, a, b, 0);
    for (let i = 1; i < path.length; i++) assert.ok(ws.exits[path[i - 1]].includes(path[i]), `illegal step ${path[i - 1]} -> ${path[i]}`);
  }
});

test("A* finds the cheapest route: cells plus a cost per corner", () => {
  // brute force with Dijkstra over the same state space to compare costs
  const cost = (path, heading) => {
    let c = 0;
    let dir = heading;
    for (let i = 1; i < path.length; i++) {
      const d = dirOf(path[i - 1], path[i]);
      c += 1 + (d === dir ? 0 : (d + 2) % 4 === dir ? 2 * TURN_COST : TURN_COST);
      dir = d;
    }
    return c;
  };
  const dijkstra = (start, goal, heading) => {
    const best = new Map([[start * 4 + heading, 0]]);
    const queue = [[0, start, heading]];
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [g, cell, dir] = queue.shift();
      if (cell === goal) return g;
      for (const next of ws.exits[cell]) {
        const d = dirOf(cell, next);
        const c = g + 1 + (d === dir ? 0 : (d + 2) % 4 === dir ? 2 * TURN_COST : TURN_COST);
        if (c < (best.get(next * 4 + d) ?? Infinity)) {
          best.set(next * 4 + d, c);
          queue.push([c, next, d]);
        }
      }
    }
    return Infinity;
  };
  const cells = [...ws.bays.map((b) => b.from), ...ws.docks.map((d) => d.from)];
  for (let i = 0; i < 40; i++) {
    const a = cells[(i * 7) % cells.length];
    const b = cells[(i * 13 + 5) % cells.length];
    const h = i % 4;
    assert.ok(Math.abs(cost(plan(ws, a, b, h), h) - dijkstra(a, b, h)) < 1e-9);
  }
});

test("corners cost: of two equally long routes it takes the straighter one", () => {
  const path = plan(ws, key(5, 1), key(20, 1), 0);
  assert.equal(turns(path), 0);
  assert.equal(path.length, 16);
});

test("no route into a rack, and a route to where you are is just that cell", () => {
  assert.equal(plan(ws, key(5, 1), ws.bays[0].cell, 0), null);
  assert.deepEqual(plan(ws, key(5, 1), key(5, 1), 0), [key(5, 1)]);
});

test("people walk the strips and cross aisles only at crosswalks", () => {
  const path = walkPath(ws, key(3, 2), key(4, 12));
  assert.ok(path);
  for (const c of path) assert.ok(ws.grid[c] === 5 || ws.crosswalks.has(c));
});
