// A QR code encoder and a decoder that reads one back from pixels.
// Versions 1–4, byte mode, all four error-correction levels, all eight
// masks with the standard penalty score. The decoder takes a grayscale
// image of an upright code (what the robot's scanner sees through its
// window), finds the grid from the finder patterns, reads the format,
// unmasks, de-interleaves and corrects with Reed–Solomon.

import { rsDecode, rsEncode } from "./rs.js";

export const LEVELS = { L: 1, M: 0, Q: 3, H: 2 };
const LEVEL_NAMES = { 1: "L", 0: "M", 3: "Q", 2: "H" };

// per version: total codewords, then per level [ec per block, blocks, data per block]
const TABLE = {
  1: { total: 26, L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
  2: { total: 44, L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
  3: { total: 70, L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
  4: { total: 100, L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
};
const ALIGN = { 1: null, 2: 18, 3: 22, 4: 26 };
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7 };
export const MAX_VERSION = 4;

export const sizeOf = (version) => 17 + 4 * version;
/** Most bytes that fit in byte mode. */
export const capacity = (version, level) => {
  const [, blocks, data] = TABLE[version][level];
  return blocks * data - 2;
};

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 15 format bits: level and mask, BCH(15,5), XOR 0x5412. */
export function formatBits(level, mask) {
  const data = (LEVELS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const bit = (x, i) => ((x >>> i) & 1) === 1;

/** The function patterns of a version: which modules are fixed, and their colors. */
function template(version) {
  const size = sizeOf(version);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const a = ALIGN[version];
  if (a) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(a + dx, a + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // reserve the format areas; drawFormat fills them
  drawFormat(modules, fixed, 0);
  return { size, modules, fixed };
}

function formatCells(size) {
  const first = [];
  for (let i = 0; i <= 5; i++) first.push([8, i]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) first.push([14 - i, 8]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) second.push([8, size - 15 + i]);
  return [first, second];
}

function drawFormat(modules, fixed, bits) {
  const size = modules.length;
  for (const copy of formatCells(size)) {
    copy.forEach(([x, y], i) => {
      modules[y][x] = bit(bits, i);
      fixed[y][x] = true;
    });
  }
  modules[size - 8][8] = true;
  fixed[size - 8][8] = true;
}

/**
 * The data modules of a version in placement order: module k carries bit
 * k % 8 (from the top) of codeword floor(k / 8). For tests and the page.
 */
export function dataModules(version) {
  const { size, fixed } = template(version);
  const cells = [];
  zigzag(size, fixed, (x, y) => cells.push([x, y]));
  return cells;
}

/** Visits the data modules in placement order. */
function zigzag(size, fixed, visit) {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!fixed[y][x]) visit(x, y);
      }
    }
  }
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
      for (let b = 0; b + 7 <= size; b++) {
        // 1:1:3:1:1 with four light modules on one side
        const core = get(a, b) && !get(a, b + 1) && get(a, b + 2) && get(a, b + 3) && get(a, b + 4) && !get(a, b + 5) && get(a, b + 6);
        if (!core) continue;
        const lightBefore = b >= 4 && !get(a, b - 1) && !get(a, b - 2) && !get(a, b - 3) && !get(a, b - 4);
        const lightAfter = b + 11 <= size && !get(a, b + 7) && !get(a, b + 8) && !get(a, b + 9) && !get(a, b + 10);
        if (lightBefore || lightAfter) score += 40;
      }
    }
  };
  lines((a, b) => m[a][b]);
  lines((a, b) => m[b][a]);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The final codeword sequence for some data: padded, blocked, RS, interleaved. */
export function codewords(bytes, version, level) {
  const [ec, blocks, perBlock] = TABLE[version][level];
  const dataCount = blocks * perBlock;
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = dataCount * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  for (let pad = 0xec; data.length < dataCount; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks = [];
  const ecBlocks = [];
  for (let k = 0; k < blocks; k++) {
    const block = data.slice(k * perBlock, (k + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ec));
  }
  const out = [];
  for (let i = 0; i < perBlock; i++) for (const b of dataBlocks) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

const utf8 = (text) => [...new TextEncoder().encode(text)];

/**
 * Encodes text as the smallest code that fits at `level`. Returns
 * { version, level, mask, size, modules } with modules[y][x] true for dark.
 */
export function encode(text, { level = "M", version = null, mask = null } = {}) {
  const bytes = utf8(text);
  let v = version;
  if (v === null) {
    for (v = 1; v <= MAX_VERSION && capacity(v, level) < bytes.length; v++);
  }
  if (v > MAX_VERSION || capacity(v, level) < bytes.length) throw new Error(`"${text}" doesn't fit a version ${MAX_VERSION} code at level ${level}`);
  const words = codewords(bytes, v, level);
  const { size, modules, fixed } = template(v);
  let i = 0;
  const total = words.length * 8;
  zigzag(size, fixed, (x, y) => {
    modules[y][x] = i < total ? bit(words[i >>> 3], 7 - (i & 7)) : false;
    i++;
  });
  const masked = (k) => {
    const m = modules.map((row) => row.slice());
    const f = MASKS[k];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && f(x, y)) m[y][x] = !m[y][x];
    drawFormat(m, fixed.map((row) => row.slice()), formatBits(level, k));
    return m;
  };
  let best = mask;
  let chosen = mask === null ? null : masked(mask);
  if (mask === null) {
    let low = Infinity;
    for (let k = 0; k < 8; k++) {
      const m = masked(k);
      const p = penalty(m);
      if (p < low) {
        low = p;
        best = k;
        chosen = m;
      }
    }
  }
  return { version: v, level, mask: best, size, modules: chosen };
}

/**
 * Every step of building a code, for the label lab: the function
 * patterns, the bit stream part by part, the Reed–Solomon blocks, the
 * placement order, all eight masks with their penalty scores and the
 * format bits. `mask` forces one.
 */
export function explain(text, { level = "M", mask = null } = {}) {
  const bytes = utf8(text);
  let version = 1;
  while (version <= MAX_VERSION && capacity(version, level) < bytes.length) version++;
  if (version > MAX_VERSION) throw new Error(`"${text}" doesn't fit a version ${MAX_VERSION} code at level ${level}`);
  const [ec, blocks, perBlock] = TABLE[version][level];
  const dataCount = blocks * perBlock;
  const bin = (v, n) => v.toString(2).padStart(n, "0");
  const segments = [
    { kind: "mode", label: "Mode: byte", bits: "0100" },
    { kind: "count", label: `Length: ${bytes.length}`, bits: bin(bytes.length, 8) },
    { kind: "data", label: `${bytes.length} data bytes`, bits: bytes.map((b) => bin(b, 8)).join("") },
  ];
  const used = 12 + bytes.length * 8;
  const term = Math.min(4, dataCount * 8 - used);
  segments.push({ kind: "terminator", label: "Terminator", bits: "0".repeat(term) });
  const fill = (8 - ((used + term) % 8)) % 8;
  if (fill) segments.push({ kind: "fill", label: "To a whole byte", bits: "0".repeat(fill) });
  const padCount = dataCount - (used + term + fill) / 8;
  const pads = [];
  for (let i = 0; i < padCount; i++) pads.push(i % 2 ? 0x11 : 0xec);
  if (pads.length) segments.push({ kind: "pad", label: `${pads.length} pad bytes`, bits: pads.map((b) => bin(b, 8)).join("") });

  const words = codewords(bytes, version, level);
  const dataWords = [];
  const blockList = [];
  for (let b = 0; b < blocks; b++) {
    const data = [];
    const parity = [];
    for (let i = 0; i < perBlock; i++) data.push(words[i * blocks + b]);
    for (let i = 0; i < ec; i++) parity.push(words[dataCount + i * blocks + b]);
    blockList.push({ data, ec: parity });
    dataWords.push(...data);
  }

  const { size, modules, fixed } = template(version);
  // what each fixed module is, for highlighting
  const roles = Array.from({ length: size }, () => new Array(size).fill(null));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fixed[y][x]) continue;
      const inFinder = (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
      const a = ALIGN[version];
      if (inFinder) {
        const fx = x < 8 ? 3 : size - 4;
        const fy = y < 8 ? 3 : size - 4;
        roles[y][x] = Math.max(Math.abs(x - fx), Math.abs(y - fy)) >= 4 ? "separator" : "finder";
      } else if (a && Math.abs(x - a) <= 2 && Math.abs(y - a) <= 2) roles[y][x] = "alignment";
      else if (x === 6 || y === 6) roles[y][x] = "timing";
      else roles[y][x] = "format";
    }
  }
  roles[size - 8][8] = "dark";
  for (const copy of formatCells(size)) for (const [x, y] of copy) if (roles[y][x] === null || roles[y][x] === "separator") roles[y][x] = "format";

  const order = [];
  zigzag(size, fixed, (x, y) => order.push([x, y]));
  const unmasked = modules.map((row) => row.slice());
  order.forEach(([x, y], i) => (unmasked[y][x] = i < words.length * 8 ? bit(words[i >>> 3], 7 - (i & 7)) : false));
  const masks = [];
  for (let k = 0; k < 8; k++) {
    const m = unmasked.map((row) => row.slice());
    const f = MASKS[k];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && f(x, y)) m[y][x] = !m[y][x];
    drawFormat(m, fixed.map((row) => row.slice()), formatBits(level, k));
    masks.push({ mask: k, modules: m, penalty: penalty(m) });
  }
  const best = masks.reduce((a, b) => (b.penalty < a.penalty ? b : a)).mask;
  const chosen = mask ?? best;
  const format = formatBits(level, chosen);
  return {
    text,
    bytes,
    version,
    level,
    size,
    capacity: capacity(version, level),
    ecPerBlock: ec,
    blocks: blockList,
    segments,
    dataWords,
    words,
    roles,
    order,
    unmasked,
    masks,
    best,
    mask: chosen,
    format: { bits: format, text: bin(format, 15), cells: formatCells(size) },
    code: { version, level, mask: chosen, size, modules: masks[chosen].modules },
  };
}

/**
 * Paints a code into a grayscale image: `scale` pixels per module and a
 * `quiet` module border. `marks` are discs in module coordinates painted
 * over it (scuffs, tape, a torn corner), `glare` a soft bright spot, and
 * `noise` per-pixel sensor noise from `rng`.
 */
export function rasterize(code, { scale = 4, quiet = 4, marks = [], glare = null, noise = 0, rng = null } = {}) {
  const n = code.size + quiet * 2;
  const width = n * scale;
  const data = new Uint8Array(width * width);
  const INK = 28;
  const PAPER = 232;
  for (let py = 0; py < width; py++) {
    const my = Math.floor(py / scale) - quiet;
    for (let px = 0; px < width; px++) {
      const mx = Math.floor(px / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.modules[my][mx];
      let v = dark ? INK : PAPER;
      // module coordinates of the pixel center, for marks and glare
      const ux = (px + 0.5) / scale - quiet;
      const uy = (py + 0.5) / scale - quiet;
      for (const mk of marks) {
        const dx = ux - mk.x;
        const dy = uy - mk.y;
        if (mk.w !== undefined ? Math.abs(dx) < mk.w / 2 && Math.abs(dy) < mk.h / 2 : dx * dx + dy * dy < mk.r * mk.r) v = mk.shade;
      }
      if (glare) {
        const dx = (ux - glare.x) / glare.r;
        const dy = (uy - glare.y) / glare.r;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) v = v + (255 - v) * glare.strength * (1 - d2);
      }
      if (noise && rng) v += (rng.next() - 0.5) * 2 * noise;
      data[py * width + px] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { width, height: width, data };
}

// ---------------------------------------------------------------- decoder

const FAIL = (reason) => ({ ok: false, reason });

/**
 * Reads an upright QR code out of a grayscale image { width, height, data }.
 * Returns { ok: true, text, version, level, mask, corrected, grid, box } or
 * { ok: false, reason }.
 */
export function decode(image) {
  const { width, height, data } = image;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < lo) lo = data[i];
    if (data[i] > hi) hi = data[i];
  }
  if (hi - lo < 60) return FAIL("no contrast");
  const threshold = (lo + hi) / 2;
  const dark = (x, y) => data[y * width + x] < threshold;

  // the code's outline: the outermost rows and columns with dark runs
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      run = dark(x, y) ? run + 1 : 0;
      if (run >= 2) {
        if (x - 1 < x0) x0 = x - 1;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return FAIL("nothing dark in view");
  const boxW = x1 - x0 + 1;
  const boxH = y1 - y0 + 1;

  // which version fits: the one whose finder and timing patterns line up
  let best = null;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const size = sizeOf(v);
    const grid = sampleGrid(dark, x0, y0, boxW / size, boxH / size, size, width, height);
    const t = template(v);
    let match = 0;
    let count = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const finder = (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
        const timing = (x === 6 || y === 6) && !finder;
        if (!finder && !timing) continue;
        count++;
        if (grid[y][x] === t.modules[y][x]) match++;
      }
    }
    const score = match / count;
    if (!best || score > best.score) best = { v, size, grid, score };
  }
  if (best.score < 0.8) return FAIL("no finder patterns");
  const { v: version, size, grid } = best;

  // format: both copies, nearest valid word by Hamming distance
  let format = null;
  const copies = formatCells(size).map((cells) => cells.reduce((acc, [x, y], i) => acc | ((grid[y][x] ? 1 : 0) << i), 0));
  for (const level of Object.keys(LEVELS)) {
    for (let mask = 0; mask < 8; mask++) {
      const want = formatBits(level, mask);
      for (const got of copies) {
        const dist = popcount(want ^ got);
        if (!format || dist < format.dist) format = { level, mask, dist };
      }
    }
  }
  if (format.dist > 3) return FAIL("unreadable format");
  const { level, mask } = format;

  const { fixed } = template(version);
  const f = MASKS[mask];
  const bits = [];
  zigzag(size, fixed, (x, y) => bits.push(grid[y][x] !== f(x, y) ? 1 : 0));
  const total = TABLE[version].total;
  const words = [];
  for (let i = 0; i < total; i++) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i * 8 + j];
    words.push(w);
  }

  const [ec, blocks, perBlock] = TABLE[version][level];
  const split = Array.from({ length: blocks }, () => []);
  let k = 0;
  for (let i = 0; i < perBlock; i++) for (const b of split) b.push(words[k++]);
  for (let i = 0; i < ec; i++) for (const b of split) b.push(words[k++]);
  // where block b's i-th codeword sits in the symbol's order
  const at = (b, i) => (i < perBlock ? i * blocks + b : perBlock * blocks + (i - perBlock) * blocks + b);
  const info = { threshold, box: { x: x0, y: y0, w: boxW, h: boxH }, version, level: LEVEL_NAMES[LEVELS[level]], mask, grid, raw: words.slice(), fixed: words.slice(), wrong: [], failedBlocks: [] };
  let corrected = 0;
  const payload = [];
  split.forEach((block, b) => {
    const before = block.slice();
    const fixedCount = rsDecode(block, ec);
    if (fixedCount < 0) {
      info.failedBlocks.push(b);
      return;
    }
    corrected += fixedCount;
    block.forEach((w, i) => {
      info.fixed[at(b, i)] = w;
      if (w !== before[i]) info.wrong.push(at(b, i));
    });
    payload.push(...block.slice(0, perBlock));
  });
  if (info.failedBlocks.length) return { ...FAIL("too damaged to correct"), info };

  const reader = bitReader(payload);
  const mode = reader(4);
  if (mode !== 0b0100) return FAIL("not byte mode");
  const length = reader(8);
  if (length > capacity(version, level)) return FAIL("bad length");
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(reader(8));
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return { ok: true, text, version, level: LEVEL_NAMES[LEVELS[level]], mask, corrected, grid, box: info.box, info: { ...info, bytes } };
}

function sampleGrid(dark, x0, y0, mw, mh, size, width, height) {
  const grid = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      // majority of a 3×3 patch around the module center
      const cx = x0 + (x + 0.5) * mw;
      const cy = y0 + (y + 0.5) * mh;
      let votes = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = Math.min(width - 1, Math.max(0, Math.floor(cx + dx * mw * 0.2)));
          const py = Math.min(height - 1, Math.max(0, Math.floor(cy + dy * mh * 0.2)));
          if (dark(px, py)) votes++;
        }
      }
      row.push(votes >= 5);
    }
    grid.push(row);
  }
  return grid;
}

function popcount(x) {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>>= 1;
  }
  return n;
}

function bitReader(bytes) {
  let pos = 0;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = bytes[pos >>> 3] ?? 0;
      v = (v << 1) | ((byte >>> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
}
