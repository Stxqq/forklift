// Reed–Solomon over GF(256) with the QR code's field polynomial
// x^8 + x^4 + x^3 + x^2 + 1 (0x11d) and generator roots α^0 … α^(n-1).
// Codewords are arrays with the highest-degree coefficient first, the way
// they sit in the symbol.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export const gfExp = (i) => EXP[((i % 255) + 255) % 255];
export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
export function gfDiv(a, b) {
  if (b === 0) throw new Error("division by zero in GF(256)");
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}
const gfInv = (a) => gfDiv(1, a);

const generators = new Map();
/** Generator polynomial of degree n, highest coefficient first (leading 1 dropped). */
export function generator(n) {
  if (generators.has(n)) return generators.get(n);
  // g(x) = (x - α^0)(x - α^1)…(x - α^(n-1)), coefficients low-first
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], EXP[i]);
      next[j + 1] ^= g[j];
    }
    g = next;
  }
  // high-first without the leading 1
  const high = g.reverse().slice(1);
  generators.set(n, high);
  return high;
}

/** The n error-correction codewords for `data`. */
export function rsEncode(data, n) {
  const g = generator(n);
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= gfMul(g[i], factor);
  }
  return rem;
}

function evalHigh(poly, x) {
  let y = 0;
  for (const c of poly) y = gfMul(y, x) ^ c;
  return y;
}
function evalLow(poly, x) {
  let y = 0;
  for (let i = poly.length - 1; i >= 0; i--) y = gfMul(y, x) ^ poly[i];
  return y;
}

/**
 * Corrects up to n/2 wrong codewords in place, where n is the number of
 * error-correction codewords at the end of `block`. Returns the number
 * corrected, or -1 if the block can't be recovered.
 */
export function rsDecode(block, n) {
  const syndromes = [];
  let clean = true;
  for (let j = 0; j < n; j++) {
    const s = evalHigh(block, EXP[j]);
    syndromes.push(s);
    if (s) clean = false;
  }
  if (clean) return 0;

  // Berlekamp–Massey: the shortest LFSR (error locator Λ, low-first)
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < n; k++) {
    let d = syndromes[k];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] ?? 0, syndromes[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfDiv(d, b);
    const T = C.slice();
    const need = B.length + m;
    while (C.length < need) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gfMul(coef, B[i]);
    if (2 * L <= k) {
      L = k + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (L * 2 > n || C.length - 1 !== L) return -1;

  // Chien search: position p (from the end) is wrong when Λ(α^-p) = 0
  const len = block.length;
  const positions = [];
  for (let p = 0; p < len; p++) {
    if (evalLow(C, gfInv(EXP[p % 255])) === 0) positions.push(p);
  }
  if (positions.length !== L) return -1;

  // Forney: Ω = S·Λ mod x^n, error value X·Ω(X⁻¹)/Λ'(X⁻¹)
  const omega = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i && j < C.length; j++) omega[i] ^= gfMul(C[j], syndromes[i - j]);
  }
  const deriv = [];
  for (let i = 1; i < C.length; i++) deriv.push(i & 1 ? C[i] : 0);
  for (const p of positions) {
    const X = EXP[p % 255];
    const xinv = gfInv(X);
    const denom = evalLow(deriv, xinv);
    if (denom === 0) return -1;
    const value = gfMul(X, gfDiv(evalLow(omega, xinv), denom));
    block[len - 1 - p] ^= value;
  }
  // a wrong guess with too many errors can still "succeed"; check it
  for (let j = 0; j < n; j++) if (evalHigh(block, EXP[j])) return -1;
  return L;
}
