// The 3D models, built as hierarchies of instanced parts: rounded boxes,
// cylinders and capsules, each with a transform under its parent so the
// wheels can roll, the casters swivel, the mast extend and a person walk.
// Every function here is pure: what it draws follows only from its
// arguments, so the tests can check the animation maths.

import { FORK, LOAD } from "../sim/collide.js";
import { T, compose, qIdentity, qMul, qRotate, qX, qY, qZ, rootOf } from "./quat.js";

// one instance: center, size, rotation (quaternion), rgba, material, bevel radius
export const STRIDE = 16;
export const MAT = { MATTE: 0, EMISSIVE: 1, PAINT: 2, METAL: 3, FLOOR: 4, UPRIGHT: 5, CARDBOARD: 6, RUBBER: 7 };
// added to the material of parts that fade when they stand between the
// camera and the robot it follows
export const FADES = 100;

export const rgb = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a];

export const COLORS = {
  floor: rgb("#161618"),
  lane: rgb("#1b1b1e"),
  wall: rgb("#28282c"),
  line: rgb("#b4b4bc", 0.85),
  yellow: rgb("#d9ad3f", 0.95),
  walk: rgb("#8c7550", 0.8),
  upright: rgb("#4f5560"),
  beam: rgb("#a2683f"),
  wood: rgb("#a08a68"),
  woodDark: rgb("#7e6a4f"),
  cardboard: [rgb("#c8a473"), rgb("#bf9a68"), rgb("#d2b384")],
  tape: rgb("#dcc49a"),
  label: rgb("#f2f2f0"),
  paint: rgb("#d8d9dd"),
  paintDark: rgb("#8e9098"),
  metal: rgb("#a6a8b0"),
  steel: rgb("#7d8089"),
  dark: rgb("#2a2b30"),
  rubber: rgb("#141416"),
  shirt: rgb("#5d6370"),
  trousers: rgb("#2e3440"),
  skin: rgb("#c9a487"),
  vest: rgb("#e0a83a"),
  reflect: rgb("#e6e6e6"),
  hatWhite: rgb("#f1f1f1"),
  hatYellow: rgb("#e7c13e"),
  board: rgb("#5a5e68"),
  dock: rgb("#55575e"),
  door: rgb("#6b6e76"),
  charger: rgb("#5f6169"),
  brass: rgb("#b39a62"),
  blue: rgb("#3b82f6"),
  amber: rgb("#f59e0b"),
  red: rgb("#ef4444"),
  green: rgb("#22c55e"),
  black: rgb("#0f0f11"),
  white: rgb("#f4f4f6"),
};

export class Instances {
  constructor(capacity = 256) {
    this.data = new Float32Array(capacity * STRIDE);
    this.count = 0;
  }

  /** One part in world space: center, size, rotation. */
  add(c, s, q, color, mat = MAT.MATTE, radius = 0) {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count++ * STRIDE;
    const d = this.data;
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
    d[o + 3] = s[0];
    d[o + 4] = s[1];
    d[o + 5] = s[2];
    d[o + 6] = q[0];
    d[o + 7] = q[1];
    d[o + 8] = q[2];
    d[o + 9] = q[3];
    d[o + 10] = color[0];
    d[o + 11] = color[1];
    d[o + 12] = color[2];
    d[o + 13] = color[3];
    d[o + 14] = mat;
    d[o + 15] = Math.min(radius, s[0] / 2, s[1] / 2, s[2] / 2);
  }

  /** A part under transform t, centered at `at` in t's frame, turned by `q` there. */
  part(t, at, s, color, mat, radius = 0, q = null) {
    const w = qRotate(t.q, at);
    this.add([t.p[0] + w[0], t.p[1] + w[1], t.p[2] + w[2]], s, q ? qMul(t.q, q) : t.q, color, mat, radius);
  }

  get used() {
    return this.data.subarray(0, this.count * STRIDE);
  }
}

/** All the instance lists of a scene. */
export const bucket = () => ({
  rbox: new Instances(1024),
  cyl: new Instances(128),
  cap: new Instances(128),
  shadows: new Instances(128),
  glows: new Instances(32),
});

// a cylinder's axis is y; this lays it along z, the way a wheel sits
const ALONG_Z = qX(Math.PI / 2);

/** A wooden pallet: three runners, five deck boards. */
export function pallet(sc, t, w = 0.62, d = 0.56, detail = true) {
  if (!detail) {
    sc.rbox.part(t, [0, 0.06, 0], [w, 0.12, d], COLORS.wood, MAT.MATTE);
    return;
  }
  for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) sc.rbox.part(t, [0, 0.04, z], [w, 0.08, 0.08], COLORS.woodDark, MAT.MATTE, 0.006);
  for (let i = 0; i < 5; i++) {
    const z = -d / 2 + 0.045 + (i * (d - 0.09)) / 4;
    sc.rbox.part(t, [0, 0.1, z], [w, 0.022, 0.09], COLORS.wood, MAT.MATTE, 0.004);
  }
}

/** A cardboard box with a tape strip over the lid and a label patch. */
export function carton(sc, t, size, tone, detail = true, fade = 0) {
  const [sx, sy, sz] = size;
  sc.rbox.part(t, [0, sy / 2, 0], size, COLORS.cardboard[tone % 3], MAT.CARDBOARD + fade, 0.012);
  if (!detail) return;
  sc.rbox.part(t, [0, sy + 0.001, 0], [sx + 0.004, 0.003, 0.06], COLORS.tape, MAT.MATTE + fade, 0.001);
  sc.rbox.part(t, [-sx * 0.22, sy + 0.002, sz * 0.25], [0.12, 0.003, 0.09], COLORS.label, MAT.MATTE + fade, 0.002);
}

/** Wheel spin from the distance rolled: one turn per circumference. */
export const wheelAngle = (distance, radius) => -distance / radius;

/**
 * How far each drive wheel has rolled: the distance driven, plus or minus
 * the heading turned (unwrapped, radians) times half the wheel track.
 */
export function wheelDistances(meters, turned, halfTrack = 0.255) {
  return { left: meters - turned * halfTrack, right: meters + turned * halfTrack };
}

/**
 * The robot. `v` is its interpolated pose and fork, `look` the visual
 * state: wheel distances, caster angle, lidar and beacon spin, beacon on,
 * nose dip, LED color, and whether to draw every detail.
 */
export function robot(sc, r, v, look) {
  const { detail, led } = look;
  const fh = v.fh;
  const reach = v.fr * FORK.reach;
  const root = rootOf(v.x, v.y, v.h);
  // a tiny nose dip when braking, about the rear axle
  const body = compose(root, T([0, 0, 0], qZ(-look.dip)));
  const paint = MAT.PAINT;
  sc.shadows.add([v.x + Math.cos(v.h) * 0.06 + look.shadow[0], 0, v.y + Math.sin(v.h) * 0.06 + look.shadow[1]], [1.0, 1, 0.78], qY(-v.h), [0, 0, 0, 0.7], 0, 0.26);
  sc.glows.add([v.x, 0, v.y], [1.15, 1, 0.9], qY(-v.h), [led[0], led[1], led[2], 0.16], 0, 0.4);

  // chassis, bumper and the light strip round it
  sc.rbox.part(body, [-0.155, 0.205, 0], [0.39, 0.29, 0.52], COLORS.paint, paint, 0.06);
  sc.rbox.part(body, [-0.155, 0.075, 0], [0.405, 0.05, 0.535], COLORS.rubber, MAT.RUBBER, 0.022);
  sc.rbox.part(body, [-0.155, 0.285, 0], [0.396, 0.014, 0.526], led, MAT.EMISSIVE, 0.06);
  // outriggers forward, with swivel casters at their tips
  for (const side of [-1, 1]) {
    sc.rbox.part(body, [0.19, 0.075, side * 0.225], [0.34, 0.07, 0.07], COLORS.paintDark, paint, 0.02);
    const pivot = compose(body, T([0.31, 0.06, side * 0.225], qY(-look.caster)));
    sc.rbox.part(pivot, [0, 0.0, 0], [0.04, 0.03, 0.05], COLORS.steel, MAT.METAL, 0.006);
    sc.cyl.part(pivot, [-0.02, -0.025, 0], [0.05, 0.025, 0.05], COLORS.rubber, MAT.RUBBER, 0, qMul(qZ(wheelAngle(look.meters, 0.025)), ALONG_Z));
  }
  // drive wheels with hubs and spokes that turn with the distance rolled
  for (const [side, dist] of [[-1, look.wheels.left], [1, look.wheels.right]]) {
    const axle = compose(body, T([-0.08, 0.085, side * 0.262], qZ(wheelAngle(dist, 0.085))));
    sc.cyl.part(axle, [0, 0, 0], [0.17, 0.042, 0.17], COLORS.rubber, MAT.RUBBER, 0, ALONG_Z);
    if (detail) {
      sc.cyl.part(axle, [0, 0, side * 0.004], [0.09, 0.044, 0.09], COLORS.metal, MAT.METAL, 0, ALONG_Z);
      sc.rbox.part(axle, [0, 0, side * 0.024], [0.12, 0.018, 0.004], COLORS.steel, MAT.METAL, 0.003);
      sc.rbox.part(axle, [0, 0, side * 0.024], [0.018, 0.12, 0.004], COLORS.steel, MAT.METAL, 0.003);
    }
  }
  // mast: outer rails, inner rails that rise with the fork above a meter
  const top = Math.max(1.25, fh + 0.85);
  for (const side of [-1, 1]) {
    sc.rbox.part(body, [0.06, 0.1 + 0.625, side * 0.195], [0.045, 1.25, 0.04], COLORS.metal, MAT.METAL, 0.008);
    if (top > 1.26) sc.rbox.part(body, [0.075, (0.35 + top) / 2, side * 0.165], [0.035, top - 0.35, 0.032], COLORS.metal, MAT.METAL, 0.006);
  }
  sc.rbox.part(body, [0.065, top, 0], [0.05, 0.045, 0.43], COLORS.metal, MAT.METAL, 0.01);
  sc.rbox.part(body, [0.06, 0.62, 0], [0.04, 0.035, 0.39], COLORS.steel, MAT.METAL, 0.008);
  // carriage with backrest grille, and the two tapered tines
  const carriage = compose(body, T([FORK.x0 + reach - 0.015, fh, 0]));
  sc.rbox.part(carriage, [0, 0.13, 0], [0.025, 0.26, 0.42], COLORS.steel, MAT.METAL, 0.006);
  if (detail) {
    for (const z of [-0.19, -0.095, 0, 0.095, 0.19]) sc.rbox.part(carriage, [0, 0.4, z], [0.014, 0.3, 0.014], COLORS.dark, MAT.METAL, 0.004);
    sc.rbox.part(carriage, [0, 0.555, 0], [0.018, 0.02, 0.4], COLORS.dark, MAT.METAL, 0.005);
  }
  for (const side of [-1, 1]) {
    sc.rbox.part(carriage, [0.13, 0.018, side * 0.11], [0.26, 0.036, 0.07], COLORS.metal, MAT.METAL, 0.008);
    sc.rbox.part(carriage, [0.29, 0.012, side * 0.11], [0.07, 0.022, 0.06], COLORS.metal, MAT.METAL, 0.006);
  }
  // the load seated on the tines
  if (r.load) {
    const s = LOAD.x1 - LOAD.x0;
    const boxT = compose(carriage, T([(LOAD.x0 + LOAD.x1) / 2 - FORK.x0 + 0.015, 0.036, 0]));
    carton(sc, boxT, [s, 0.3, s], tone(r.load.id), detail);
    if (detail && look.qr) {
      // the label's real modules, on the lid, read from behind the robot
      const code = r.load.code;
      const q = 0.2;
      const m = q / code.size;
      sc.rbox.part(boxT, [0.0, 0.303, 0], [q + 0.03, 0.003, q + 0.03], COLORS.label, MAT.EMISSIVE);
      for (let y = 0; y < code.size; y++) {
        for (let x = 0; x < code.size; x++) {
          if (code.modules[y][x]) sc.rbox.part(boxT, [q / 2 - (y + 0.5) * m, 0.305, -q / 2 + (x + 0.5) * m], [m, 0.002, m], COLORS.black, MAT.EMISSIVE);
        }
      }
    }
  }
  if (!detail) return { carriage, top };
  // lidar puck, slowly turning, with a notch so you can see it turn
  sc.cyl.part(body, [-0.09, 0.375, 0], [0.13, 0.05, 0.13], COLORS.dark, MAT.MATTE);
  const spin = compose(body, T([-0.09, 0.405, 0], qY(look.lidar)));
  sc.cyl.part(spin, [0, 0, 0], [0.1, 0.012, 0.1], COLORS.metal, MAT.METAL);
  sc.rbox.part(spin, [0.04, 0.004, 0], [0.03, 0.008, 0.016], [0.55, 0.75, 1, 1], MAT.EMISSIVE, 0.003);
  // beacon: an amber dome with a turning reflector, lit while it moves
  sc.cyl.part(body, [-0.27, 0.36, -0.165], [0.06, 0.012, 0.06], COLORS.dark, MAT.MATTE);
  sc.cap.part(body, [-0.27, 0.39, -0.165], [0.05, 0.05, 0.05], look.beacon ? [1, 0.68, 0.15, 1] : rgb("#6b4e12"), look.beacon ? MAT.EMISSIVE : MAT.PAINT);
  if (look.beacon) {
    const reflector = compose(body, T([-0.27, 0.39, -0.165], qY(look.beaconSpin)));
    sc.rbox.part(reflector, [0.012, 0, 0], [0.024, 0.03, 0.006], [1, 0.9, 0.6, 1], MAT.EMISSIVE, 0.002);
  }
  // emergency stop, ID plate, safety scanner window, charging contacts
  sc.cyl.part(body, [-0.27, 0.358, 0.165], [0.066, 0.016, 0.066], rgb("#e6c229"), MAT.PAINT);
  sc.cap.part(body, [-0.27, 0.373, 0.165], [0.046, 0.03, 0.046], COLORS.red, MAT.PAINT);
  sc.rbox.part(body, [-0.22, 0.352, 0], [0.08, 0.004, 0.11], COLORS.white, MAT.MATTE, 0.006);
  sc.rbox.part(body, [-0.22, 0.355, -0.02], [0.012, 0.002, 0.05], COLORS.dark, MAT.MATTE);
  sc.rbox.part(body, [-0.22, 0.355, 0.02], [0.012, 0.002, 0.05], COLORS.dark, MAT.MATTE);
  sc.rbox.part(body, [0.038, 0.13, 0], [0.012, 0.045, 0.22], rgb("#1d2b4a"), MAT.EMISSIVE, 0.01);
  for (const z of [-0.065, 0.065]) sc.rbox.part(body, [-0.35, 0.1, z], [0.008, 0.035, 0.05], COLORS.brass, MAT.METAL, 0.003);
  return { carriage, top };
}

/** A stable cardboard tone for a package id. */
export function tone(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 3;
}

// a walking stride (two steps) in meters
export const STRIDE_LENGTH = 1.3;

/** Where in its walk cycle a person is, from the distance walked: 0..2π. */
export function walkPhase(walked) {
  const p = ((walked / STRIDE_LENGTH) % 1) * Math.PI * 2;
  return p < 0 ? p + Math.PI * 2 : p;
}

/**
 * A person: legs, arms, torso in a hi-vis vest with two reflective bands,
 * head and hard hat. `look` has the walk phase, how much they are moving
 * (0–1), idle time for the weight shift, head turn, smoothed heading and
 * level of detail.
 */
export function person(sc, w, v, look) {
  const { phase, moving, idle, headTurn, yaw, detail } = look;
  const swing = Math.sin(phase) * 0.42 * moving;
  const bob = Math.abs(Math.sin(phase)) * 0.025 * moving;
  const shift = (1 - moving) * Math.sin(idle * 0.9 + w.id) * 0.018;
  const root = rootOf(v.x, v.y, yaw, bob);
  sc.shadows.add([v.x + look.shadow[0], 0, v.y + look.shadow[1]], [0.62, 1, 0.5], qY(-yaw), [0, 0, 0, 0.65], 0, 0.22);
  if (!detail) {
    sc.cap.part(root, [0, 0.85, 0], [0.4, 1.7, 0.3], COLORS.shirt, MAT.MATTE);
    sc.rbox.part(root, [0, 1.2, 0], [0.26, 0.36, 0.4], COLORS.vest, MAT.MATTE, 0.08);
    return;
  }
  const hips = compose(root, T([0, 0.92, shift]));
  for (const side of [-1, 1]) {
    const a = side * swing;
    const knee = Math.max(0, Math.sin(phase + (side > 0 ? 0 : Math.PI) - 0.6)) * 0.55 * moving;
    const hip = compose(hips, T([0, 0, side * 0.1], qZ(a)));
    sc.cap.part(hip, [0, -0.22, 0], [0.135, 0.48, 0.135], COLORS.trousers, MAT.MATTE);
    const shin = compose(hip, T([0, -0.44, 0], qZ(-knee)));
    sc.cap.part(shin, [0, -0.21, 0], [0.115, 0.46, 0.115], COLORS.trousers, MAT.MATTE);
    sc.rbox.part(shin, [0.04, -0.44, 0], [0.24, 0.07, 0.11], COLORS.rubber, MAT.RUBBER, 0.03);
  }
  const torso = compose(hips, T([0, 0.26, 0]));
  sc.rbox.part(torso, [0, 0.0, 0], [0.22, 0.52, 0.36], COLORS.shirt, MAT.MATTE, 0.08);
  sc.rbox.part(torso, [0, 0.04, 0], [0.245, 0.4, 0.385], COLORS.vest, MAT.MATTE, 0.08);
  for (const y of [-0.06, 0.12]) sc.rbox.part(torso, [0, y, 0], [0.252, 0.034, 0.392], COLORS.reflect, MAT.PAINT, 0.04);
  const carries = w.id % 2 === 0;
  for (const side of [-1, 1]) {
    // arms swing against the legs; the one holding a tablet stays bent
    const holding = carries && side > 0;
    const a = holding ? 0.35 : -side * swing * 0.9;
    const shoulder = compose(torso, T([0, 0.2, side * 0.215], qMul(qX(-side * 0.08), qZ(a))));
    sc.cap.part(shoulder, [0, -0.15, 0], [0.1, 0.32, 0.1], COLORS.shirt, MAT.MATTE);
    const elbow = compose(shoulder, T([0, -0.29, 0], qZ(holding ? 1.45 : 0.25 + Math.max(0, -a) * 0.4)));
    sc.cap.part(elbow, [0, -0.13, 0], [0.085, 0.28, 0.085], COLORS.shirt, MAT.MATTE);
    sc.cap.part(elbow, [0, -0.28, 0], [0.08, 0.08, 0.08], COLORS.skin, MAT.MATTE);
    if (holding) sc.rbox.part(elbow, [0.02, -0.27, -0.1], [0.24, 0.016, 0.18], COLORS.board, MAT.PAINT, 0.01, qZ(-0.5));
  }
  const neck = compose(torso, T([0, 0.33, 0], qY(headTurn)));
  sc.cap.part(neck, [0, 0.02, 0], [0.08, 0.08, 0.08], COLORS.skin, MAT.MATTE);
  sc.cap.part(neck, [0.01, 0.15, 0], [0.18, 0.22, 0.17], COLORS.skin, MAT.MATTE);
  const hat = w.id % 3 === 1 ? COLORS.hatYellow : COLORS.hatWhite;
  sc.cap.part(neck, [0.0, 0.245, 0], [0.215, 0.16, 0.2], hat, MAT.PAINT);
  sc.cyl.part(neck, [0.025, 0.205, 0], [0.27, 0.012, 0.23], hat, MAT.PAINT);
}

export { T, compose, qIdentity, qMul, qRotate, qX, qY, qZ, rootOf };
