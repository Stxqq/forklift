import { test } from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/sim/world.js";
import { SPEC } from "../src/sim/robot.js";
import { encode } from "../src/sim/qr.js";

const run = (world, seconds, each = () => {}) => {
  for (let s = 0; s < seconds * 60; s++) {
    world.step();
    each(world);
  }
};

function keepBusy(world) {
  if (world.book.queued().length < world.robots.length) {
    const options = world.warehouse.bays.filter((b) => world.orderable(b));
    if (options.length) world.orderFor(options[world.rng.orders.int(options.length)], "auto");
  }
}

for (const robots of [2, 3, 4]) {
  test(`${robots} robots for 20 minutes: no collisions, no deadlock`, () => {
    for (const seed of [1, 2, 3]) {
      const world = new World({ seed, robots, mode: "dispatch" });
      let closest = Infinity;
      let person = Infinity;
      let lastDelivery = 0;
      let longestGap = 0;
      let delivered = 0;
      run(world, 20 * 60, (w) => {
        keepBusy(w);
        for (let i = 0; i < w.robots.length; i++) {
          const a = w.robots[i];
          for (let j = i + 1; j < w.robots.length; j++) closest = Math.min(closest, Math.hypot(a.x - w.robots[j].x, a.y - w.robots[j].y));
          for (const p of w.workers) person = Math.min(person, Math.hypot(a.x - p.x, a.y - p.y));
          // two robots never hold the same cell
          for (const c of a.held) assert.equal(w.traffic.owner[c], a.id);
        }
        if (w.stats.delivered !== delivered) {
          delivered = w.stats.delivered;
          longestGap = Math.max(longestGap, w.time - lastDelivery);
          lastDelivery = w.time;
        }
      });
      longestGap = Math.max(longestGap, world.time - lastDelivery);
      // centers a full cell apart: bodies plus forks never overlap
      assert.ok(closest >= 0.999, `seed ${seed}: robots ${closest.toFixed(3)} m apart`);
      assert.ok(person >= 0.6, `seed ${seed}: a robot came within ${person.toFixed(2)} m of a person`);
      assert.ok(longestGap < 150, `seed ${seed}: ${longestGap.toFixed(0)} s without a delivery`);
      assert.ok(world.stats.delivered > robots * 9, `seed ${seed}: only ${world.stats.delivered} delivered`);
    }
  });
}

test("Watch delivers, and the log agrees with what physically reached the docks", () => {
  const world = new World({ seed: 5, mode: "watch" });
  const dropped = [];
  const orig = world.drop.bind(world);
  world.drop = (r, dock, order) => {
    dropped.push({ pkg: r.load.id, dock: dock.id, order });
    orig(r, dock, order);
  };
  run(world, 15 * 60);
  const arrived = world.book.orders.filter((o) => world.book.status(o) === "arrived");
  assert.ok(arrived.length >= 8);
  for (const o of arrived) assert.ok(dropped.some((d) => d.order === o && d.pkg === o.pkg && d.dock === o.dock));
  for (const d of dropped) assert.equal(world.book.status(d.order), d.pkg === d.order.pkg && d.dock === d.order.dock ? "arrived" : "wrong");
});

function scenario(prepare) {
  const world = new World({ seed: 9, mode: "dispatch", robots: 1, workers: 0 });
  const bay = world.warehouse.bays.find((b) => b.pkg && b.expected === b.pkg.id && b.pkg.damage === 0);
  prepare(world, bay);
  const order = world.orderFor(bay, "you");
  run(world, 120);
  return { world, bay, order, status: world.book.status(order) };
}

test("a package in the wrong bay is caught by the scan and put back", () => {
  const { world, bay, order, status } = scenario((w, bay) => {
    const other = w.warehouse.bays.find((b) => b.pkg && b !== bay);
    [bay.pkg, other.pkg] = [other.pkg, bay.pkg];
  });
  assert.equal(status, "wrong");
  assert.ok(bay.pkg, "it went back on the shelf");
  assert.equal(bay.expected, bay.pkg.id, "and the records now say what's really there");
  assert.notEqual(bay.pkg.id, order.pkg);
  assert.equal(world.stats.delivered, 0);
});

test("an empty bay is reported missing", () => {
  const { status, world } = scenario((w, bay) => (bay.pkg = null));
  assert.equal(status, "missing");
  assert.equal(world.robots[0].load, null);
});

test("an unreadable label is scanned twice, then flagged for a person", () => {
  const { world, bay, order, status } = scenario((w, bay) => {
    bay.pkg.damage = 2;
    bay.pkg.marks = [{ x: 17, y: 15.5, w: 12.5, h: 12.5, shade: 214 }];
  });
  assert.equal(status, "manual");
  const reads = world.book.byOrder.get(order.id).filter((e) => e.type === "unreadable");
  assert.equal(reads.length, 2);
  assert.ok(world.log(20).some((row) => row.order === order && row.status === "manual"));
  assert.ok(bay.pkg, "back on the shelf");
});

test("a smudged label still reads, with Reed–Solomon doing the work", () => {
  const { world, order, status } = scenario((w, bay) => {
    bay.pkg.damage = 1;
    bay.pkg.marks = [{ x: 14, y: 13, r: 1.1, shade: 40 }, { x: 19, y: 20, r: 1, shade: 225 }];
  });
  assert.equal(status, "arrived");
  const scan = world.book.byOrder.get(order.id).find((e) => e.type === "scan");
  assert.ok(scan.corrected > 0);
});

test("low battery sends the robot to a charger before the next order", () => {
  const world = new World({ seed: 4, mode: "dispatch", robots: 1, workers: 0 });
  world.robots[0].battery = SPEC.battery.low - 0.01;
  const bay = world.warehouse.bays.find((b) => b.expected);
  world.orderFor(bay, "you");
  let charged = false;
  run(world, 200, (w) => {
    if (w.robots[0].phase === "charging") charged = true;
  });
  assert.ok(charged);
  assert.ok(world.robots[0].battery > SPEC.battery.low);
  assert.equal(world.book.status(world.book.orders[0]), "arrived");
});

test("a person in the path stops the robot; one ahead slows it", () => {
  const world = new World({ seed: 2, mode: "dispatch", robots: 1, workers: 1 });
  const r = world.robots[0];
  const p = world.workers[0];
  // driving by hand, so the field looks the full distance ahead
  r.manual = { throttle: 0, turn: 0 };
  r.x = 8.5; r.y = 4.5; r.h = 0;
  p.x = 9.5; p.y = 4.5;
  assert.equal(world.safety(r), 0);
  assert.equal(r.safety, "stop");
  p.x = 11.3;
  const slow = world.safety(r);
  assert.ok(slow > 0 && slow < 1);
  assert.equal(r.safety, "slow");
  p.y = 6.5;
  assert.equal(world.safety(r), 1);
});

test("package labels fit a version 2 code at level M", () => {
  const world = new World({ seed: 1 });
  for (const pkg of world.warehouse.packages.values()) {
    assert.equal(pkg.code.version, 2);
    assert.equal(encode(pkg.payload).version, 2);
  }
});
