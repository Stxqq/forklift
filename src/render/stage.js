// Canvas view of the warehouse from above, drawn like a floor plan: a pale
// concrete floor inside the walls, two-lane roads with taped edges, steel
// racks with uprights, beams and pallets, dock doors, chargers, people in
// hi-vis vests, and the robots with their routes in blue. Everything that
// never moves is drawn once into a cached layer. Kept apart from src/sim
// so the simulation stays DOM-free.

import { BOX_OFFSET, CELL, H, H_ROADS, RACK_ROWS, V_ROADS, W, WALK_COLS, cellX, cellY, center, key } from "../sim/warehouse.js";
import { SPEC } from "../sim/robot.js";
import { FORK, LOAD } from "../sim/collide.js";
import { SCAN_TIME } from "../sim/world.js";
import { drawRobot, status } from "./robot.js";
import { between } from "./interp.js";

const INK = "#111113";
const TILE = "#f5f5f6";
const FLOOR = "#fbfbfb";
const LANE = "#f0f0f2";
const PLAN = "37,99,235";
const AMBER = "#f59e0b";
const GREEN = "#16a34a";
const BOX = "#e9d8b9";
const BOX_EDGE = "#c8ad7f";
const PALLET = "#ddd1ba";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "InterVariable, Inter, -apple-system, system-ui, sans-serif";

export const easeFactor = (rate, dt) => 1 - (1 - rate) ** (dt * 60);

// the portfolio's --ease, cubic-bezier(.32, .72, 0, 1), for canvas motion
export function portfolioEase(t) {
  const x1 = 0.32;
  const y1 = 0.72;
  const x2 = 0;
  const y2 = 1;
  const bx = (u) => 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u;
  const by = (u) => 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
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
    this.base = null;
    this.planView = null;
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
    const pad = 12;
    const aw = width - left - right - pad * 2;
    const ah = height - top - bottom - pad * 2;
    // the outer wall row is drawn half as thick, so fit W-1 by H-1 cells
    this.scale = Math.max(4, Math.min(aw / (W - 1), ah / (H - 1)));
    this.ox = left + pad + (aw - (W - 1) * this.scale) / 2 - this.scale / 2;
    this.oy = top + pad + (ah - (H - 1) * this.scale) / 2 - this.scale / 2;
    this.base = null;
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

  /** World units onto the canvas, for drawing in meters. */
  worldTransform(ctx) {
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);
  }

  draw(world, focus, { time = 0, alpha = 1, now = 0 } = {}) {
    const { ctx, dpr } = this;
    this.px = 1 / this.scale;
    if (!this.base) this.base = this.drawBase(world.warehouse);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    this.worldTransform(ctx);

    this.drawStock(world);
    this.drawChargers(world);
    if (this.planView) this.drawPlanView(world, now);
    for (const r of world.robots) this.drawHeld(r, r === focus);
    const views = new Map(world.robots.map((r) => [r, between(r, alpha)]));
    for (const r of world.robots) if (!r.manual) this.drawRoute(r, views.get(r), r === focus);
    if (focus) this.drawLidar(focus, views.get(focus));
    for (const w of world.workers) this.drawWorker(w, between(w, alpha), time);
    for (const r of world.robots) this.drawBot(r, views.get(r), r === focus, world, time);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const r of world.robots) if (!r.manual) this.drawEta(r, world, r === focus);
  }

  // ------------------------------------------------------------ the floor

  drawBase(ws) {
    const canvas = document.createElement("canvas");
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const ctx = canvas.getContext("2d");
    const px = this.px;
    ctx.fillStyle = TILE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.worldTransform(ctx);

    // the building: concrete floor, walls as a band
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.07)";
    ctx.shadowBlur = 20 * this.dpr;
    rr(ctx, 0.5, 0.5, W - 1, H - 1, 0.35);
    ctx.fillStyle = FLOOR;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#dcdce0";
    ctx.lineWidth = 0.14;
    rr(ctx, 0.57, 0.57, W - 1.14, H - 1.14, 0.3);
    ctx.stroke();

    // lanes
    for (let k = 0; k < ws.grid.length; k++) {
      const t = ws.grid[k];
      const x = cellX(k);
      const y = cellY(k);
      if (t === CELL.LANE) {
        ctx.fillStyle = ws.isJunction(k) ? "#ebebee" : LANE;
        ctx.fillRect(x, y, 1, 1);
      } else if (t === CELL.WALK) {
        ctx.fillStyle = "#fffaf0";
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const x0 = V_ROADS[0][0];
    const x1 = V_ROADS[V_ROADS.length - 1][1] + 1;
    const y0 = H_ROADS[0][0];
    const y1 = H_ROADS[H_ROADS.length - 1][1] + 1;
    // road edges: taped lines; centre: a dashed divider between the lanes
    ctx.lineWidth = 1.2 * px;
    ctx.strokeStyle = "rgba(245,158,11,.38)";
    ctx.beginPath();
    for (const [up, down] of H_ROADS) {
      for (const y of [up, down + 1]) {
        for (let x = x0; x < x1; x++) {
          const other = ws.grid[key(x, y === up ? up - 1 : down + 1)];
          if (other === CELL.LANE) continue;
          ctx.moveTo(x, y);
          ctx.lineTo(x + 1, y);
        }
      }
    }
    for (const [left, right] of V_ROADS) {
      for (const x of [left, right + 1]) {
        for (let y = y0; y < y1; y++) {
          const other = ws.grid[key(x === left ? left - 1 : right + 1, y)];
          if (other === CELL.LANE) continue;
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + 1);
        }
      }
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(17,17,19,.16)";
    ctx.setLineDash([0.32, 0.22]);
    ctx.beginPath();
    for (const [up] of H_ROADS) {
      for (let x = x0; x < x1; x++) {
        if (ws.isJunction(key(x, up))) continue;
        ctx.moveTo(x, up + 1);
        ctx.lineTo(x + 1, up + 1);
      }
    }
    for (const [left] of V_ROADS) {
      for (let y = y0; y < y1; y++) {
        if (ws.isJunction(key(left, y))) continue;
        ctx.moveTo(left + 1, y);
        ctx.lineTo(left + 1, y + 1);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // walkways: amber dashed edges, crosswalk stripes across the roads
    ctx.strokeStyle = "rgba(245,158,11,.6)";
    ctx.lineWidth = 1.3 * px;
    ctx.setLineDash([0.16, 0.12]);
    ctx.beginPath();
    for (const x of WALK_COLS) {
      ctx.moveTo(x + 0.06, RACK_ROWS[0]);
      ctx.lineTo(x + 0.06, RACK_ROWS[RACK_ROWS.length - 1] + 1);
      ctx.moveTo(x + 0.94, RACK_ROWS[0]);
      ctx.lineTo(x + 0.94, RACK_ROWS[RACK_ROWS.length - 1] + 1);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const k of ws.crosswalks) {
      const x = cellX(k);
      const y = cellY(k);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x + 0.12, y + 0.08 + i * 0.24, 0.76, 0.12);
        ctx.strokeStyle = "rgba(17,17,19,.08)";
        ctx.lineWidth = px;
        ctx.strokeRect(x + 0.12, y + 0.08 + i * 0.24, 0.76, 0.12);
      }
    }

    // one-way arrows in each lane, every few cells
    ctx.fillStyle = "rgba(17,17,19,.14)";
    for (let k = 0; k < ws.grid.length; k++) {
      if (ws.grid[k] !== CELL.LANE || ws.isJunction(k) || ws.crosswalks.has(k)) continue;
      const x = cellX(k);
      const y = cellY(k);
      const { h, v } = ws.flow[k];
      if ((h ? x : y) % 3 !== 0) continue;
      ctx.save();
      ctx.translate(x + 0.5, y + 0.5);
      ctx.rotate(Math.atan2(v, h));
      ctx.beginPath();
      ctx.moveTo(0.17, 0);
      ctx.lineTo(-0.09, -0.14);
      ctx.lineTo(-0.03, 0);
      ctx.lineTo(-0.09, 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    this.drawRackFrames(ctx);
    this.drawDocks(ctx, ws);
    this.drawPockets(ctx, ws);
    this.drawStaging(ctx, ws);

    // labels, in pixels
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const fs = Math.max(7.5, Math.min(10.5, this.scale * 0.34));
    ctx.font = `600 ${fs}px ${MONO}`;
    ctx.fillStyle = "rgba(17,17,19,.45)";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    if (this.scale > 14) {
      "ABCDEFGH".split("").forEach((letter, i) => {
        const y = RACK_ROWS[i];
        for (const x of [4.5, 23.5]) {
          const p = this.toScreen(x, y + 0.5);
          ctx.fillText(letter, p.x, p.y);
        }
      });
    }
    for (const dock of ws.docks) {
      const p = this.toScreen(cellX(dock.cell) + 0.5, cellY(dock.cell) - 0.62);
      ctx.fillText(`D${dock.id}`, p.x, p.y);
    }
    if (this.scale > 14) {
      for (const s of [...ws.parking, ...ws.chargers]) {
        const p = this.toScreen(cellX(s.cell) + 0.55, cellY(s.cell) + 0.5);
        ctx.fillText(s.id, p.x, p.y);
      }
      ctx.save();
      const p = this.toScreen(1.5, 12);
      ctx.translate(p.x, p.y);
      ctx.rotate(-Math.PI / 2);
      ctx.font = `700 ${(fs * 0.8).toFixed(1)}px ${SANS}`;
      ctx.fillStyle = "rgba(17,17,19,.32)";
      ctx.fillText("INBOUND", 0, 0);
      ctx.restore();
    }
    return canvas;
  }

  drawRackFrames(ctx) {
    const px = this.px;
    // each pair of rows is one back-to-back rack; draw it as one frame
    for (let r = 0; r < RACK_ROWS.length; r += 2) {
      const y = RACK_ROWS[r];
      for (const [xa, xb] of [[5, 13], [15, 23]]) {
        ctx.fillStyle = "#efeff2";
        ctx.fillRect(xa, y, xb - xa, 2);
        // the flue between the two halves
        ctx.strokeStyle = "rgba(17,17,19,.12)";
        ctx.lineWidth = px;
        ctx.setLineDash([0.08, 0.08]);
        ctx.beginPath();
        ctx.moveTo(xa, y + 1);
        ctx.lineTo(xb, y + 1);
        ctx.stroke();
        ctx.setLineDash([]);
        // beams along both faces
        ctx.fillStyle = "#62626b";
        ctx.fillRect(xa, y + 0.02, xb - xa, 0.055);
        ctx.fillRect(xa, y + 2 - 0.075, xb - xa, 0.055);
        // bay dividers and an upright on every corner
        ctx.strokeStyle = "rgba(17,17,19,.12)";
        ctx.beginPath();
        for (let x = xa + 1; x < xb; x++) {
          ctx.moveTo(x, y + 0.08);
          ctx.lineTo(x, y + 1.92);
        }
        ctx.stroke();
        ctx.fillStyle = "#34343a";
        const u = 0.045;
        for (let x = xa; x <= xb; x++) {
          for (const yy of [y, y + 1, y + 2]) ctx.fillRect(x - u, yy - u, u * 2, u * 2);
        }
      }
    }
  }

  drawDocks(ctx, ws) {
    const px = this.px;
    for (const dock of ws.docks) {
      const x = cellX(dock.cell);
      const y = cellY(dock.cell);
      // the door opening in the wall, a little wider than the cell
      ctx.fillStyle = "#e4e4e7";
      ctx.fillRect(x + 0.05, y - 0.35, 0.95, 1.7);
      // leveler plate with its tread pattern
      ctx.fillStyle = "#d4d4d8";
      ctx.fillRect(x + 0.05, y - 0.05, 0.62, 1.1);
      ctx.strokeStyle = "rgba(17,17,19,.1)";
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        ctx.moveTo(x + 0.1 + i * 0.08, y);
        ctx.lineTo(x + 0.1 + i * 0.08 + 0.05, y + 1);
      }
      ctx.stroke();
      // sectional door, open: its panels stacked against the outer wall
      ctx.fillStyle = "#3f3f46";
      ctx.fillRect(x + 0.72, y - 0.35, 0.2, 1.7);
      ctx.fillStyle = "rgba(255,255,255,.18)";
      for (let i = 0; i < 6; i++) ctx.fillRect(x + 0.72, y - 0.3 + i * 0.28, 0.2, 0.03);
      // rubber bumpers either side
      ctx.fillStyle = INK;
      ctx.fillRect(x + 0.02, y - 0.3, 0.07, 0.18);
      ctx.fillRect(x + 0.02, y + 1.12, 0.07, 0.18);
      // traffic light: green, the door is open
      ctx.fillStyle = GREEN;
      ctx.beginPath();
      ctx.arc(x + 0.55, y - 0.2, 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawPockets(ctx, ws) {
    const px = this.px;
    for (const spot of [...ws.parking, ...ws.chargers]) {
      const x = cellX(spot.cell);
      const y = cellY(spot.cell);
      ctx.strokeStyle = "rgba(17,17,19,.22)";
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + 0.06);
      ctx.lineTo(x + 0.12, y + 0.06);
      ctx.lineTo(x + 0.12, y + 0.94);
      ctx.lineTo(x + 1, y + 0.94);
      ctx.stroke();
    }
    for (const c of ws.chargers) {
      const x = cellX(c.cell);
      const y = cellY(c.cell);
      // the wall unit, its cable and the contact plate on the floor
      ctx.fillStyle = "#3f3f46";
      rr(ctx, x - 0.32, y + 0.25, 0.3, 0.5, 0.05);
      ctx.fill();
      ctx.fillStyle = "#c8ad73";
      ctx.fillRect(x + 0.14, y + 0.32, 0.05, 0.12);
      ctx.fillRect(x + 0.14, y + 0.56, 0.05, 0.12);
      ctx.strokeStyle = "#52525b";
      ctx.lineWidth = 1.6 * px;
      ctx.beginPath();
      ctx.moveTo(x - 0.02, y + 0.5);
      ctx.bezierCurveTo(x + 0.06, y + 0.5, x + 0.06, y + 0.38, x + 0.14, y + 0.38);
      ctx.moveTo(x - 0.02, y + 0.5);
      ctx.bezierCurveTo(x + 0.06, y + 0.5, x + 0.06, y + 0.62, x + 0.14, y + 0.62);
      ctx.stroke();
    }
  }

  drawStaging(ctx, ws) {
    for (let k = 0; k < ws.grid.length; k++) {
      const x = cellX(k);
      const y = cellY(k);
      // inbound pallets, between the parking pockets and the chargers
      if (ws.grid[k] !== CELL.STAGING || x !== 1 || y < 9 || y > 14) continue;
      this.pallet(ctx, x + 0.5, y + 0.5, 0.72);
      ctx.fillStyle = BOX;
      ctx.strokeStyle = BOX_EDGE;
      ctx.lineWidth = this.px;
      for (const [bx, by, s] of [[0.2, 0.18, 0.3], [0.52, 0.5, 0.28]]) {
        ctx.fillRect(x + bx, y + by, s, s);
        ctx.strokeRect(x + bx, y + by, s, s);
      }
    }
  }

  pallet(ctx, cx, cy, size) {
    ctx.fillStyle = PALLET;
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    ctx.fillStyle = "rgba(120,90,50,.16)";
    for (let i = 0; i < 4; i++) ctx.fillRect(cx - size / 2, cy - size / 2 + (i * size) / 3 - 0.012, size, 0.024);
  }

  // ------------------------------------------------------------ the stock

  qrImage(pkg) {
    const c = this.qr.get(pkg.id);
    if (c && c.damage === pkg.damage) return c.canvas;
    const n = pkg.code.size;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n;
    const g = canvas.getContext("2d");
    const img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = pkg.code.modules[y][x] ? 30 : 252;
        const i = (y * n + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (pkg.damage) {
      g.fillStyle = pkg.damage === 2 ? "#ead9bb" : "rgba(120,90,50,.8)";
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
    const s = size * (1 + lift * 0.12);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    if (lift > 0.02) {
      ctx.fillStyle = "rgba(0,0,0,.14)";
      ctx.fillRect(-s / 2 + lift * 0.08, -s / 2 + lift * 0.12, s, s);
    }
    ctx.fillStyle = BOX;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeStyle = BOX_EDGE;
    ctx.lineWidth = this.px;
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.fillStyle = "rgba(255,255,255,.32)";
    ctx.fillRect(-s * 0.06, -s / 2, s * 0.12, s);
    const q = s * 0.54;
    ctx.fillStyle = "#fff";
    ctx.fillRect(-q / 2 - s * 0.04, -q / 2 - s * 0.04, q + s * 0.08, q + s * 0.08);
    ctx.imageSmoothingEnabled = this.scale * q < pkg.code.size * 1.2;
    ctx.drawImage(this.qrImage(pkg), -q / 2, -q / 2, q, q);
    ctx.restore();
  }

  drawStock(world) {
    const ctx = this.ctx;
    const px = this.px;
    for (const bay of world.warehouse.bays) {
      const x = cellX(bay.cell);
      const y = cellY(bay.cell);
      // boxes stand at the front of the bay, on a pallet
      const fy = y + 0.5 - Math.sin(bay.facing) * BOX_OFFSET;
      if (bay.pkg) {
        this.pallet(ctx, x + 0.5, fy, 0.6);
        this.drawBox(bay.pkg, x + 0.5, fy, 0.44);
      } else if (bay.expected && !bay.reserved) {
        // the records say something is here
        ctx.setLineDash([0.07, 0.07]);
        ctx.strokeStyle = "rgba(17,17,19,.28)";
        ctx.lineWidth = px;
        ctx.strokeRect(x + 0.24, fy - 0.24, 0.52, 0.48);
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
    rr(ctx, x + 0.08, y + 0.08, 0.84, 0.84, 0.1);
    ctx.stroke();
  }

  drawChargers(world) {
    const ctx = this.ctx;
    for (const c of world.warehouse.chargers) {
      const x = cellX(c.cell) - 0.17;
      const y = cellY(c.cell) + 0.5;
      const busy = world.robots.some((r) => (r.phase === "charging" || r.charging) && Math.hypot(r.x - x - 0.67, r.y - y) < 0.5);
      // a small bolt on the wall unit, green while it charges
      ctx.fillStyle = busy ? "#22c55e" : "rgba(255,255,255,.55)";
      ctx.beginPath();
      ctx.moveTo(x + 0.03, y - 0.15);
      ctx.lineTo(x - 0.06, y + 0.02);
      ctx.lineTo(x + 0.0, y + 0.02);
      ctx.lineTo(x - 0.03, y + 0.15);
      ctx.lineTo(x + 0.07, y - 0.03);
      ctx.lineTo(x + 0.01, y - 0.03);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ------------------------------------------------------------- traffic

  drawHeld(r, focused) {
    if (r.manual) return;
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(${PLAN},${focused ? 0.08 : 0.05})`;
    for (const c of r.held) ctx.fillRect(cellX(c) + 0.07, cellY(c) + 0.07, 0.86, 0.86);
  }

  drawRoute(r, v, focused) {
    const path = r.path;
    if (!path || r.i >= path.length - 1 || !/^to/.test(r.phase)) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(v.x, v.y);
    // rounded the way the robot drives the corners
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
    ctx.strokeStyle = `rgba(${PLAN},${focused ? 0.6 : 0.32})`;
    ctx.lineWidth = focused ? 0.1 : 0.07;
    ctx.stroke();
    // planned waits: a pause mark where it lets someone else go first
    if (r.tout) {
      ctx.fillStyle = `rgba(${PLAN},${focused ? 0.85 : 0.5})`;
      for (let j = r.i; j < path.length - 1; j++) {
        if (r.tout[j] - r.tin[j] < 0.3) continue;
        const c = center(path[j]);
        ctx.fillRect(c.x - 0.09, c.y - 0.1, 0.06, 0.2);
        ctx.fillRect(c.x + 0.03, c.y - 0.1, 0.06, 0.2);
      }
    }
    const end = center(path[path.length - 1]);
    ctx.fillStyle = `rgba(${PLAN},${focused ? 0.95 : 0.55})`;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 0.09, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The time to the end of the route, in a small tag at its end. */
  drawEta(r, world, focused) {
    if (!r.path || !r.eta || !/^to/.test(r.phase) || r.i >= r.path.length - 1) return;
    if (!focused && world.robots.length > 2) return;
    const ctx = this.ctx;
    const end = center(r.path[r.path.length - 1]);
    const p = this.toScreen(end.x, end.y);
    const left = Math.max(0, r.eta - world.time);
    const text = `${Math.ceil(left)} s`;
    ctx.font = `600 10px ${SANS}`;
    const w = ctx.measureText(text).width + 12;
    const x = Math.min(p.x + 8, this.width - w - 4);
    const y = Math.max(4, p.y - 19);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.16)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    rr(ctx, x, y, w, 16, 8);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = `rgb(${PLAN})`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + 8.5);
  }

  drawLidar(r, v) {
    const ctx = this.ctx;
    const n = SPEC.lidarRays;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      const d = r.lidar[k];
      if (k === 0) ctx.moveTo(v.x, v.y);
      ctx.lineTo(v.x + Math.cos(a) * d, v.y + Math.sin(a) * d);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(37,99,235,.035)";
    ctx.fill();
    ctx.fillStyle = "rgba(17,17,19,.42)";
    for (let k = 0; k < n; k++) {
      const d = r.lidar[k];
      if (d >= SPEC.lidarRange - 0.01) continue;
      const a = v.h - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      ctx.fillRect(v.x + Math.cos(a) * d - 0.025, v.y + Math.sin(a) * d - 0.025, 0.05, 0.05);
    }
    if (r.safety !== "clear") {
      ctx.fillStyle = r.safety === "stop" ? "rgba(239,68,68,.15)" : "rgba(245,158,11,.13)";
      ctx.beginPath();
      ctx.moveTo(v.x, v.y);
      ctx.arc(v.x, v.y, r.safety === "stop" ? SPEC.stop : SPEC.slow * 0.7, v.h - 0.5, v.h + 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWorker(w, v, time) {
    const ctx = this.ctx;
    const t = w.moving && !this.reducedMotion ? time * 7 + w.id * 1.7 : 0;
    const swing = Math.sin(t) * 0.06;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.h);
    ctx.fillStyle = "rgba(0,0,0,.1)";
    ctx.beginPath();
    ctx.ellipse(0.03, 0.04, 0.16, 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    // arms, swinging opposite to each other
    ctx.fillStyle = "#3f3f46";
    ctx.beginPath();
    ctx.ellipse(swing, -0.2, 0.07, 0.045, 0, 0, Math.PI * 2);
    ctx.ellipse(-swing, 0.2, 0.07, 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    // shoulders in a hi-vis vest with reflective bands
    ctx.fillStyle = AMBER;
    rr(ctx, -0.1, -0.2, 0.2, 0.4, 0.09);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillRect(-0.03, -0.2, 0.025, 0.4);
    ctx.fillRect(0.035, -0.2, 0.025, 0.4);
    // head under a white hard hat, its brim to the front
    ctx.fillStyle = "#fafafa";
    ctx.beginPath();
    ctx.ellipse(0.02, 0, 0.085, 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(17,17,19,.35)";
    ctx.lineWidth = this.px;
    ctx.stroke();
    ctx.fillStyle = "rgba(17,17,19,.25)";
    ctx.fillRect(0.075, -0.05, 0.02, 0.1);
    ctx.restore();
    if (w.waiting) {
      ctx.strokeStyle = "rgba(245,158,11,.6)";
      ctx.lineWidth = 1.2 * this.px;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawBot(r, v, focused, world, time) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.h);
    const moving = Math.abs(r.v) > 0.05 || Math.abs(r.w) > 0.05;
    drawRobot(ctx, {
      px: this.px,
      reach: v.fr,
      color: status(r),
      id: r.id + 1,
      beacon: (moving || !!r.waiting) && !this.reducedMotion,
      time,
    });
    ctx.restore();
    if (r.load) {
      const lift = Math.max(0, v.fh - SPEC.travelHeight) / SPEC.maxFork;
      const d = (LOAD.x0 + LOAD.x1) / 2 + v.fr * FORK.reach;
      this.drawBox(r.load, v.x + Math.cos(v.h) * d, v.y + Math.sin(v.h) * d, LOAD.x1 - LOAD.x0, v.h + Math.PI / 2, lift);
    }
    if (/scan/i.test(r.phase) && r.timer < SCAN_TIME && r.load) this.drawLaser(r, v);
    if (world.robots.length > 1 || focused) {
      ctx.save();
      ctx.translate(v.x - Math.cos(v.h) * 0.6, v.y - Math.sin(v.h) * 0.6);
      ctx.scale(this.px, this.px);
      ctx.fillStyle = focused ? INK : "rgba(17,17,19,.55)";
      ctx.font = `700 10px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(r.id + 1), 0, 0);
      ctx.restore();
    }
  }

  drawLaser(r, v) {
    const ctx = this.ctx;
    const d = (LOAD.x0 + LOAD.x1) / 2 + v.fr * FORK.reach;
    const c = Math.cos(v.h);
    const sn = Math.sin(v.h);
    const cx = v.x + c * d;
    const cy = v.y + sn * d;
    // one sweep across the label per read, on the portfolio's easing curve
    const t = Math.min(1, r.timer / SCAN_TIME);
    const phase = this.reducedMotion ? 0.5 : t < 0.5 ? portfolioEase(t * 2) : 1 - portfolioEase((t - 0.5) * 2);
    const sweep = (phase - 0.5) * 0.34;
    const nx = -sn;
    const ny = c;
    const ox = v.x + c * 0.02;
    const oy = v.y + sn * 0.02;
    const ax = cx + nx * 0.2 + c * sweep;
    const ay = cy + ny * 0.2 + sn * sweep;
    const bx = cx - nx * 0.2 + c * sweep;
    const by = cy - ny * 0.2 + sn * sweep;
    ctx.fillStyle = `rgba(${PLAN},.1)`;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgb(${PLAN})`;
    ctx.lineWidth = 2 * this.px;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // ------------------------------------------------- the planner, explained

  /**
   * Replays a recorded space-time A* search: cells it settled in pale
   * blue, the frontier as outlines, cells others have booked in amber,
   * then the route it chose.
   */
  drawPlanView(world, now) {
    const pv = this.planView;
    const ctx = this.ctx;
    const t = this.reducedMotion ? 1 : Math.min(1, (now - pv.started) / pv.duration);
    const shown = Math.floor(pv.trace.length * t);
    const closed = new Set();
    const open = new Set();
    for (let i = 0; i < shown; i++) {
      const [type, cell] = pv.trace[i];
      if (type === 1) {
        closed.add(cell);
        open.delete(cell);
      } else if (!closed.has(cell)) open.add(cell);
    }
    ctx.fillStyle = "rgba(245,158,11,.16)";
    for (const cell of pv.booked) ctx.fillRect(cellX(cell) + 0.04, cellY(cell) + 0.04, 0.92, 0.92);
    ctx.fillStyle = `rgba(${PLAN},.16)`;
    for (const c of closed) ctx.fillRect(cellX(c) + 0.1, cellY(c) + 0.1, 0.8, 0.8);
    ctx.strokeStyle = `rgba(${PLAN},.6)`;
    ctx.lineWidth = 1.2 * this.px;
    for (const c of open) ctx.strokeRect(cellX(c) + 0.14, cellY(c) + 0.14, 0.72, 0.72);
    if (t >= 1 && pv.path) {
      ctx.strokeStyle = `rgb(${PLAN})`;
      ctx.lineWidth = 0.12;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      pv.path.forEach((c, i) => {
        const p = center(c);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
  }
}
