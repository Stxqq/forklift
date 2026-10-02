import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { Rng } from "../src/sim/rng.js";
import { dataModules, decode, encode, explain, formatBits, rasterize } from "../src/sim/qr.js";
import { labelPNG, labelSVG, printable } from "../src/lab/export.js";
import { scanLab } from "../src/ui/lab.js";

const TEXT = "PKG-00421 · Bay B3 · Dock 2";

test("a lab code round-trips at every level, and matches the encoder", () => {
  for (const level of ["L", "M", "Q", "H"]) {
    for (const text of [TEXT, "A", "forklift", "https://stxqq.github.io/forklift/"]) {
      let e;
      try {
        e = explain(text, { level });
      } catch {
        continue;
      }
      assert.deepEqual(e.code.modules, encode(text, { level }).modules);
      const got = decode(rasterize(e.code));
      assert.equal(got.text, text, `${level}: ${text}`);
      assert.equal(got.level, level);
    }
  }
});

test("the build steps add up: bits, blocks, masks and format", () => {
  const e = explain(TEXT, { level: "M" });
  const bits = e.segments.reduce((n, s) => n + s.bits.length, 0);
  assert.equal(bits, e.dataWords.length * 8);
  assert.equal(e.segments[0].bits, "0100");
  assert.equal(parseInt(e.segments[1].bits, 2), new TextEncoder().encode(TEXT).length);
  assert.equal(e.words.length, e.blocks.reduce((n, b) => n + b.data.length + b.ec.length, 0));
  assert.equal(e.best, e.masks.reduce((a, b) => (b.penalty < a.penalty ? b : a)).mask);
  assert.equal(e.format.bits, formatBits("M", e.mask));
  assert.equal(e.order.length, dataModules(e.version).length);
  for (const row of e.roles) for (const r of row) assert.ok(r === null || ["finder", "separator", "timing", "alignment", "format", "dark"].includes(r));
});

test("a forced mask still decodes, with that mask", () => {
  for (let mask = 0; mask < 8; mask++) {
    const e = explain(TEXT, { level: "Q", mask });
    assert.equal(e.mask, mask);
    const got = decode(rasterize(e.code));
    assert.equal(got.mask, mask);
    assert.equal(got.text, TEXT);
  }
});

function scratch(e, words, rng) {
  const modules = e.code.modules.map((row) => row.slice());
  const order = e.order;
  for (const w of words) {
    // flip a few distinct bits of that codeword
    const bits = new Set();
    const n = 1 + rng.int(8);
    while (bits.size < n) bits.add(rng.int(8));
    for (const b of bits) {
      const [x, y] = order[w * 8 + b];
      modules[y][x] = !modules[y][x];
    }
  }
  return { ...e.code, modules };
}

test("the damage test counts exactly what the decoder corrected", () => {
  const rng = new Rng(9);
  for (const level of ["L", "M", "Q", "H"]) {
    const e = explain(TEXT, { level });
    const limit = Math.floor(e.ecPerBlock / 2);
    for (let trial = 0; trial < 12; trial++) {
      // only one block at L and M here; keep the damage inside the limit
      const blockCount = e.blocks.length;
      const words = new Set();
      const want = 1 + rng.int(limit);
      // codewords of block 0 only, so the per-block limit holds
      while (words.size < want) words.add(rng.int(e.words.length / blockCount) * blockCount);
      const res = scanLab(e, scratch(e, [...words], rng));
      assert.ok(res.ok, `${level} trial ${trial}: ${res.reason}`);
      assert.equal(res.corrected, want);
      assert.deepEqual([...res.wrong].sort((a, b) => a - b), [...words].sort((a, b) => a - b));
      assert.deepEqual([...res.fixed].sort((a, b) => a - b), [...words].sort((a, b) => a - b));
    }
  }
  // past the limit: it says so, and counts the wrong codewords it saw
  const e = explain(TEXT, { level: "M" });
  const limit = Math.floor(e.ecPerBlock / 2);
  const words = Array.from({ length: limit + 3 }, (_, i) => 30 + i * 2);
  const res = scanLab(e, scratch(e, words, new Rng(2)));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "too damaged to correct");
  assert.equal(res.wrong.size, words.length);
  assert.equal(res.fixed.size, 0);
});

function readPNG(bytes) {
  const buf = Buffer.from(bytes);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) gray.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  return { width, height, data: gray };
}

test("the PNG download decodes", () => {
  for (const level of ["L", "H"]) {
    const e = explain(TEXT, { level });
    const { png } = labelPNG(e.code, e.text);
    const img = readPNG(png);
    assert.ok(img.height > img.width, "has the caption under it");
    const square = { width: img.width, height: img.width, data: img.data.subarray(0, img.width * img.width) };
    assert.equal(decode(square).text, TEXT);
  }
  assert.equal(printable("Bay b3 · ä"), "BAY B3 · ?");
});

test("the SVG download decodes", () => {
  const e = explain(TEXT, { level: "Q" });
  const svg = labelSVG(e.code, e.text);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(svg.includes("PKG-00421 · Bay B3 · Dock 2"));
  // read the module squares back out of the path and decode them
  const d = /<path d="([^"]+)"/.exec(svg)[1];
  const unit = 10;
  const size = e.code.size;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h/g)) modules[y / unit - 4][x / unit - 4] = true;
  assert.equal(decode(rasterize({ size, modules })).text, TEXT);
});
