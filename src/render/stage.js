// Canvas view of the warehouse from above, drawn like the rest of the
// site: a white floor on the gray tile, pale lanes, ink robots, kraft
// boxes and the planner's routes in blue. Kept apart from src/sim so the
// simulation stays DOM-free.

import { W, H, CELL, LEVELS, cellX, cellY, center, key } from "../sim/warehouse.js";
import { SPEC } from "../sim/robot.js";
import { SCAN_TIME } from "../sim/world.js";

const INK = "#111113";
const TILE = "#f5f5f6";
const LANE = "#f3f3f5";
const PLAN = "37,99,235";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const GREEN = "#16a34a";
const BOX = "#e7cfa4";
const BOX_EDGE = "#c9ab78";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "InterVariable, Inter, -apple-system, system-ui, sans-serif";

export const easeFactor = (rate, dt) => 1 - (1 - rate) ** (dt * 60);

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

  draw(world, focus, { time = 0 } = {}) {
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
    for (const r of world.robots) if (!r.manual) this.drawRoute(r, r === focus);
    if (focus) this.drawLidar(focus);
    for (const w of world.workers) this.drawWorker(w, time);
    for (const r of world.robots) this.drawRobot(r, r === focus, world, time);
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
      // shelf level, as one to three ticks on the aisle side
      const level = bay.pkg ? bay.pkg.level : -1;
      if (level >= 0) {
        ctx.fillStyle = "rgba(17,17,19,.28)";
        const edge = bay.facing > 0 ? y + 0.06 : y + 0.88;
        for (let i = 0; i <= level; i++) ctx.fillRect(x + 0.08 + i * 0.1, edge, 0.06, 0.06);
      }
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

  drawRoute(r, focused) {
    const path = r.path;
    if (!path || r.i >= path.length - 1 || !/^to/.test(r.phase)) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y);
    for (let j = r.i + 1; j < path.length; j++) {
      const c = center(path[j]);
      ctx.lineTo(c.x, c.y);
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

  drawLidar(r) {
    const ctx = this.ctx;
    const n = SPEC.lidarRays;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = r.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      const d = r.lidar[k];
      const x = r.x + Math.cos(a) * d;
      const y = r.y + Math.sin(a) * d;
      if (k === 0) ctx.moveTo(r.x, r.y);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(17,17,19,.035)";
    ctx.fill();
    ctx.fillStyle = "rgba(17,17,19,.4)";
    for (let k = 0; k < n; k++) {
      const d = r.lidar[k];
      if (d >= SPEC.lidarRange - 0.01) continue;
      const a = r.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      ctx.fillRect(r.x + Math.cos(a) * d - 0.025, r.y + Math.sin(a) * d - 0.025, 0.05, 0.05);
    }
    // the safety field: amber while slowing, red while stopped
    if (r.safety !== "clear") {
      ctx.fillStyle = r.safety === "stop" ? "rgba(239,68,68,.16)" : "rgba(245,158,11,.14)";
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.arc(r.x, r.y, r.safety === "stop" ? SPEC.stop : SPEC.slow * 0.7, r.h - 0.5, r.h + 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWorker(w, time) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(w.h);
    // a step cycle: the shoulders sway a little while walking
    const sway = w.moving ? Math.sin(time * 9 + w.id) * 0.03 : 0;
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
      ctx.arc(w.x, w.y, 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawRobot(r, focused, world, time) {
    const ctx = this.ctx;
    const L = SPEC.length;
    const Wd = SPEC.width;
    const fork = SPEC.forkLength;
    const reach = r.fork.reach * 0.32;
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.h);
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
    // number
    ctx.rotate(-r.h);
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.font = `700 ${0.2}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.restore();

    if (r.load) {
      const d = L / 2 + reach + fork * 0.55;
      const lift = Math.max(0, r.fork.height - SPEC.travelHeight) / SPEC.maxFork;
      this.drawBox(r.load, r.x + Math.cos(r.h) * d, r.y + Math.sin(r.h) * d, 0.5, r.h + Math.PI / 2, lift);
    }
    if (/scan/i.test(r.phase) && r.timer < SCAN_TIME && r.load) this.drawLaser(r, time);
    if (world.robots.length > 1 || focused) {
      ctx.save();
      ctx.fillStyle = focused ? INK : "rgba(17,17,19,.55)";
      ctx.font = `700 ${0.26}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(r.id + 1), r.x - Math.cos(r.h) * 0.62, r.y - Math.sin(r.h) * 0.62);
      ctx.restore();
    }
  }

  drawLaser(r, time) {
    const ctx = this.ctx;
    const L = SPEC.length;
    const d = L / 2 + r.fork.reach * 0.32 + SPEC.forkLength * 0.55;
    const cx = r.x + Math.cos(r.h) * d;
    const cy = r.y + Math.sin(r.h) * d;
    const sweep = Math.sin(time * 14) * 0.2;
    const nx = -Math.sin(r.h);
    const ny = Math.cos(r.h);
    const ox = r.x + Math.cos(r.h) * (L / 2 - 0.12);
    const oy = r.y + Math.sin(r.h) * (L / 2 - 0.12);
    const ax = cx + nx * 0.25 + Math.cos(r.h) * sweep;
    const ay = cy + ny * 0.25 + Math.sin(r.h) * sweep;
    const bx = cx - nx * 0.25 + Math.cos(r.h) * sweep;
    const by = cy - ny * 0.25 + Math.sin(r.h) * sweep;
    ctx.fillStyle = "rgba(239,68,68,.12)";
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2 * this.px;
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
