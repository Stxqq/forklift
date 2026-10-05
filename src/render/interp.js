// Both views draw from the same moment: between a thing's last two sim
// steps, by the share of a step the clock has run past the last one.

import { wrap } from "../sim/robot.js";

export function between(o, a) {
  const p = o.prev;
  if (!p) return o;
  return {
    x: p.x + (o.x - p.x) * a,
    y: p.y + (o.y - p.y) * a,
    h: p.h + wrap(o.h - p.h) * a,
    fh: p.fh === undefined ? 0 : p.fh + (o.fork.height - p.fh) * a,
    fr: p.fr === undefined ? 0 : p.fr + (o.fork.reach - p.fr) * a,
    walked: p.walked === undefined ? 0 : p.walked + (o.walked - p.walked) * a,
  };
}
