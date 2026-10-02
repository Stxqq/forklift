import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchSession, DriveSession, WatchSession } from "../src/ui/sessions.js";

// The speed buttons only change how many fixed 1/60 s steps run per
// frame. Ten simulated minutes have to come out bit for bit the same.
function snapshot(session) {
  const w = session.world;
  return {
    time: w.time,
    events: w.book.events,
    robots: w.robots.map((r) => [r.x, r.y, r.h, r.battery, r.meters, r.phase]),
    workers: w.workers.map((p) => [p.x, p.y]),
    stats: w.stats,
  };
}

function run(Session, speed, setup = () => {}) {
  const session = new Session({ seed: 42 });
  setup(session);
  session.speed = speed;
  const frames = (10 * 60 * 60) / speed;
  for (let i = 0; i < frames; i++) session.advance(1 / 60);
  return snapshot(session);
}

test("Watch at 16x gives the same ten minutes as at 1x", () => {
  const slow = run(WatchSession, 1);
  assert.ok(slow.events.length > 8);
  assert.deepEqual(run(WatchSession, 16), slow);
  assert.deepEqual(run(WatchSession, 4), slow);
});

test("Dispatch with four robots at 16x gives the same as at 1x", () => {
  const setup = (s) => {
    s.setRobots(4);
    for (const bay of s.world.warehouse.bays.filter((b) => s.world.orderable(b)).slice(0, 30)) s.order(bay);
  };
  const slow = run(DispatchSession, 1, setup);
  assert.deepEqual(run(DispatchSession, 16, setup), slow);
});

test("same seed, same warehouse; another seed, another one", () => {
  const a = new WatchSession({ seed: 7 }).world.warehouse;
  const b = new WatchSession({ seed: 7 }).world.warehouse;
  const c = new WatchSession({ seed: 8 }).world.warehouse;
  const stock = (ws) => ws.bays.map((bay) => `${bay.id}:${bay.pkg?.id ?? "-"}:${bay.expected ?? "-"}`).join(",");
  assert.equal(stock(a), stock(b));
  assert.notEqual(stock(a), stock(c));
  assert.ok(new DriveSession({ seed: 7 }).focus.manual);
});
