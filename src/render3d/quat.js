// Rotations as quaternions [x, y, z, w], and rigid transforms built from
// them, so a model can be a hierarchy of parts: a wheel turns on its
// axle, the axle rides on the chassis, the chassis on the robot's pose.

export const qIdentity = () => [0, 0, 0, 1];

export function qAxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

export const qY = (a) => qAxis(0, 1, 0, a);
export const qX = (a) => qAxis(1, 0, 0, a);
export const qZ = (a) => qAxis(0, 0, 1, a);

export function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** A rigid transform: position p and rotation q. */
export const T = (p = [0, 0, 0], q = qIdentity()) => ({ p, q });

/** Child transform `local` placed under `parent`. */
export function compose(parent, local) {
  const r = qRotate(parent.q, local.p);
  return { p: [parent.p[0] + r[0], parent.p[1] + r[1], parent.p[2] + r[2]], q: qMul(parent.q, local.q) };
}

/**
 * A robot's or person's root in the world: sim position (x, y) on the
 * floor, facing heading h (y down in the sim, so local +x points along
 * (cos h, 0, sin h) and local +z to its right).
 */
export const rootOf = (x, y, h, lift = 0) => T([x, lift, y], qY(-h));
