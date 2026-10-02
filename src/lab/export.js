// Printable labels from the lab: a crisp SVG and a PNG written byte by
// byte (no canvas), both with the quiet zone the standard asks for and
// the text printed under the code. Pure functions, so the tests can read
// the files back with the decoder.

const QUIET = 4;

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/** An SVG label: one path for all dark modules, the caption underneath. */
export function labelSVG(code, caption = "", { module = 10 } = {}) {
  const n = code.size + QUIET * 2;
  const side = n * module;
  const textH = caption ? module * 4 : 0;
  let d = "";
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) d += `M${(x + QUIET) * module} ${(y + QUIET) * module}h${module}v${module}h-${module}z`;
    }
  }
  const text = caption
    ? `<text x="${side / 2}" y="${side + textH * 0.35}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${module * 1.8}" font-weight="600" fill="#111113">${escapeXml(caption)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side + textH}" viewBox="0 0 ${side} ${side + textH}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111113"/>${text}</svg>`;
}

// 5×7 pixel font, the kind a label printer uses
const FONT = {
  " ": "00000000000000000000000000000000000",
  "-": "00000000000000011111000000000000000",
  ".": "00000000000000000000000000110001100",
  "·": "00000000000000001100011000000000000",
  ":": "00000011000110000000011000110000000",
  "/": "00001000010001000100010001000010000",
  "#": "01010010101111101010111110101001010",
  "?": "01110100010000100010001000000000100",
  "!": "00100001000010000100001000000000100",
  "(": "00010001000100001000010000010000010",
  ")": "01000001000001000010000100010001000",
  "+": "00000001000010011111001000010000000",
  _: "00000000000000000000000000000011111",
  0: "01110100011001110101110011000101110",
  1: "00100011000010000100001000010001110",
  2: "01110100010000100010001000100011111",
  3: "11111000100010000010000011000101110",
  4: "00010001100101010010111110001000010",
  5: "11111100001111000001000011000101110",
  6: "00110010001000011110100011000101110",
  7: "11111000010001000100010000100001000",
  8: "01110100011000101110100011000101110",
  9: "01110100011000101111000010001001100",
  A: "01110100011000110001111111000110001",
  B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110",
  D: "11100100101000110001100011001011100",
  E: "11111100001000011110100001000011111",
  F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111",
  H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110",
  J: "00111000100001000010000101001001100",
  K: "10001100101010011000101001001010001",
  L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001",
  N: "10001100011100110101100111000110001",
  O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101",
  R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110",
  T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011010101010",
  X: "10001100010101000100010101000110001",
  Y: "10001100011000101010001000010000100",
  Z: "11111000010001000100010001000011111",
};

/** The caption as the PNG prints it: what the 5×7 font can show. */
export const printable = (s) => [...s.toUpperCase()].map((c) => (FONT[c] ? c : "?")).join("");

/**
 * A grayscale PNG of the label: `scale` pixels per module, the caption in
 * a pixel font underneath, wrapped to the code's width.
 */
export function labelPNG(code, caption = "", { scale = 8 } = {}) {
  const n = code.size + QUIET * 2;
  const width = n * scale;
  const glyph = Math.max(2, Math.round(scale / 3)); // font pixel size
  const perLine = Math.max(1, Math.floor((width - glyph * 4) / (glyph * 6)));
  const text = printable(caption);
  // wrap at spaces where it can
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine) line = next;
    else {
      if (line) lines.push(line);
      for (line = word; line.length > perLine; line = line.slice(perLine)) lines.push(line.slice(0, perLine));
    }
  }
  if (line) lines.push(line);
  const lineH = glyph * 9;
  const height = width + (lines.length ? lines.length * lineH + glyph * 3 : 0);
  const px = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + QUIET) * scale + dy) * width + (x + QUIET) * scale;
        px.fill(17, row, row + scale);
      }
    }
  }
  lines.forEach((line, li) => {
    const top = width + li * lineH;
    const left = Math.round((width - line.length * glyph * 6 + glyph) / 2);
    [...line].forEach((c, ci) => {
      const bits = FONT[c];
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (bits[gy * 5 + gx] !== "1") continue;
          for (let dy = 0; dy < glyph; dy++) {
            const row = (top + gy * glyph + dy) * width + left + (ci * 6 + gx) * glyph;
            px.fill(17, row, row + glyph);
          }
        }
      }
    });
  });
  return { width, height, data: px, png: encodePNG(width, height, px) };
}

// ------------------------------------------------------------ PNG bytes

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Grayscale 8-bit PNG, zlib "stored" blocks: no compression library needed. */
export function encodePNG(width, height, gray) {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  // zlib wrapper around stored deflate blocks of at most 65535 bytes
  const blocks = Math.ceil(raw.length / 65535) || 1;
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  z[o++] = 0x78;
  z[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const len = Math.min(65535, raw.length - i * 65535);
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >>> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(i * 65535, i * 65535 + len), o);
    o += len;
  }
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  z[o++] = b >>> 8;
  z[o++] = b & 0xff;
  z[o++] = a >>> 8;
  z[o++] = a & 0xff;

  const chunks = [];
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", new Uint8Array(0));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(8 + chunks.reduce((s, c) => s + c.length, 0));
  out.set(sig, 0);
  let p = 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
