import { test } from "node:test";
import assert from "node:assert/strict";
import { Warehouse, center } from "../src/sim/warehouse.js";
import { Robot } from "../src/sim/robot.js";
import { World } from "../src/sim/world.js";
import { WatchSession, DispatchSession } from "../src/ui/sessions.js";
import { buildDynamic, buildStatic, laserFan, occlusionAlpha, ribbonPoints, safetyFan, STRIDE, RACK_TOP } from "../src/render3d/scene.js";
import { STRIDE_LENGTH, walkPhase, wheelAngle, wheelDistances } from "../src/render3d/models.js";
import { Looks } from "../src/render3d/looks.js";
import { CHASE, ChaseCamera, follow, spring } from "../src/render3d/camera.js";
import { lookAt, multiply, perspective, project } from "../src/render3d/math.js";
import { between } from "../src/render/interp.js";

const PARTS = ["floor", "rbox", "cyl", "cap", "shadows", "glows"];

function frame(world, looks, focus, alpha = 0.5, dt = 1 / 60) {
  const views = new Map([...world.robots, ...world.workers].map((o) => [o, between(o, alpha)]));
  const map = looks.update(world, views, { dt, time: world.time, eye: null, reduced: false, shadow: [0, 0] });
  return buildDynamic(world, views, focus, { looks: map, docks: looks.docks, time: world.time });
}

test("the static scene is built the same way every time, and the same for every seed", () => {
  const a = buildStatic(new Warehouse(1));
  const b = buildStatic(new Warehouse(1));
  const c = buildStatic(new Warehouse(99));
  for (const part of PARTS) {
    assert.deepEqual([...a[part].used], [...b[part].used]);
    assert.deepEqual([...a[part].used], [...c[part].used], "the layout doesn't depend on the stock");
    assert.ok(a[part].used.every(Number.isFinite));
  }
  assert.ok(a.rbox.count > 300 && a.floor.count > 300);
  assert.equal(a.rbox.used.length, a.rbox.count * STRIDE);
});

test("racks stand at their true heights, below the camera", () => {
  const { rbox } = buildStatic(new Warehouse(1));
  const d = rbox.used;
  let tallest = 0;
  for (let i = 0; i < rbox.count; i++) tallest = Math.max(tallest, d[i * STRIDE + 1] + d[i * STRIDE + 4] / 2);
  assert.ok(tallest > 1.9 && tallest < 2.6, `tallest ${tallest.toFixed(2)} m`);
  assert.ok(CHASE.height > RACK_TOP + 0.2, "the camera never sits inside a rack");
});

function snapshot(world) {
  return JSON.stringify({
    t: world.time,
    robots: world.robots.map((r) => [r.x, r.y, r.h, r.v, r.phase, r.i, r.seg, r.fork, r.battery, r.held]),
    workers: world.workers.map((w) => [w.x, w.y, w.h, w.walked]),
    events: world.book.events,
  });
}

test("building the moving scene reads the world and never changes it, and is repeatable", () => {
  const world = new World({ seed: 21, mode: "dispatch", robots: 4 });
  const bays = world.warehouse.bays.filter((b) => world.orderable(b));
  for (let i = 0; i < 12; i++) world.orderFor(bays[i * 5], "you");
  for (let s = 0; s < 60 * 40; s++) world.step();
  const before = snapshot(world);
  const one = frame(world, new Looks(), world.robots[0]);
  const two = frame(world, new Looks(), world.robots[0]);
  for (const r of world.robots) {
    ribbonPoints(r, between(r, 0.5));
    safetyFan(r, r);
  }
  assert.equal(snapshot(world), before);
  for (const part of ["rbox", "cyl", "cap", "shadows", "glows"]) {
    assert.deepEqual([...one[part].used], [...two[part].used]);
    assert.ok(one[part].used.every(Number.isFinite));
  }
});

test("the 3D view doesn't change what happens: same run with and without it", () => {
  const run = (render) => {
    const s = new DispatchSession({ seed: 8 });
    s.setRobots(3);
    for (const bay of s.world.warehouse.bays.filter((b) => s.world.orderable(b)).slice(0, 16)) s.order(bay);
    const cam = new ChaseCamera();
    const looks = new Looks();
    for (let f = 0; f < 60 * 120; f++) {
      s.advance(1 / 60);
      if (render) {
        const focus = s.focus;
        cam.update(between(focus, s.alpha), 1 / 60, { moving: Math.abs(focus.v) > 0.15, speed: focus.v / 1.5 });
        frame(s.world, looks, focus, s.alpha);
        ribbonPoints(focus, between(focus, s.alpha));
      }
    }
    return snapshot(s.world);
  };
  assert.equal(run(true), run(false));
});

test("the chase camera's springs are frame-rate independent, settle, and turn the short way", () => {
  // exact: two half steps land where one full step does
  const [x1, v1] = spring(0, 0, 10, 5, 1 / 60);
  const [xa, va] = spring(0, 0, 10, 5, 1 / 120);
  const [x2, v2] = spring(xa, va, 10, 5, 1 / 120);
  assert.ok(Math.abs(x1 - x2) < 1e-12 && Math.abs(v1 - v2) < 1e-12);
  // critically damped: never overshoots
  let x = 0;
  let v = 0;
  for (let i = 0; i < 600; i++) {
    [x, v] = spring(x, v, 1, 5, 1 / 60);
    assert.ok(x <= 1 + 1e-12);
  }
  assert.ok(Math.abs(x - 1) < 1e-6);
  const target = { x: 10, y: 5, h: 0.3 };
  const a = new ChaseCamera();
  const b = new ChaseCamera();
  a.update({ x: 0, y: 0, h: 0 }, 0);
  b.update({ x: 0, y: 0, h: 0 }, 0);
  for (let i = 0; i < 30; i++) a.update(target, 1 / 60);
  for (let i = 0; i < 60; i++) b.update(target, 1 / 120);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.yaw - b.yaw) < 1e-9);
  const c = new ChaseCamera();
  c.update({ x: 0, y: 0, h: Math.PI - 0.05 }, 0);
  for (let i = 0; i < 60; i++) c.update({ x: 0, y: 0, h: -Math.PI + 0.05 }, 1 / 60);
  assert.ok(Math.cos(c.yaw) < -0.99, "stays pointing west");
  c.update({ x: 0, y: 0, h: 1.2 }, 0.5, { moving: false });
  assert.ok(Math.cos(c.yaw) < -0.99, "holds its bearing while the robot turns on the spot");
  assert.ok(follow(3, 0) === 0 && follow(3, 1e9) === 1);
});

test("the robot sits in the lower middle of the frame", () => {
  const cam = new ChaseCamera();
  const { eye, target } = cam.update({ x: 5, y: 5, h: 0 }, 0);
  const m = multiply(perspective(0.82, 1.6, 0.1, 80), lookAt(eye, target));
  const [x, y] = project(m, [5, 0.3, 5]);
  assert.ok(Math.abs(x) < 0.05 && y < -0.1 && y > -0.95, `robot at ${x.toFixed(2)}, ${y.toFixed(2)}`);
});

test("anything between the camera and the robot fades; nothing else does", () => {
  const eye = [0, 2.4, 0];
  const focus = [4, 0.45, 0];
  assert.ok(occlusionAlpha([2, 1.4, 0], eye, focus) < 0.25, "on the line of sight");
  assert.ok(occlusionAlpha([2, 1.4, 1.5], eye, focus) > 0.99, "well off to the side");
  assert.ok(occlusionAlpha([6, 0.5, 0], eye, focus) > 0.99, "behind the robot");
  assert.ok(occlusionAlpha([0.3, 2.2, 0.2], eye, focus) < 0.25, "right at the camera");
  const mid = occlusionAlpha([2, 1.4, 0.65], eye, focus);
  assert.ok(mid > 0.25 && mid < 1, "a soft edge in between");
});

test("wheels turn with the distance rolled, and counter-turn when spinning on the spot", () => {
  assert.ok(Math.abs(wheelAngle(2 * Math.PI * 0.085, 0.085) + 2 * Math.PI) < 1e-12, "one turn per circumference");
  const straight = wheelDistances(3, 0);
  assert.equal(straight.left, 3);
  assert.equal(straight.right, 3);
  const spin = wheelDistances(0, Math.PI / 2);
  assert.ok(spin.left < 0 && spin.right > 0 && Math.abs(spin.left + spin.right) < 1e-12);
  // through the visual state: a robot driving a straight meter
  const world = new World({ seed: 1, mode: "watch", workers: 0 });
  const r = world.robots[0];
  const looks = new Looks();
  const views = new Map([[r, r]]);
  looks.update(world, views, { dt: 1 / 60, time: 0, eye: null, reduced: true, shadow: [0, 0] });
  r.meters += 1;
  const after = looks.update(world, views, { dt: 1 / 60, time: 0, eye: null, reduced: true, shadow: [0, 0] }).get(r);
  assert.equal(after.wheels.left, r.meters);
  assert.equal(after.wheels.right, r.meters);
});

test("the walk cycle follows the distance walked, the same at any speed", () => {
  assert.equal(walkPhase(0), 0);
  assert.ok(Math.abs(walkPhase(STRIDE_LENGTH / 2) - Math.PI) < 1e-12);
  assert.ok(Math.abs(walkPhase(STRIDE_LENGTH * 7.25) - Math.PI / 2) < 1e-9);
  const phases = (speed) => {
    const s = new WatchSession({ seed: 4 });
    s.speed = speed;
    for (let f = 0; f < (60 * 60) / speed; f++) s.advance(1 / 60);
    return s.world.workers.map((w) => walkPhase(w.walked));
  };
  const slow = phases(1);
  assert.ok(slow.some((p) => p > 0));
  assert.deepEqual(phases(16), slow);
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
});

test("the safety fan and the scan laser sit where they should", () => {
  const v = { x: 3, y: 3, h: 0, fh: 0.85, fr: 0 };
  const fan = safetyFan({ safety: "clear" }, v);
  for (let i = 0; i < fan.length; i += 2) assert.ok(fan[i] >= 3 - 1e-9, "all ahead of the robot");
  const laser = laserFan(v, 0.5);
  assert.equal(laser.length, 9);
  assert.ok(laser[1] > laser[4] && laser[0] < laser[3], "from the backrest down and forward onto the label");
});

test("dock doors open as a loaded robot comes up to them", () => {
  const world = new World({ seed: 2, mode: "watch", workers: 0 });
  const r = world.robots[0];
  const dock = world.warehouse.docks[1];
  const looks = new Looks();
  const views = new Map([[r, r]]);
  r.load = { id: "PKG-00001", code: { size: 1, modules: [[false]] } };
  r.x = (dock.from % 28) + 0.5;
  r.y = Math.floor(dock.from / 28) + 0.5;
  for (let i = 0; i < 120; i++) looks.update(world, views, { dt: 1 / 60, time: 0, eye: null, reduced: false, shadow: [0, 0] });
  assert.ok(looks.docks[1] > 0.9 && looks.docks[0] < 0.01);
});
