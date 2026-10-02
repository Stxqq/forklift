// The forklift robot drawn from above, in its own frame: +x is forward
// (the fork end), 1 unit is a meter. The same drawing serves the stage
// (around 20 px long) and close-ups; small details drop out when they
// would be under a pixel.

import { BODY, FORK } from "../sim/collide.js";

const INK = "#141416";
const STEEL = "#a1a1aa";

/** Status colors for the LED strip and the beacon. */
export function status(r) {
  if (r.safety === "stop") return "#ef4444";
  if (r.waiting || r.safety === "slow") return "#f59e0b";
  if (r.phase === "charging" || r.charging) return "#22c55e";
  if (r.phase === "idle" || r.phase === "parked") return "#a1a1aa";
  return "#3b82f6";
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws a robot at the origin facing +x. `px` is the size of one screen
 * pixel in meters, `reach` 0–1, `id` for the plate, `color` the status.
 */
export function drawRobot(ctx, { px, reach = 0, color = "#3b82f6", id = 1, beacon = false, time = 0 }) {
  const detail = px < 0.02; // more than about 50 px per meter
  const { x0, x1, half } = BODY;
  const r = reach * FORK.reach;

  // soft shadow on the floor
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.16)";
  rr(ctx, x0 + 0.03, -half + 0.05, x1 - x0, half * 2, 0.08);
  ctx.fill();
  ctx.restore();

  // outriggers: two arms forward of the mast, with casters at the tips
  const mastX = 0.04;
  ctx.fillStyle = "#26262a";
  rr(ctx, mastX - 0.02, -half, x1 - mastX + 0.02, 0.075, 0.025);
  ctx.fill();
  rr(ctx, mastX - 0.02, half - 0.075, x1 - mastX + 0.02, 0.075, 0.025);
  ctx.fill();
  ctx.fillStyle = "#71717a";
  ctx.fillRect(x1 - 0.085, -half + 0.015, 0.055, 0.045);
  ctx.fillRect(x1 - 0.085, half - 0.06, 0.055, 0.045);

  // the fork: carriage with backrest, two tapered tines
  const c = FORK.x0 + r;
  ctx.fillStyle = "#3f3f46";
  ctx.fillRect(c - 0.035, -FORK.half, 0.03, FORK.half * 2);
  if (detail) {
    ctx.fillStyle = "rgba(255,255,255,.18)";
    for (let i = -3; i <= 3; i++) ctx.fillRect(c - 0.032, i * 0.055 - 0.006, 0.024, 0.012);
  }
  for (const side of [-1, 1]) {
    const y = side * 0.11;
    ctx.beginPath();
    ctx.moveTo(c - 0.005, y - 0.036);
    ctx.lineTo(c + 0.29, y - 0.03);
    ctx.lineTo(FORK.x1 + r, y - 0.012);
    ctx.lineTo(FORK.x1 + r, y + 0.012);
    ctx.lineTo(c + 0.29, y + 0.03);
    ctx.lineTo(c - 0.005, y + 0.036);
    ctx.closePath();
    ctx.fillStyle = STEEL;
    ctx.fill();
    if (detail) {
      ctx.fillStyle = "rgba(255,255,255,.45)";
      ctx.fillRect(c, y - 0.028, 0.27, 0.012);
    }
  }

  // chassis behind the mast
  const g = ctx.createLinearGradient(0, -half, 0, half);
  g.addColorStop(0, "#2a2a2f");
  g.addColorStop(0.5, INK);
  g.addColorStop(1, "#0c0c0e");
  ctx.fillStyle = g;
  rr(ctx, x0, -half, mastX - x0 + 0.02, half * 2, 0.075);
  ctx.fill();
  // rear bumper
  ctx.fillStyle = "#3a3a40";
  rr(ctx, x0, -half + 0.03, 0.035, half * 2 - 0.06, 0.015);
  ctx.fill();
  // mast: two rails and the cross head
  ctx.fillStyle = "#52525b";
  ctx.fillRect(mastX - 0.01, -half + 0.02, 0.05, half * 2 - 0.04);
  ctx.fillStyle = "#71717a";
  ctx.fillRect(mastX - 0.005, -0.2, 0.04, 0.05);
  ctx.fillRect(mastX - 0.005, 0.15, 0.04, 0.05);

  // the status strip along both flanks
  ctx.fillStyle = color;
  ctx.fillRect(x0 + 0.07, -half + 0.012, 0.3, 0.014);
  ctx.fillRect(x0 + 0.07, half - 0.026, 0.3, 0.014);

  if (detail) {
    // panel seams
    ctx.strokeStyle = "rgba(255,255,255,.09)";
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.moveTo(-0.12, -half + 0.04);
    ctx.lineTo(-0.12, half - 0.04);
    ctx.moveTo(x0 + 0.05, -half + 0.05);
    ctx.lineTo(mastX - 0.03, -half + 0.05);
    ctx.moveTo(x0 + 0.05, half - 0.05);
    ctx.lineTo(mastX - 0.03, half - 0.05);
    ctx.stroke();
    // drive wheels show through the flank cut-outs
    ctx.fillStyle = "#050506";
    ctx.fillRect(-0.14, -half + 0.0, 0.13, 0.018);
    ctx.fillRect(-0.14, half - 0.018, 0.13, 0.018);
    // charging contacts on the rear face
    ctx.fillStyle = "#c8ad73";
    ctx.fillRect(x0 - 0.004, -0.09, 0.012, 0.05);
    ctx.fillRect(x0 - 0.004, 0.04, 0.012, 0.05);
    // ID plate
    ctx.fillStyle = "rgba(255,255,255,.9)";
    rr(ctx, -0.27, -0.045, 0.1, 0.09, 0.012);
    ctx.fill();
    ctx.save();
    ctx.translate(-0.22, 0);
    ctx.rotate(Math.PI / 2);
    // text in pixel units: canvas ignores fonts smaller than a pixel
    ctx.scale(px, px);
    ctx.fillStyle = INK;
    ctx.font = `700 ${(0.058 / px).toFixed(2)}px InterVariable, Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`R${id}`, 0, 0);
    ctx.restore();
    // emergency stop: red mushroom on a yellow collar
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(-0.27, 0.165, 0.032, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(-0.27, 0.165, 0.022, 0, Math.PI * 2);
    ctx.fill();
  }

  // safety scanner window, just behind the mast, looking forward
  ctx.fillStyle = "#0b1220";
  rr(ctx, mastX - 0.06, -0.09, 0.04, 0.18, 0.015);
  ctx.fill();
  if (detail) {
    ctx.fillStyle = "rgba(96,165,250,.55)";
    ctx.fillRect(mastX - 0.052, -0.07, 0.008, 0.14);
  }
  // lidar puck
  ctx.fillStyle = "#2b2b31";
  ctx.beginPath();
  ctx.arc(-0.09, 0, 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3f3f46";
  ctx.beginPath();
  ctx.arc(-0.09, 0, 0.045, 0, Math.PI * 2);
  ctx.fill();
  if (detail) {
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.beginPath();
    ctx.arc(-0.105, -0.015, 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
  // beacon: amber dome, pulsing while the robot moves or waits
  const on = beacon ? 0.55 + 0.45 * Math.sin(time * 9) : 0;
  ctx.fillStyle = beacon ? `rgba(245,158,11,${0.6 + 0.4 * on})` : "#7c5a12";
  ctx.beginPath();
  ctx.arc(-0.27, -0.165, 0.03, 0, Math.PI * 2);
  ctx.fill();
  if (beacon && detail) {
    ctx.fillStyle = `rgba(245,158,11,${0.18 * on})`;
    ctx.beginPath();
    ctx.arc(-0.27, -0.165, 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
}

