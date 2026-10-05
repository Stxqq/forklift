// What the 3D view adds on top of the sim, frame by frame: how far each
// wheel has rolled, where the casters point, the nose dip when braking,
// the lidar and beacon spin, the LED color, a person's smoothed heading
// and walk cycle, how far the dock doors are up. Kept apart from the sim
// on purpose: none of it is read back.

import { wrapAngle } from "./math.js";
import { spring } from "./camera.js";
import { walkPhase, wheelDistances } from "./models.js";
import { cellX, cellY } from "../sim/warehouse.js";

const LED = {
  drive: [0.23, 0.51, 0.96, 1],
  wait: [0.96, 0.62, 0.04, 1],
  ok: [0.13, 0.77, 0.37, 1],
  stop: [0.94, 0.27, 0.27, 1],
  idle: [0.45, 0.46, 0.5, 1],
};

/** The light strip: blue while driving, amber waiting, green on a good read or charging, red stopped. */
export function ledColor(r, time) {
  if (r.safety === "stop") return LED.stop;
  if (r.scan && r.scan.verdict === "ok" && time - r.scan.t < 1.4) return LED.ok;
  if (r.phase === "charging" || r.charging) return LED.ok;
  if (r.waiting || r.safety === "slow") return LED.wait;
  if (r.phase === "idle" || r.phase === "parked") return LED.idle;
  return LED.drive;
}

export class Looks {
  constructor() {
    this.robots = new Map();
    this.people = new Map();
    this.docks = [];
  }

  /**
   * Advance by dt real seconds. `views` are the interpolated poses, `eye`
   * the camera (for detail), `shadow` the shadow offset from the key light.
   */
  update(world, views, { dt, time, eye, reduced, shadow }) {
    const looks = new Map();
    for (const r of world.robots) {
      const v = views.get(r);
      let s = this.robots.get(r);
      if (!s) {
        s = { h: v.h, turned: 0, caster: 0, casterV: 0, dip: 0, dipV: 0, lastV: r.v, lidar: 0, beacon: 0 };
        this.robots.set(r, s);
      }
      s.turned += wrapAngle(v.h - s.h);
      s.h = v.h;
      // casters swing round to trail the way their end of the robot is
      // moving, on a spring, so even a full flip starts and ends gently
      const vx = r.v;
      const vy = r.w * 0.31;
      const casterTo = Math.hypot(vx, vy) > 0.03 ? s.caster + wrapAngle(Math.atan2(vy, vx) - s.caster) : s.caster;
      [s.caster, s.casterV] = spring(s.caster, s.casterV, casterTo, 7, dt);
      // nose dip: a little forward pitch while braking, sprung back
      const accel = dt > 0 ? (r.v - s.lastV) / dt : 0;
      s.lastV = r.v;
      const want = reduced ? 0 : Math.max(-0.02, Math.min(0.02, -accel * 0.012));
      [s.dip, s.dipV] = spring(s.dip, s.dipV, want, 9, dt);
      const moving = Math.abs(r.v) > 0.05 || Math.abs(r.w) > 0.05;
      if (!reduced) {
        s.lidar += dt * 2.2;
        s.beacon += dt * 7;
      }
      const flash = reduced || Math.sin(time * 9) > -0.3;
      looks.set(r, {
        detail: !eye || Math.hypot(v.x - eye[0], v.y - eye[2]) < 14,
        led: ledColor(r, world.time),
        wheels: wheelDistances(r.meters, s.turned),
        meters: r.meters,
        caster: s.caster,
        dip: s.dip,
        lidar: s.lidar,
        beaconSpin: s.beacon,
        beacon: (moving || !!r.waiting) && flash,
        shadow,
        qr: true,
      });
    }
    for (const w of world.workers) {
      const v = views.get(w);
      let s = this.people.get(w);
      if (!s) {
        s = { yaw: v.h, moving: 0, idle: 0 };
        this.people.set(w, s);
      }
      // a person turns toward where they're walking over a quarter second
      s.yaw = wrapAngle(s.yaw + wrapAngle(v.h - s.yaw) * (1 - Math.exp(-10 * dt)));
      s.moving += ((w.moving ? 1 : 0) - s.moving) * (1 - Math.exp(-8 * dt));
      s.idle = w.moving ? 0 : s.idle + dt;
      looks.set(w, {
        phase: walkPhase(v.walked ?? w.walked),
        moving: s.moving,
        idle: time,
        headTurn: w.waiting && !reduced ? Math.sin(time * 0.8 + w.id) * 0.6 : 0,
        yaw: s.yaw,
        detail: !eye || Math.hypot(v.x - eye[0], v.y - eye[2]) < 16,
        shadow,
      });
    }
    // dock doors go up while a robot is at or coming up to the dock
    world.warehouse.docks.forEach((dock, i) => {
      const fx = cellX(dock.from) + 0.5;
      const fy = cellY(dock.from) + 0.5;
      const near = world.robots.some((r) => Math.hypot(r.x - fx, r.y - fy) < 2.2 && r.load);
      const open = this.docks[i] ?? 0;
      this.docks[i] = open + ((near ? 1 : 0) - open) * (1 - Math.exp(-2.5 * dt));
    });
    return looks;
  }
}
