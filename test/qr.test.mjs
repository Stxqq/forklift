import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/sim/rng.js";
import { rsDecode, rsEncode } from "../src/sim/rs.js";
import { capacity, dataModules, decode, encode, formatBits, rasterize } from "../src/sim/qr.js";

// "HELLO WORLD" as version 1-Q, from the worked example at thonky.com's
// QR code tutorial (ISO/IEC 18004 notation): 13 data codewords and the 13
// error-correction codewords the standard gives for them.
test("Reed–Solomon matches the published 1-Q example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
  assert.deepEqual(rsEncode(data, 13), [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
});

test("format information matches the standard's table", () => {
  // ISO/IEC 18004 Table C.1
  assert.equal(formatBits("L", 0).toString(2).padStart(15, "0"), "111011111000100");
  assert.equal(formatBits("L", 4).toString(2).padStart(15, "0"), "110011000101111");
  assert.equal(formatBits("M", 5).toString(2).padStart(15, "0"), "100000011001110");
  assert.equal(formatBits("H", 7).toString(2).padStart(15, "0"), "000100000111011");
});

test("Reed–Solomon corrects up to half its parity, and refuses more", () => {
  const rng = new Rng(3);
  for (let trial = 0; trial < 200; trial++) {
    const n = [10, 16, 18, 26][trial % 4];
    const data = Array.from({ length: 20 }, () => rng.int(256));
    const clean = [...data, ...rsEncode(data, n)];
    const block = clean.slice();
    const errors = 1 + rng.int(n / 2);
    const spots = new Set();
    while (spots.size < errors) spots.add(rng.int(block.length));
    for (const i of spots) block[i] ^= 1 + rng.int(255);
    assert.equal(rsDecode(block, n), errors);
    assert.deepEqual(block, clean);
  }
  // one past the limit: either refused or, rarely, a wrong word is found;
  // it must never come back as the original with a success count
  let refused = 0;
  for (let trial = 0; trial < 100; trial++) {
    const n = 16;
    const data = Array.from({ length: 20 }, () => rng.int(256));
    const clean = [...data, ...rsEncode(data, n)];
    const block = clean.slice();
    for (let i = 0; i < n / 2 + 1; i++) block[i * 3] ^= 1 + rng.int(255);
    if (rsDecode(block, n) < 0) refused++;
  }
  assert.ok(refused > 95, `${refused} of 100 refused`);
});

test("every version and level round-trips through pixels", () => {
  for (let version = 1; version <= 4; version++) {
    for (const level of ["L", "M", "Q", "H"]) {
      const max = capacity(version, level);
      const text = "PKG-00421 B3 D2 forklift scanner test 0123456789abcdefghijklmnopqrstuvwxyz".repeat(2).slice(0, max);
      const code = encode(text, { level, version });
      assert.equal(code.size, 17 + 4 * version);
      for (const scale of [2, 3, 5]) {
        const got = decode(rasterize(code, { scale, quiet: 4 }));
        assert.ok(got.ok, `v${version}-${level} at scale ${scale}: ${got.reason}`);
        assert.equal(got.text, text);
        assert.equal(got.version, version);
        assert.equal(got.level, level);
        assert.equal(got.mask, code.mask);
        assert.equal(got.corrected, 0);
      }
    }
  }
});

test("each of the eight masks decodes", () => {
  for (let mask = 0; mask < 8; mask++) {
    const code = encode("PKG-00421 B3 D2", { level: "M", mask });
    const got = decode(rasterize(code));
    assert.equal(got.mask, mask);
    assert.equal(got.text, "PKG-00421 B3 D2");
  }
});

test("damaged modules within the error-correction limit are corrected", () => {
  const rng = new Rng(11);
  const text = "PKG-00421 B3 D2";
  for (let trial = 0; trial < 60; trial++) {
    const code = encode(text, { level: "M" }); // version 2-M: 16 parity, fixes 8 codewords
    const modules = dataModules(code.version);
    const limit = 8;
    // flip modules in up to `limit` distinct codewords
    const words = new Set();
    const target = 1 + rng.int(limit);
    while (words.size < target) words.add(rng.int(44));
    let flipped = 0;
    for (const w of words) {
      // distinct bits, so no flip undoes another
      const bits = new Set();
      const count = 1 + rng.int(8);
      while (bits.size < count) bits.add(rng.int(8));
      for (const b of bits) {
        const [x, y] = modules[w * 8 + b];
        code.modules[y][x] = !code.modules[y][x];
        flipped++;
      }
    }
    const got = decode(rasterize(code, { noise: 25, rng }));
    assert.ok(got.ok, `trial ${trial}: ${got.reason}`);
    assert.equal(got.text, text);
    assert.ok(got.corrected >= 1 && got.corrected <= target, `${got.corrected} corrected for ${target} hit codewords (${flipped} modules)`);
  }
});

test("too much damage fails instead of reading something wrong", () => {
  const text = "PKG-00421 B3 D2";
  const code = encode(text, { level: "M" });
  const modules = dataModules(code.version);
  // 12 codewords fully inverted: past the 8 that version 2-M can fix
  for (let w = 0; w < 12; w++) {
    for (let b = 0; b < 8; b++) {
      const [x, y] = modules[(w * 3) * 8 + b];
      code.modules[y][x] = !code.modules[y][x];
    }
  }
  const got = decode(rasterize(code));
  assert.equal(got.ok, false);
});

test("a smudged label reads, a torn one doesn't", () => {
  const code = encode("PKG-00421 B3 D2", { level: "M" });
  const smudged = decode(rasterize(code, { marks: [{ x: 14, y: 13, r: 1.1, shade: 40 }, { x: 19, y: 20, r: 1, shade: 225 }] }));
  assert.ok(smudged.ok);
  assert.ok(smudged.corrected > 0);
  const torn = decode(rasterize(code, { marks: [{ x: 17, y: 15.5, w: 12.5, h: 12.5, shade: 214 }] }));
  assert.equal(torn.ok, false);
});

test("glare and sensor noise", () => {
  const code = encode("PKG-00421 B3 D2", { level: "M" });
  const soft = decode(rasterize(code, { glare: { x: 12, y: 12, r: 6, strength: 0.35 }, noise: 20, rng: new Rng(1) }));
  assert.equal(soft.text, "PKG-00421 B3 D2");
  const blank = decode({ width: 40, height: 40, data: new Uint8Array(1600).fill(230) });
  assert.equal(blank.ok, false);
});
