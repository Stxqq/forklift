// The label lab: type a label, watch the real encoder build its QR code
// one step at a time, scratch it, and let the real decoder read it back.

import { decode, explain, rasterize } from "../sim/qr.js";
import { labelPNG, labelSVG } from "../lab/export.js";

const INK = "#111113";
const BLUE = "#2563eb";
const QUIET = 2;

export const STEPS = [
  {
    title: "Function patterns",
    text: "Three finder squares tell a scanner where the code is and which way up it is. The dotted timing lines give it the grid, and from version 2 on a small alignment square helps with a bent label. None of these carry data.",
  },
  {
    title: "Data as bits",
    text: "The text becomes bytes. In front go four bits for the mode (byte mode is 0100) and eight for the length; behind, a terminator, zeros to a whole byte, and the pad bytes 11101100 and 00010001 until the code is full.",
  },
  {
    title: "Reed–Solomon",
    text: "",
  },
  {
    title: "Placement",
    text: "The codewords are laid in two-module columns, snaking up and down from the bottom right, skipping every function pattern.",
  },
  {
    title: "Masks",
    text: "Large blocks of one color or patterns that look like a finder confuse scanners, so one of eight fixed patterns is XORed over the data. Each gets a penalty score; the lowest wins. Click one to force it.",
  },
  {
    title: "Format bits",
    text: "",
  },
  {
    title: "The finished code",
    text: "Click or drag on modules to scratch them, then scan. The decoder reads the pixels, finds the grid and lets Reed–Solomon repair what it can.",
  },
];

const SEGMENT_COLORS = { mode: INK, count: BLUE, data: "#a1a1aa", terminator: "#52525b", fill: "#c4c4ca", pad: "#dcdce0" };

export class Lab {
  constructor(root, { motion }) {
    this.root = root;
    this.motion = motion;
    this.canvas = root.querySelector("#lab-grid");
    this.ctx = this.canvas.getContext("2d");
    this.input = root.querySelector("#lab-text");
    this.meta = root.querySelector("#lab-meta");
    this.title = root.querySelector("#lab-step-title");
    this.body = root.querySelector("#lab-step-text");
    this.extra = root.querySelector("#lab-step-extra");
    this.dots = root.querySelector("#lab-dots");
    this.result = root.querySelector("#lab-result");
    this.level = "M";
    this.forced = null;
    this.step = 0;
    this.scratch = new Set();
    this.playing = false;
    this.placeStart = 0;
    STEPS.forEach((s, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lab-dot";
      b.setAttribute("aria-label", `Step ${i + 1}: ${s.title}`);
      b.textContent = String(i + 1);
      b.addEventListener("click", () => this.go(i, true));
      this.dots.append(b);
    });
    root.querySelector("#lab-prev").addEventListener("click", () => this.go(this.step - 1, true));
    root.querySelector("#lab-next").addEventListener("click", () => this.go(this.step + 1, true));
    this.playButton = root.querySelector("#lab-play");
    this.playButton.addEventListener("click", () => this.toggle());
    this.input.addEventListener("input", () => this.build());
    for (const chip of root.querySelectorAll("[data-level]")) {
      chip.addEventListener("click", () => {
        this.level = chip.dataset.level;
        for (const c of root.querySelectorAll("[data-level]")) c.setAttribute("aria-pressed", String(c === chip));
        this.forced = null;
        this.build();
      });
    }
    root.querySelector("#lab-scan").addEventListener("click", () => this.scan());
    root.querySelector("#lab-reset").addEventListener("click", () => {
      this.scratch.clear();
      this.result.innerHTML = "";
      this.draw();
    });
    root.querySelector("#lab-png").addEventListener("click", () => this.download("png"));
    root.querySelector("#lab-svg").addEventListener("click", () => this.download("svg"));
    root.querySelector("#lab-print").addEventListener("click", () => this.print());
    this.bindScratch();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.build();
  }

  build() {
    try {
      this.e = explain(this.input.value || " ", { level: this.level, mask: this.forced });
      this.input.removeAttribute("aria-invalid");
    } catch {
      this.input.setAttribute("aria-invalid", "true");
      this.meta.textContent = `Too long for version 4 at level ${this.level}`;
      return;
    }
    const e = this.e;
    this.scratch.clear();
    this.result.innerHTML = "";
    this.meta.innerHTML = `<b>Version ${e.version}</b> · ${e.size}×${e.size} · level ${e.level} · ${e.bytes.length} of ${e.capacity} bytes · mask ${e.mask}${this.forced !== null ? " (forced)" : ""}`;
    this.go(this.step, false);
  }

  resize() {
    const { width } = this.canvas.getBoundingClientRect();
    if (!width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.height = Math.round(width * dpr);
    this.dpr = dpr;
    this.draw();
  }

  go(i, user) {
    if (user) this.stop();
    this.step = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[this.step];
    const e = this.e;
    this.title.textContent = `${this.step + 1} · ${s.title}`;
    this.body.textContent = this.text();
    this.extra.innerHTML = "";
    if (this.step === 1) this.extra.append(this.bitStrip());
    if (this.step === 2) this.extra.append(this.codewords());
    if (this.step === 4) this.extra.append(this.maskThumbs());
    if (this.step === 5) this.extra.append(this.formatStrip());
    this.root.dataset.step = String(this.step + 1);
    [...this.dots.children].forEach((d, k) => d.setAttribute("aria-current", String(k === this.step)));
    this.placeStart = performance.now();
    if (!this.motion.matches && user !== null) {
      for (const el of [this.title, this.body, this.extra]) el.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.32,.72,0,1)" });
    }
    void e;
    this.draw();
    if (this.step === 3) this.animatePlacement();
  }

  text() {
    const e = this.e;
    if (this.step === 2) {
      const fix = Math.floor(e.ecPerBlock / 2);
      const per = e.blocks.length > 1 ? ` in each of its ${e.blocks.length} blocks` : "";
      return `The ${e.dataWords.length} data codewords are treated as a polynomial and divided by a fixed one; the remainder is ${e.ecPerBlock * e.blocks.length} parity codewords. A decoder can solve for up to ${fix} wrong codewords${per} from them, which is why a smudged label still reads.`;
    }
    if (this.step === 5) {
      return `Fifteen bits say which level and mask were used: two for the level, three for the mask, ten of BCH error correction, all XORed with 101010000010010. They're written twice, around the finders. Version information only exists from version 7 on; this is version ${e.version}, so there is none.`;
    }
    return STEPS[this.step].text;
  }

  // the module grid in its current state for this step
  modulesNow() {
    const e = this.e;
    const n = e.size;
    const out = Array.from({ length: n }, () => new Array(n).fill(null));
    const fn = (x, y) => e.roles[y][x];
    const final = e.code.modules;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const role = fn(x, y);
        if (role && role !== "format") out[y][x] = { on: final[y][x], role };
        else if (role === "format") out[y][x] = this.step >= 5 ? { on: final[y][x], role } : { on: false, role: "reserved" };
      }
    }
    if (this.step >= 3) {
      const placed = this.step === 3 ? this.placed : e.order.length;
      const src = this.step === 3 ? e.unmasked : final;
      for (let i = 0; i < placed && i < e.order.length; i++) {
        const [x, y] = e.order[i];
        out[y][x] = { on: src[y][x], role: "data" };
      }
    }
    return out;
  }

  draw() {
    if (!this.e || !this.dpr) return;
    const ctx = this.ctx;
    const e = this.e;
    const W = this.canvas.width;
    const n = e.size + QUIET * 2;
    const m = W / n;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, W);
    const grid = this.modulesNow();
    const step = this.step;
    for (let y = 0; y < e.size; y++) {
      for (let x = 0; x < e.size; x++) {
        const cell = grid[y][x];
        const px = (x + QUIET) * m;
        const py = (y + QUIET) * m;
        let on = cell?.on;
        if (step === 6 && this.scratch.has(y * e.size + x)) on = !on;
        if (!cell) {
          ctx.fillStyle = "#f4f4f5";
          ctx.fillRect(px + m * 0.08, py + m * 0.08, m * 0.84, m * 0.84);
          continue;
        }
        let color = INK;
        if (step === 0) {
          color = { finder: INK, separator: "#fff", timing: BLUE, alignment: BLUE, dark: INK, reserved: "#fff" }[cell.role] ?? INK;
          if (cell.role === "reserved") {
            ctx.fillStyle = "#ececef";
            ctx.fillRect(px, py, m, m);
            continue;
          }
        } else if (step === 5 && cell.role === "format") color = on ? BLUE : "#fff";
        else if (step >= 1 && step <= 4 && cell.role !== "data") color = "#c8c8ce";
        if (cell.role === "reserved") {
          ctx.fillStyle = step === 5 ? "#fff" : "#ececef";
          ctx.fillRect(px, py, m, m);
          continue;
        }
        if (on) {
          ctx.fillStyle = color;
          ctx.fillRect(px, py, m + 0.5, m + 0.5);
        } else if (step === 5 && cell.role === "format") {
          ctx.fillStyle = "rgba(37,99,235,.14)";
          ctx.fillRect(px, py, m, m);
        }
        if (step === 6 && this.scratch.has(y * e.size + x)) {
          // a scratched module: flipped, and ringed so you can find it again
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = Math.max(1, m * 0.12);
          ctx.strokeRect(px + m * 0.12, py + m * 0.12, m * 0.76, m * 0.76);
        }
      }
    }
    if (step === 3 && this.placed < e.order.length) {
      // the head of the snake
      const [x, y] = e.order[Math.max(0, this.placed - 1)];
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = Math.max(1.5, m * 0.18);
      ctx.strokeRect((x + QUIET) * m, (y + QUIET) * m, m, m);
    }
    if (step === 5) {
      ctx.strokeStyle = "rgba(37,99,235,.55)";
      ctx.lineWidth = Math.max(1, m * 0.1);
      for (const copy of e.format.cells) for (const [x, y] of copy) ctx.strokeRect((x + QUIET) * m + 0.5, (y + QUIET) * m + 0.5, m - 1, m - 1);
    }
  }

  animatePlacement() {
    const e = this.e;
    const total = e.order.length;
    const dur = this.motion.matches ? 0 : 2400;
    const started = this.placeStart;
    const tick = (now) => {
      if (this.step !== 3 || this.placeStart !== started) return;
      const t = dur ? Math.min(1, (now - started) / dur) : 1;
      this.placed = Math.round(total * t);
      this.draw();
      if (t < 1) requestAnimationFrame(tick);
    };
    this.placed = 0;
    requestAnimationFrame(tick);
  }

  bitStrip() {
    const wrap = document.createElement("div");
    wrap.className = "bitstrip";
    const strip = document.createElement("div");
    strip.className = "bits";
    const legend = document.createElement("p");
    legend.className = "legend";
    for (const seg of this.e.segments) {
      const shown = seg.bits.length > 96 ? seg.bits.slice(0, 96) : seg.bits;
      for (const b of shown) {
        const i = document.createElement("i");
        i.style.background = b === "1" ? SEGMENT_COLORS[seg.kind] : "#fff";
        i.style.borderColor = SEGMENT_COLORS[seg.kind];
        strip.append(i);
      }
      if (seg.bits.length > 96) {
        const more = document.createElement("span");
        more.textContent = `+${seg.bits.length - 96}`;
        strip.append(more);
      }
      legend.insertAdjacentHTML("beforeend", `<i style="background:${SEGMENT_COLORS[seg.kind]}"></i><span>${seg.label}</span>`);
    }
    wrap.append(strip, legend);
    return wrap;
  }

  codewords() {
    const wrap = document.createElement("div");
    wrap.className = "words";
    const hex = (w) => w.toString(16).padStart(2, "0").toUpperCase();
    this.e.blocks.forEach((b, i) => {
      const row = document.createElement("div");
      row.className = "word-row";
      const label = this.e.blocks.length > 1 ? `<small>Block ${i + 1}</small>` : "";
      row.innerHTML = `${label}<div class="chips-w">${b.data.map((w) => `<code>${hex(w)}</code>`).join("")}${b.ec.map((w) => `<code class="ec">${hex(w)}</code>`).join("")}</div>`;
      wrap.append(row);
    });
    wrap.insertAdjacentHTML("beforeend", `<p class="legend"><i style="background:#d4d4d8"></i><span>data</span><i style="background:${BLUE}"></i><span>parity</span></p>`);
    return wrap;
  }

  maskThumbs() {
    const wrap = document.createElement("div");
    wrap.className = "masks";
    for (const m of this.e.masks) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mask";
      b.setAttribute("aria-pressed", String(m.mask === this.e.mask));
      const c = document.createElement("canvas");
      const n = this.e.size;
      c.width = c.height = n * 3;
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = INK;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.modules[y][x]) g.fillRect(x * 3, y * 3, 3, 3);
      b.append(c);
      b.insertAdjacentHTML("beforeend", `<span>Mask ${m.mask}</span><b>${m.penalty}</b>${m.mask === this.e.best ? "<em>lowest</em>" : ""}`);
      b.addEventListener("click", () => {
        this.forced = m.mask === this.e.best ? null : m.mask;
        this.build();
      });
      wrap.append(b);
    }
    return wrap;
  }

  formatStrip() {
    const wrap = document.createElement("div");
    wrap.className = "format";
    const t = this.e.format.text;
    // ISO order: bit 14 first; level 2 bits, mask 3 bits, 10 BCH bits
    const parts = [
      ["Level", t.slice(0, 2), INK],
      ["Mask", t.slice(2, 5), BLUE],
      ["BCH", t.slice(5), "#a1a1aa"],
    ];
    wrap.innerHTML = parts.map(([name, bits, color]) => `<div><small>${name}</small><code style="border-color:${color}">${bits}</code></div>`).join("");
    return wrap;
  }

  // ------------------------------------------------------- damage test

  bindScratch() {
    let painting = false;
    let seen = new Set();
    const at = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const n = this.e.size + QUIET * 2;
      const x = Math.floor(((ev.clientX - r.left) / r.width) * n) - QUIET;
      const y = Math.floor(((ev.clientY - r.top) / r.height) * n) - QUIET;
      if (x < 0 || y < 0 || x >= this.e.size || y >= this.e.size) return -1;
      return y * this.e.size + x;
    };
    const flip = (ev) => {
      const k = at(ev);
      if (k < 0 || seen.has(k)) return;
      seen.add(k);
      if (this.scratch.has(k)) this.scratch.delete(k);
      else this.scratch.add(k);
      this.draw();
    };
    this.canvas.addEventListener("pointerdown", (ev) => {
      if (this.step !== 6) return;
      painting = true;
      seen = new Set();
      this.canvas.setPointerCapture(ev.pointerId);
      flip(ev);
      ev.preventDefault();
    });
    this.canvas.addEventListener("pointermove", (ev) => painting && flip(ev));
    const end = () => (painting = false);
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  /** The code as it is now, scratches and all. */
  scratched() {
    const e = this.e;
    const modules = e.code.modules.map((row) => row.slice());
    for (const k of this.scratch) {
      const x = k % e.size;
      const y = Math.floor(k / e.size);
      modules[y][x] = !modules[y][x];
    }
    return { ...e.code, modules };
  }

  scan() {
    if (this.step !== 6) this.go(6, true);
    const res = scanLab(this.e, this.scratched());
    const total = this.e.words.length;
    const cells = Array.from({ length: total }, (_, i) => {
      const cls = res.fixed.has(i) ? "fixed" : res.wrong.has(i) ? "bad" : "";
      return `<i class="${cls}" title="Codeword ${i + 1}"></i>`;
    }).join("");
    const limit = Math.floor(this.e.ecPerBlock / 2);
    const head = res.ok
      ? `<b class="ok">✓ ${escape(res.text)}</b><span>${res.corrected ? `Reed–Solomon fixed ${res.corrected} codeword${res.corrected === 1 ? "" : "s"}.` : "Read clean, nothing to fix."} Up to ${limit}${this.e.blocks.length > 1 ? " per block" : ""} can be fixed at this level.</span>`
      : `<b class="bad">✗ ${res.reason === "too damaged to correct" ? "Too damaged" : escape(res.reason)}</b><span>${res.wrong.size} codeword${res.wrong.size === 1 ? "" : "s"} wrong; up to ${limit}${this.e.blocks.length > 1 ? " per block" : ""} can be fixed at this level.</span>`;
    this.result.innerHTML = `<p class="lab-verdict">${head}</p><div class="cw-map" aria-label="Codewords: fixed ones in blue, unrecoverable in red">${cells}</div><p class="legend"><i style="background:#e4e4e7"></i><span>read fine</span><i style="background:${BLUE}"></i><span>fixed</span><i style="background:#ef4444"></i><span>wrong, not fixed</span></p>`;
  }

  download(kind) {
    const e = this.e;
    const name = (e.text.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "label").slice(0, 40);
    let blob;
    if (kind === "svg") blob = new Blob([labelSVG(e.code, e.text)], { type: "image/svg+xml" });
    else blob = new Blob([labelPNG(e.code, e.text).png], { type: "image/png" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${kind}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  print() {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><title>Label</title><style>@page{margin:12mm}body{margin:0;display:grid;place-items:center;height:100vh}svg{width:60mm;height:auto}</style>${labelSVG(this.e.code, this.e.text)}`);
    doc.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 2000);
  }

  toggle() {
    if (this.playing) return this.stop();
    this.playing = true;
    this.playButton.setAttribute("aria-pressed", "true");
    this.playButton.textContent = "Pause";
    if (this.step === STEPS.length - 1) this.go(0, null);
    const next = () => {
      if (!this.playing) return;
      if (this.step >= STEPS.length - 1) return this.stop();
      this.go(this.step + 1, null);
      this.timer = setTimeout(next, this.step === 3 ? 3400 : 2800);
    };
    this.timer = setTimeout(next, 2400);
  }

  stop() {
    this.playing = false;
    clearTimeout(this.timer);
    this.playButton.setAttribute("aria-pressed", "false");
    this.playButton.textContent = "Play";
  }
}

const escape = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

/**
 * Scan a lab code: rasterize it, run the decoder, and work out which
 * codewords came off the pixels wrong (against what was encoded) and
 * which of those Reed–Solomon put right. DOM-free, for the tests too.
 */
export function scanLab(e, code) {
  const res = decode(rasterize(code, { scale: 6, quiet: 4 }));
  const wrong = new Set();
  const fixed = new Set();
  if (res.info) {
    res.info.raw.forEach((w, i) => {
      if (w !== e.words[i]) wrong.add(i);
    });
    for (const i of res.info.wrong) fixed.add(i);
  }
  return { ok: res.ok, text: res.text, reason: res.reason, corrected: res.corrected ?? 0, wrong, fixed };
}
