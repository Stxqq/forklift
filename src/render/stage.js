// Canvas view of the warehouse from above, drawn like the rest of the
// site: a white floor on the gray tile, pale lanes, ink robots, kraft
// boxes and the planner's routes in blue. Kept apart from src/sim so the
// simulation stays DOM-free.

import { W, H, CELL, LEVELS, cellX, cellY, center, key } from "../sim/warehouse.js";
import { SPEC, wrap } from "../sim/robot.js";
import { SCAN_TIME } from "../sim/world.js";

const INK = "#111113";
const TILE = "#f5f5f6";
const LANE = "#f3f3f5";
const PLAN = "37,99,235";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const GREEN = "#16a34a";
const BOX = "#eadbc0";
const BOX_EDGE = "#cdb48a";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "InterVariable, Inter, -apple-system, system-ui, sans-serif";

export const easeFactor = (rate, dt) => 1 - (1 - rate) ** (dt * 60);

// the portfolio's --ease, cubic-bezier(.32, .72, 0, 1), for canvas motion
export function portfolioEase(t) {
  const x1 = 0.32, y1 = 0.72, x2 = 0, y2 = 1;
  const bx = (u) => 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u;
  const by = (u) => 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Where something is drawn: between its last two sim steps. */
function between(o, a) {
  const p = o.prev;
  if (!p) return o;
  return {
    x: p.x + (o.x - p.x) * a,
    y: p.y + (o.y - p.y) * a,
    h: p.h + wrap(o.h - p.h) * a,
    fh: p.fh === undefined ? 0 : p.fh + (o.fork.height - p.fh) * a,
    fr: p.fr === undefined ? 0 : p.fr + (o.fork.reach - p.fr) * a,
  };
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.scale = 30;
    this.ox = 0;
    this.oy = 0;
    this.hover = -1;
    this.qr = new Map();
    this.reducedMotion = false;
  }

  resize(insets = this.insets) {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    this.insets = insets;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    const { left, right, top, bottom } = insets;
    const pad = 14;
    const aw = width - left - right - pad * 2;
    const ah = height - top - bottom - pad * 2;
    // the outer wall row is drawn half as thick, so fit W-1 by H-1 cells
    this.scale = Math.max(4, Math.min(aw / (W - 1), ah / (H - 1)));
    this.ox = left + pad + (aw - (W - 1) * this.scale) / 2 - this.scale / 2;
    this.oy = top + pad + (ah - (H - 1) * this.scale) / 2 - this.scale / 2;
  }

  toScreen(x, y) {
    return { x: this.ox + x * this.scale, y: this.oy + y * this.scale };
  }

  cellAt(px, py) {
    const x = Math.floor((px - this.ox) / this.scale);
    const y = Math.floor((py - this.oy) / this.scale);
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    return key(x, y);
  }

  draw(world, focus, { time = 0, alpha = 1 } = {}) {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = TILE;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    this.px = 1 / this.scale;

    const ws = world.warehouse;
    this.drawFloor(ws);
    this.drawRacks(world);
    this.drawDocks(world);
    this.drawPockets(world);
    for (const r of world.robots) this.drawHeld(r, r === focus);
    const views = new Map(world.robots.map((r) => [r, between(r, alpha)]));
    for (const r of world.robots) if (!r.manual) this.drawRoute(r, views.get(r), r === focus);
    if (focus) this.drawLidar(focus, views.get(focus));
    for (const w of world.workers) this.drawWorker(w, between(w, alpha), time);
    for (const r of world.robots) this.drawRobot(r, views.get(r), r === focus, world, time);
    this.drawLabels(ws);
  }

  drawFloor(ws) {
    const ctx = this.ctx;
    const px = this.px;
    // the building: a white floor with a soft edge
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.06)";
    ctx.shadowBlur = 18 * px * this.scale;
    ctx.shadowOffsetY = 0;
    roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 0.5);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();

    for (let k = 0; k < ws.grid.length; k++) {
      const t = ws.grid[k];
      const x = cellX(k);
      const y = cellY(k);
      if (t === CELL.LANE) {
        ctx.fillStyle = LANE;
        ctx.fillRect(x, y, 1, 1);
      } else if (t === CELL.WALK) {
        ctx.fillStyle = "#fffaf0";
        ctx.fillRect(x, y, 1, 1);
      } else if (t === CELL.STAGING && x > 0 && y > 0 && x < W - 1 && y < H - 1) {
        ctx.fillStyle = "#fafafb";
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // pedestrian strip edges, dashed amber like floor tape
    ctx.strokeStyle = "rgba(245,158,11,.55)";
    ctx.lineWidth = 1.2 * px;
    ctx.setLineDash([0.18, 0.14]);
    for (const [x0, x1] of [[3, 5], [22, 23]]) {
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.moveTo(x, 2);
        ctx.lineTo(x, 13);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    // crosswalks: zebra stripes across the aisle
    ctx.fillStyle = "rgba(17,17,19,.07)";
    for (const k of ws.crosswalks) {
      const x = cellX(k);
      const y = cellY(k);
      for (let i = 0; i < 4; i++) ctx.fillRect(x + 0.1 + i * 0.22, y + 0.14, 0.12, 0.72);
    }
    // one-way arrows every few cells
    ctx.fillStyle = "rgba(17,17,19,.13)";
    for (let k = 0; k < ws.grid.length; k++) {
      if (ws.grid[k] !== CELL.LANE || ws.crosswalks.has(k) || ws.exits[k].length !== 1) continue;
      const x = cellX(k);
      const y = cellY(k);
      if ((x + y) % 3 !== 0) continue;
      const n = ws.exits[k][0];
      const a = Math.atan2(cellY(n) - y, cellX(n) - x);
      ctx.save();
      ctx.translate(x + 0.5, y + 0.5);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0.16, 0);
      ctx.lineTo(-0.1, -0.15);
      ctx.lineTo(-0.04, 0);
      ctx.lineTo(-0.1, 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // inbound pallets on the west staging cells
    for (const y of [7, 8, 9]) {
      ctx.fillStyle = "#efefef";
      ctx.fillRect(1.12, y + 0.12, 0.76, 0.76);
      ctx.fillStyle = BOX;
      ctx.fillRect(1.2, y + 0.2, 0.3, 0.28);
      ctx.fillRect(1.52, y + 0.5, 0.28, 0.3);
    }
  }

  qrImage(pkg) {
    let c = this.qr.get(pkg.id);
    if (c && c.damage === pkg.damage) return c.canvas;
    const n = pkg.code.size;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n;
    const g = canvas.getContext("2d");
    const img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = pkg.code.modules[y][x] ? 40 : 250;
        const i = (y * n + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (pkg.damage) {
      g.fillStyle = pkg.damage === 2 ? "#e9dcc4" : "rgba(120,90,50,.8)";
      for (const m of pkg.marks) {
        if (m.w) g.fillRect(m.x - m.w / 2, m.y - m.h / 2, m.w, m.h);
        else {
          g.beginPath();
          g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    this.qr.set(pkg.id, { canvas, damage: pkg.damage });
    if (this.qr.size > 400) this.qr.delete(this.qr.keys().next().value);
    return canvas;
  }

  drawBox(pkg, cx, cy, size, angle = 0, lift = 0) {
    const ctx = this.ctx;
    const s = size * (1 + lift * 0.1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    if (lift > 0.05) {
      ctx.fillStyle = "rgba(0,0,0,.12)";
      ctx.fillRect(-s / 2 + lift * 0.06, -s / 2 + lift * 0.09, s, s);
    }
    ctx.fillStyle = BOX;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeStyle = BOX_EDGE;
    ctx.lineWidth = this.px;
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    // tape seam
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(-s * 0.06, -s / 2, s * 0.12, s);
    const q = s * 0.56;
    ctx.fillStyle = "#fff";
    ctx.fillRect(-q / 2 - s * 0.03, -q / 2 - s * 0.03, q + s * 0.06, q + s * 0.06);
    ctx.imageSmoothingEnabled = this.scale * q < pkg.code.size * 1.2;
    ctx.drawImage(this.qrImage(pkg), -q / 2, -q / 2, q, q);
    ctx.restore();
  }

  drawRacks(world) {
    const ctx = this.ctx;
    const ws = world.warehouse;
    const px = this.px;
    // rack frames, drawn per row of bays
    ctx.fillStyle = "#ececef";
    for (const bay of ws.bays) {
      const x = cellX(bay.cell);
      const y = cellY(bay.cell);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5 * px;
    for (const bay of ws.bays) {
      const x = cellX(bay.cell);
      const y = cellY(bay.cell);
      ctx.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
    }
    for (const bay of ws.bays) {
      const x = cellX(bay.cell);
      const y = cellY(bay.cell);
      if (bay.pkg) this.drawBox(bay.pkg, x + 0.5, y + 0.5, 0.62);
      if (bay.expected && !bay.pkg && !bay.reserved) {
        // the records say something is here
        ctx.setLineDash([0.08, 0.08]);
        ctx.strokeStyle = "rgba(17,17,19,.25)";
        ctx.lineWidth = px;
        ctx.strokeRect(x + 0.2, y + 0.2, 0.6, 0.6);
        ctx.setLineDash([]);
      }
      if (bay.flagged) this.outline(x, y, AMBER, 2);
      else if (bay.reserved) this.outline(x, y, `rgb(${PLAN})`, 2);
      if (bay.cell === this.hover) this.outline(x, y, INK, 1.5);
    }
  }

  outline(x, y, color, width) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * this.px;
    roundRect(ctx, x + 0.05, y + 0.05, 0.9, 0.9, 0.12);
    ctx.stroke();
  }

  drawDocks(world) {
    const ctx = this.ctx;
    for (const dock of world.warehouse.docks) {
      const x = cellX(dock.cell);
      const y = cellY(dock.cell);
      ctx.fillStyle = "#e4e4e7";
      ctx.fillRect(x + 0.1, y - 0.3, 0.8, 1.6);
      ctx.fillStyle = INK;
      ctx.fillRect(x + 0.72, y - 0.3, 0.18, 1.6);
      // rollers
      ctx.fillStyle = "rgba(17,17,19,.12)";
      for (let i = 0; i < 6; i++) ctx.fillRect(x + 0.14, y - 0.24 + i * 0.26, 0.54, 0.05);
    }
  }

  drawPockets(world) {
    const ctx = this.ctx;
    const ws = world.warehouse;
    for (const spot of [...ws.parking, ...ws.chargers]) {
      const x = cellX(spot.cell);
      const y = cellY(spot.cell);
      ctx.strokeStyle = "rgba(17,17,19,.18)";
      ctx.lineWidth = this.px;
      ctx.setLineDash([0.08, 0.07]);
      ctx.strokeRect(x + 0.12, y + 0.08, 0.76, 0.84);
      ctx.setLineDash([]);
    }
    for (const c of ws.chargers) {
      const x = cellX(c.cell) + 0.5;
      const y = cellY(c.cell) + 0.5;
      const busy = world.robots.some((r) => (r.phase === "charging" || r.charging) && Math.hypot(r.x - x, r.y - y) < 0.5);
      ctx.fillStyle = busy ? GREEN : "rgba(17,17,19,.28)";
      ctx.beginPath();
      ctx.moveTo(x - 0.24 + 0.06, y - 0.2);
      ctx.lineTo(x - 0.24 - 0.06, y + 0.02);
      ctx.lineTo(x - 0.24 + 0.01, y + 0.02);
      ctx.lineTo(x - 0.24 - 0.04, y + 0.22);
      ctx.lineTo(x - 0.24 + 0.1, y - 0.04);
      ctx.lineTo(x - 0.24 + 0.02, y - 0.04);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawHeld(r, focused) {
    if (r.manual) return;
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(${PLAN},${focused ? 0.09 : 0.06})`;
    for (const c of r.held) ctx.fillRect(cellX(c) + 0.06, cellY(c) + 0.06, 0.88, 0.88);
  }

  drawRoute(r, v, focused) {
    const path = r.path;
    if (!path || r.i >= path.length - 1 || !/^to/.test(r.phase)) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(v.x, v.y);
    // round the corners the way the robot drives them
    for (let j = r.i + 1; j < path.length; j++) {
      const c = center(path[j]);
      if (j < path.length - 1) {
        const n = center(path[j + 1]);
        ctx.arcTo(c.x, c.y, n.x, n.y, 0.5);
      } else {
        ctx.lineTo(c.x, c.y);
      }
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(${PLAN},${focused ? 0.55 : 0.3})`;
    ctx.lineWidth = focused ? 0.1 : 0.07;
    ctx.stroke();
    const end = center(path[path.length - 1]);
    ctx.fillStyle = `rgba(${PLAN},${focused ? 0.9 : 0.5})`;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 0.09, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLidar(r, v) {
    const ctx = this.ctx;
    const n = SPEC.lidarRays;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      const d = r.lidar[k];
      const x = v.x + Math.cos(a) * d;
      const y = v.y + Math.sin(a) * d;
      if (k === 0) ctx.moveTo(v.x, v.y);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(37,99,235,.035)";
    ctx.fill();
    ctx.fillStyle = "rgba(17,17,19,.4)";
    for (let k = 0; k < n; k++) {
      const d = r.lidar[k];
      if (d >= SPEC.lidarRange - 0.01) continue;
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      ctx.fillRect(v.x + Math.cos(a) * d - 0.025, v.y + Math.sin(a) * d - 0.025, 0.05, 0.05);
    }
    // the safety field: amber while slowing, red while stopped
    if (r.safety !== "clear") {
      ctx.fillStyle = r.safety === "stop" ? "rgba(239,68,68,.16)" : "rgba(245,158,11,.14)";
      ctx.beginPath();
      ctx.moveTo(v.x, v.y);
      ctx.arc(v.x, v.y, r.safety === "stop" ? SPEC.stop : SPEC.slow * 0.7, v.h - 0.5, v.h + 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWorker(w, v, time) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.h);
    // a step cycle: the shoulders sway a little while walking
    const sway = w.moving && !this.reducedMotion ? Math.sin(time * 9 + w.id) * 0.025 : 0;
    ctx.fillStyle = "rgba(0,0,0,.08)";
    ctx.beginPath();
    ctx.ellipse(0.03, 0.04, 0.2, 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.ellipse(sway, 0, 0.15, 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.fillRect(-0.13 + sway, -0.03, 0.26, 0.04);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (w.waiting) {
      ctx.strokeStyle = "rgba(245,158,11,.6)";
      ctx.lineWidth = 1.2 * this.px;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawRobot(r, v, focused, world, time) {
    const ctx = this.ctx;
    const L = SPEC.length;
    const Wd = SPEC.width;
    const fork = SPEC.forkLength;
    const reach = v.fr * 0.32;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.h);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,.14)";
    roundRect(ctx, -L / 2 + 0.03, -Wd / 2 + 0.05, L, Wd, 0.12);
    ctx.fill();
    // forks
    ctx.fillStyle = "#a1a1aa";
    const fx = L / 2 - 0.04 + reach;
    ctx.fillRect(L / 2 - 0.06, -Wd * 0.32, reach + 0.04, 0.05);
    ctx.fillRect(L / 2 - 0.06, Wd * 0.27, reach + 0.04, 0.05);
    ctx.fillRect(fx, -Wd * 0.34, fork, 0.08);
    ctx.fillRect(fx, Wd * 0.26, fork, 0.08);
    // body
    ctx.fillStyle = INK;
    roundRect(ctx, -L / 2, -Wd / 2, L, Wd, 0.12);
    ctx.fill();
    // mast
    ctx.fillStyle = "#3f3f46";
    ctx.fillRect(L / 2 - 0.1, -Wd / 2 + 0.03, 0.08, Wd - 0.06);
    // lidar puck
    ctx.fillStyle = "#27272a";
    ctx.beginPath();
    ctx.arc(-0.05, 0, 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.beginPath();
    ctx.arc(-0.05, 0, 0.05, 0, Math.PI * 2);
    ctx.fill();
    // status lamp
    ctx.fillStyle = statusColor(r);
    ctx.beginPath();
    ctx.arc(-L / 2 + 0.1, -Wd / 2 + 0.1, 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (r.load) {
      const d = L / 2 + reach + fork * 0.55;
      const lift = Math.max(0, v.fh - SPEC.travelHeight) / SPEC.maxFork;
      this.drawBox(r.load, v.x + Math.cos(v.h) * d, v.y + Math.sin(v.h) * d, 0.42, v.h + Math.PI / 2, lift);
    }
    if (/scan/i.test(r.phase) && r.timer < SCAN_TIME && r.load) this.drawLaser(r, v);
    if (world.robots.length > 1 || focused) {
      ctx.save();
      ctx.fillStyle = focused ? INK : "rgba(17,17,19,.55)";
      ctx.font = `700 ${0.26}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(r.id + 1), v.x - Math.cos(v.h) * 0.6, v.y - Math.sin(v.h) * 0.6);
      ctx.restore();
    }
  }

  drawLaser(r, v) {
    const ctx = this.ctx;
    const L = SPEC.length;
    const d = L / 2 + v.fr * 0.32 + SPEC.forkLength * 0.55;
    const c = Math.cos(v.h);
    const sn = Math.sin(v.h);
    const cx = v.x + c * d;
    const cy = v.y + sn * d;
    // one sweep across the label per scan, on the portfolio's easing curve
    const t = Math.min(1, r.timer / SCAN_TIME);
    const phase = this.reducedMotion ? 0.5 : t < 0.5 ? portfolioEase(t * 2) : 1 - portfolioEase((t - 0.5) * 2);
    const sweep = (phase - 0.5) * 0.36;
    const nx = -sn;
    const ny = c;
    const ox = v.x + c * (L / 2 - 0.12);
    const oy = v.y + sn * (L / 2 - 0.12);
    const ax = cx + nx * 0.22 + c * sweep;
    const ay = cy + ny * 0.22 + sn * sweep;
    const bx = cx - nx * 0.22 + c * sweep;
    const by = cy - ny * 0.22 + sn * sweep;
    ctx.fillStyle = "rgba(239,68,68,.1)";
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2 * this.px;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  drawLabels(ws) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const fs = Math.max(8, Math.min(10.5, this.scale * 0.34));
    ctx.font = `600 ${fs}px ${MONO}`;
    ctx.fillStyle = "rgba(17,17,19,.42)";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    // rack rows A–H, written on the walk strip end
    "ABCDEFGH".split("").forEach((letter, i) => {
      const y = [2, 3, 5, 6, 8, 9, 11, 12][i];
      const p = this.toScreen(13.5, y + 0.5);
      ctx.fillText(letter, p.x, p.y);
    });
    for (const dock of ws.docks) {
      const p = this.toScreen(cellX(dock.cell) + 0.5, cellY(dock.cell) - 0.55);
      ctx.fillText(`D${dock.id}`, p.x, p.y);
    }
    for (const c of ws.chargers) {
      const p = this.toScreen(cellX(c.cell) + 0.66, cellY(c.cell) + 0.5);
      ctx.fillText(c.id, p.x, p.y);
    }
    for (const s of ws.parking) {
      const p = this.toScreen(cellX(s.cell) + 0.5, cellY(s.cell) + 0.5);
      ctx.fillText(s.id, p.x, p.y);
    }
    const inbound = this.toScreen(1.5, 10.5);
    ctx.font = `700 ${fs * 0.82}px ${SANS}`;
    ctx.fillText("IN", inbound.x, inbound.y);
    ctx.restore();
  }
}

function statusColor(r) {
  if (r.safety === "stop") return RED;
  if (r.waiting || r.safety === "slow") return AMBER;
  if (r.phase === "charging" || r.charging) return GREEN;
  if (r.phase === "idle" || r.phase === "parked") return "#a1a1aa";
  return "#60a5fa";
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { LEVELS };
