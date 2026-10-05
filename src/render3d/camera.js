// The chase camera: behind and above the robot, looking a little ahead of
// it. It eases toward where it should be with a rate that doesn't depend
// on the frame rate, and turns the short way round, so it follows a robot
// through a corner arc without snapping and never spins at ±180°.

import { wrapAngle } from "./math.js";

export const CHASE = { back: 4.2, height: 4.0, ahead: 2.6, lookHeight: 0, rate: 4.5, turnRate: 2.4 };

/** Share of the remaining way to cover in dt seconds, for a given rate. */
export const follow = (rate, dt) => 1 - Math.exp(-rate * dt);

export class ChaseCamera {
  constructor() {
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.ready = false;
  }

  /**
   * Move toward the pose (x, z, heading) of the robot. The camera follows
   * the way the robot travels, not the way it faces: while it stands and
   * turns to a bay, the camera holds its bearing instead of swinging into
   * the racks. With `fixedYaw` set (reduced motion) it keeps one bearing
   * and only slides along.
   */
  update(pose, dt, { fixedYaw = null, moving = true } = {}) {
    const yaw = fixedYaw ?? (moving || !this.ready ? pose.h : this.yaw);
    if (!this.ready) {
      this.x = pose.x;
      this.z = pose.y;
      this.yaw = yaw;
      this.ready = true;
    } else {
      const k = follow(CHASE.rate, dt);
      this.x += (pose.x - this.x) * k;
      this.z += (pose.y - this.z) * k;
      this.yaw += wrapAngle(yaw - this.yaw) * follow(CHASE.turnRate, dt);
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
