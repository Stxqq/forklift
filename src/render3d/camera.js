// The chase camera: behind and above the robot, looking ahead along its
// route, so the robot sits big in the lower middle and the route runs up
// the screen. Position and bearing follow critically damped springs,
// solved exactly for each frame's dt so the motion is the same at any
// frame rate, settles without overshoot and never rolls. It turns the
// short way round, holds its bearing while the robot turns on the spot to
// a bay, and leads a little in the direction of travel.

import { wrapAngle } from "./math.js";

export const CHASE = { back: 2.9, height: 2.45, ahead: 3.2, lookHeight: 0.2, lead: 0.7, stiffness: 5.2, turnStiffness: 3.4 };

/** Share of the remaining way an exponential ease covers in dt seconds. */
export const follow = (rate, dt) => 1 - Math.exp(-rate * dt);

/**
 * One step of a critically damped spring from (x, v) toward a target held
 * still for dt seconds; exact, so splitting dt changes nothing.
 */
export function spring(x, v, target, omega, dt) {
  const c0 = x - target;
  const c1 = v + omega * c0;
  const e = Math.exp(-omega * dt);
  return [target + (c0 + c1 * dt) * e, (c1 - omega * (c0 + c1 * dt)) * e];
}

export class ChaseCamera {
  constructor() {
    this.x = 0;
    this.z = 0;
    this.vx = 0;
    this.vz = 0;
    this.yaw = 0;
    this.vyaw = 0;
    this.ready = false;
  }

  /**
   * Move toward the robot's pose (x, y, h). `moving` says whether it is
   * driving (otherwise the bearing holds); `speed` from 0 to 1 sets how far
   * the camera leads; `yaw` overrides the bearing (reduced motion, orbit).
   */
  update(pose, dt, { moving = true, speed = 0, yaw = null } = {}) {
    const want = yaw ?? (moving || !this.ready ? pose.h : this.yaw);
    const lead = CHASE.lead * speed;
    const tx = pose.x + Math.cos(pose.h) * lead;
    const tz = pose.y + Math.sin(pose.h) * lead;
    if (!this.ready) {
      Object.assign(this, { x: tx, z: tz, yaw: want, vx: 0, vz: 0, vyaw: 0, ready: true });
    } else {
      [this.x, this.vx] = spring(this.x, this.vx, tx, CHASE.stiffness, dt);
      [this.z, this.vz] = spring(this.z, this.vz, tz, CHASE.stiffness, dt);
      // the yaw spring runs the short way round
      const target = this.yaw + wrapAngle(want - this.yaw);
      [this.yaw, this.vyaw] = spring(this.yaw, this.vyaw, target, CHASE.turnStiffness, dt);
      this.yaw = wrapAngle(this.yaw);
    }
    return this.eye();
  }

  /** Eye and target positions in world space. */
  eye() {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return {
      eye: [this.x - c * CHASE.back, CHASE.height, this.z - s * CHASE.back],
      target: [this.x + c * CHASE.ahead, CHASE.lookHeight, this.z + s * CHASE.ahead],
    };
  }
}
