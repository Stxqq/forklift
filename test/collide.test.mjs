import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/sim/rng.js";
import { Warehouse, cellX, cellY, key } from "../src/sim/warehouse.js";
import { hit, sweep } from "../src/sim/collide.js";
import { DispatchSession, DriveSession, WatchSession } from "../src/ui/sessions.js";

const ws = new Warehouse(1);

test("a robot fits its lane cell at any heading, fork in, with or without a box", () => {
  for (const cell of [key(8, 6), key(13, 8), key(25, 4), key(1, 3)]) {
    for (let a = 0; a < 2 * Math.PI; a += 0.1) {
      const pose = { x: cellX(cell) + 0.5, y: cellY(cell) + 0.5, h: a };
      assert.equal(hit(ws, pose), null);
      assert.equal(hit(ws, pose, { loaded: true }), null);
    }
  }
});

test("walls, racks and uprights stop the whole footprint, fork and load included", () => {
  // nose into the rack across the aisle
  assert.equal(hit(ws, { x: 8.5, y: 6.75, h: Math.PI / 2 })?.kind, "rack");
  // driving along the aisle, half a cell off to the side
  assert.ok(hit(ws, { x: 8.5, y: 5.2, h: 0 }));
  // the outer wall
  assert.equal(hit(ws, { x: 0.6, y: 3.5, h: 0 })?.kind, "wall");
  // only the load sticks out: the box catches the rack, the bare fork doesn't
  const pose = { x: 8.5, y: 6.5 + 0.08, h: Math.PI / 2 + 0.3 };
  assert.ok(hit(ws, pose, { loaded: true, reach: 0.4 }));
});

test("the fork may reach into a bay only straight through its open face", () => {
  const bay = ws.bays.find((b) => b.id === "C3");
  const p = { x: cellX(bay.from) + 0.5, y: cellY(bay.from) + 0.5, h: bay.facing };
  assert.equal(hit(ws, p, { reach: 1 }), null, "lined up: a pick");
  assert.equal(hit(ws, p, { reach: 1, loaded: true }), null);
  assert.ok(hit(ws, { ...p, h: bay.facing + 0.3 }, { reach: 1 }), "at an angle it hits the rack");
  assert.ok(hit(ws, { ...p, x: p.x + 0.3 }, { reach: 1 }), "off to one side it hits an upright or the next bay");
});

test("other robots and people block too", () => {
  const other = { id: 9, x: 9.15, y: 6.5, h: 0, fork: { reach: 0 }, load: null };
  assert.equal(hit(ws, { x: 8.5, y: 6.5, h: 0 }, { others: [other] })?.kind, "robot");
  assert.equal(hit(ws, { x: 8.5, y: 6.5, h: 0 }, { people: [{ id: 1, x: 9.0, y: 6.5 }] })?.kind, "person");
  assert.equal(hit(ws, { x: 8.5, y: 6.5, h: 0 }, { others: [{ ...other, x: 9.6 }] }), null);
});

test("a sweep stops at the last free pose instead of jumping through", () => {
  const from = { x: 8.5, y: 6.5, h: Math.PI / 2 };
  const res = sweep(ws, from, { x: 8.5, y: 9.5, h: Math.PI / 2 });
  assert.ok(res.blocked);
  assert.ok(res.pose.y < 7.0 && res.pose.y > 6.5);
  assert.equal(hit(ws, res.pose), null);
});

function staticHit(world, r) {
  return hit(world.warehouse, r, {
    reach: r.fork.reach,
    loaded: !!r.load,
    others: world.robots.filter((o) => o !== r),
    people: world.workers,
  });
}

for (const speed of [1, 4, 16]) {
  test(`Watch and Dispatch at ${speed}x: no footprint ever touches a wall, rack, robot or person`, () => {
    const sessions = [new WatchSession({ seed: 5 }), new DispatchSession({ seed: 6 })];
    sessions[1].setRobots(4);
    const bays = sessions[1].world.warehouse.bays.filter((b) => sessions[1].world.orderable(b));
    for (let i = 0; i < 24; i++) sessions[1].order(bays[(i * 7) % bays.length]);
    for (const s of sessions) {
      s.speed = speed;
      for (let frame = 0; frame < (6 * 60 * 60) / speed; frame++) {
        s.advance(1 / 60);
        for (const r of s.world.robots) {
          const blocked = staticHit(s.world, r);
          assert.equal(blocked, null, `robot ${r.id + 1} at ${r.x.toFixed(2)},${r.y.toFixed(2)} in ${r.phase}: ${JSON.stringify(blocked)}`);
        }
      }
      assert.ok(s.world.stats.delivered > 0);
    }
  });

  test(`Drive at ${speed}x: a reckless driver still never overlaps anything, and slides along walls`, () => {
    const s = new DriveSession({ seed: 7 });
    s.speed = speed;
    const rng = new Rng(speed);
    const r = s.focus;
    let moved = 0;
    let last = { x: r.x, y: r.y };
    for (let frame = 0; frame < (4 * 60 * 60) / speed; frame++) {
      // hold the throttle down and change direction now and then
      if (frame % Math.max(1, Math.round(90 / speed)) === 0) {
        r.manual.throttle = rng.chance(0.85) ? 1 : -1;
        r.manual.turn = rng.chance(0.5) ? 0 : rng.sign();
        if (rng.chance(0.1)) s.world.forkCommand(r);
        if (rng.chance(0.1)) s.world.scanCommand(r);
      }
      s.advance(1 / 60);
      moved += Math.hypot(r.x - last.x, r.y - last.y);
      last = { x: r.x, y: r.y };
      const blocked = staticHit(s.world, r);
      assert.equal(blocked, null, `at ${r.x.toFixed(2)},${r.y.toFixed(2)} heading ${r.h.toFixed(2)}: ${JSON.stringify(blocked)}`);
    }
    assert.ok(moved > 20, `drove ${moved.toFixed(1)} m`);
  });
}

test("Drive: pushing diagonally into a wall slides along it", () => {
  const s = new DriveSession({ seed: 3 });
  const r = s.focus;
  // in the top road, heading up and to the right into the north wall
  r.x = 8.5;
  r.y = 1.5;
  r.h = -Math.PI / 4;
  r.manual.throttle = 1;
  const x0 = r.x;
  for (let i = 0; i < 90; i++) s.advance(1 / 60);
  assert.ok(r.x > x0 + 0.3, `slid ${(r.x - x0).toFixed(2)} m along the wall`);
  assert.ok(r.y > 1.0);
  assert.equal(staticHit(s.world, r), null);
});
