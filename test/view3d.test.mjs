import { test } from "node:test";
import assert from "node:assert/strict";
import { Warehouse, center } from "../src/sim/warehouse.js";
import { Robot } from "../src/sim/robot.js";
import { World } from "../src/sim/world.js";
import { WatchSession, DispatchSession } from "../src/ui/sessions.js";
import { buildDynamic, buildStatic, ribbonPoints, safetyFan, STRIDE } from "../src/render3d/scene.js";
import { CHASE, ChaseCamera, follow } from "../src/render3d/camera.js";
import { lookAt, multiply, perspective, project } from "../src/render3d/math.js";
import { between } from "../src/render/interp.js";

const opts = { statusColor: () => [0.2, 0.5, 1, 1], beacon: () => true };

test("the static scene is built the same way every time, and the same for every seed", () => {
  const a = buildStatic(new Warehouse(1));
  const b = buildStatic(new Warehouse(1));
  const c = buildStatic(new Warehouse(99));
  for (const part of ["floor", "boxes", "cylinders", "shadows"]) {
    assert.deepEqual([...a[part].used], [...b[part].used]);
    assert.deepEqual([...a[part].used], [...c[part].used], "the layout doesn't depend on the stock");
    assert.ok(a[part].count > 0);
    assert.ok(a[part].used.every(Number.isFinite));
  }
  assert.equal(a.boxes.used.length, a.boxes.count * STRIDE);
});

test("racks stand at their true heights: uprights over the top shelf", () => {
  const { boxes } = buildStatic(new Warehouse(1));
  const d = boxes.used;
  let tallest = 0;
  for (let i = 0; i < boxes.count; i++) tallest = Math.max(tallest, d[i * STRIDE + 1] + d[i * STRIDE + 4]);
  assert.ok(tallest > 1.9 && tallest < 2.6, `tallest ${tallest.toFixed(2)} m`);
});

function snapshot(world) {
  return JSON.stringify({
    t: world.time,
    robots: world.robots.map((r) => [r.x, r.y, r.h, r.v, r.phase, r.i, r.seg, r.fork, r.battery, r.held]),
    workers: world.workers.map((w) => [w.x, w.y, w.h]),
    events: world.book.events,
  });
}

test("building the moving scene reads the world and never changes it", () => {
  const world = new World({ seed: 21, mode: "dispatch", robots: 4 });
  const bays = world.warehouse.bays.filter((b) => world.orderable(b));
  for (let i = 0; i < 12; i++) world.orderFor(bays[i * 5], "you");
  for (let s = 0; s < 60 * 40; s++) world.step();
  const before = snapshot(world);
  const views = new Map([...world.robots, ...world.workers].map((o) => [o, between(o, 0.5)]));
  const one = buildDynamic(world, views, world.robots[0], opts);
  const two = buildDynamic(world, views, world.robots[0], opts);
  for (const r of world.robots) {
    ribbonPoints(r, views.get(r));
    safetyFan(r, views.get(r));
  }
  assert.equal(snapshot(world), before);
  for (const part of ["boxes", "cylinders", "capsules", "shadows", "points"]) assert.deepEqual([...one[part].used], [...two[part].used]);
});

test("the 3D view doesn't change what happens: same run with and without it", () => {
  const run = (render) => {
    const s = new DispatchSession({ seed: 8 });
    s.setRobots(3);
    for (const bay of s.world.warehouse.bays.filter((b) => s.world.orderable(b)).slice(0, 16)) s.order(bay);
    const cam = new ChaseCamera();
    for (let f = 0; f < 60 * 120; f++) {
      s.advance(1 / 60);
      if (render) {
        const views = new Map([...s.world.robots, ...s.world.workers].map((o) => [o, between(o, s.alpha)]));
        const focus = s.focus;
        cam.update(views.get(focus), 1 / 60, { moving: Math.abs(focus.v) > 0.15 });
        buildDynamic(s.world, views, focus, opts);
        ribbonPoints(focus, views.get(focus));
        safetyFan(focus, views.get(focus));
      }
    }
    return snapshot(s.world);
  };
  assert.equal(run(true), run(false));
});

test("the chase camera eases the same at any frame rate and turns the short way", () => {
  const target = { x: 10, y: 5, h: 0.3 };
  const a = new ChaseCamera();
  const b = new ChaseCamera();
  a.update({ x: 0, y: 0, h: 0 }, 0);
  b.update({ x: 0, y: 0, h: 0 }, 0);
  for (let i = 0; i < 30; i++) a.update(target, 1 / 60);
  for (let i = 0; i < 60; i++) b.update(target, 1 / 120);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.yaw - b.yaw) < 1e-9);
  for (let i = 0; i < 600; i++) a.update(target, 1 / 60);
  assert.ok(Math.abs(a.x - 10) < 1e-3 && Math.abs(a.z - 5) < 1e-3 && Math.abs(a.yaw - 0.3) < 1e-3);
  // from just short of +180° to just past it: a small turn, not a spin
  const c = new ChaseCamera();
  c.update({ x: 0, y: 0, h: Math.PI - 0.05 }, 0);
  c.update({ x: 0, y: 0, h: -Math.PI + 0.05 }, 1 / 60);
  assert.ok(Math.abs(Math.cos(c.yaw) + 1) < 0.01, "stays pointing west");
  // it holds its bearing while the robot turns on the spot
  c.update({ x: 0, y: 0, h: 1.2 }, 0.5, { moving: false });
  assert.ok(Math.abs(Math.cos(c.yaw) + 1) < 0.01);
  assert.ok(follow(3, 0) === 0 && follow(3, 1e9) === 1);
});

test("the camera sits behind and above, and the robot lands mid-screen", () => {
  const cam = new ChaseCamera();
  const { eye, target } = cam.update({ x: 5, y: 5, h: 0 }, 0);
  assert.ok(eye[0] < 5 && eye[1] === CHASE.height);
  const m = multiply(perspective(0.86, 1.5, 0.1, 80), lookAt(eye, target));
  const [x, y, z] = project(m, [5, 0, 5]);
  assert.ok(Math.abs(x) < 0.05 && y < 0 && y > -1 && z > -1 && z < 1, `robot at ${x.toFixed(2)}, ${y.toFixed(2)}`);
});

test("the route ribbon runs exactly along the planned path", () => {
  const world = new World({ seed: 5, mode: "watch" });
  for (let s = 0; s < 60 * 3; s++) world.step();
  const r = world.robots[0];
  assert.match(r.phase, /^to/);
  const pts = ribbonPoints(r, r);
  assert.ok(pts.length > 10);
  assert.deepEqual([pts[0].x, pts[0].z], [r.x, r.y]);
  const goal = center(r.path[r.path.length - 1]);
  assert.ok(Math.hypot(pts.at(-1).x - goal.x, pts.at(-1).z - goal.y) < 1e-9);
  // sample the robot's own geometry finely and check every ribbon point is on it
  const probe = new Robot(9, r.path[0]);
  probe.setPath(r.path);
  const truth = [];
  for (let p = r.i + r.seg; p <= r.path.length - 1; p += 0.01) {
    probe.i = Math.min(Math.floor(p), r.path.length - 1);
    probe.seg = probe.i >= r.path.length - 1 ? 0 : p - probe.i;
    probe.place();
    truth.push([probe.x, probe.y]);
  }
  for (const q of pts) {
    const d = Math.min(...truth.map(([x, y]) => Math.hypot(q.x - x, q.z - y)));
    assert.ok(d < 0.02, `ribbon point ${d.toFixed(3)} m off the path`);
  }
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].s > pts[i - 1].s - 1e-12 && pts[i].s - pts[i - 1].s < 0.15);
});

test("the safety fan turns with the robot and shrinks when it stops", () => {
  const r = { safety: "clear" };
  const v = { x: 3, y: 3, h: 0 };
  const fan = safetyFan(r, v);
  assert.equal(fan.length % 6, 0);
  for (let i = 0; i < fan.length; i += 2) assert.ok(fan[i] >= 3 - 1e-9, "all ahead of it");
  const stop = safetyFan({ safety: "stop" }, v);
  assert.ok(Math.max(...stop.filter((_, i) => i % 2 === 0)) < Math.max(...fan.filter((_, i) => i % 2 === 0)));
});

test("a watch session and the scene agree on what's on the shelves", () => {
  const s = new WatchSession({ seed: 3 });
  const views = new Map([...s.world.robots, ...s.world.workers].map((o) => [o, o]));
  const d = buildDynamic(s.world, views, s.focus, opts);
  const stocked = s.world.warehouse.bays.filter((b) => b.pkg).length;
  // a pallet and a box per stocked bay, plus robot parts and the target outline
  assert.ok(d.boxes.count >= stocked * 2);
});
