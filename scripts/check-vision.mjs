// Cross-checks the encoder against a decoder it shares no code with:
// Apple's Vision framework (VNDetectBarcodesRequest), driven from a small
// Swift script. macOS only, not part of npm test.
//   node scripts/check-vision.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, rasterize } from "../src/sim/qr.js";
import { grayPng } from "./png.mjs";

const texts = ["PKG-00421 B3 D2", "A", "forklift", "PKG-99999 H16 D4", "Dock 2", "https://stxqq.github.io/forklift/"];
const dir = mkdtempSync(join(tmpdir(), "qr-check-"));
const cases = [];
for (const level of ["L", "M", "Q", "H"]) {
  for (const text of texts) {
    let code;
    try { code = encode(text, { level }); } catch { continue; }
    const file = join(dir, `${cases.length}.png`);
    writeFileSync(file, grayPng(rasterize(code, { scale: 8, quiet: 4 })));
    cases.push({ text, level, code, file });
  }
}
const swift = join(dir, "read.swift");
writeFileSync(swift, `
import Foundation
import Vision
for path in CommandLine.arguments.dropFirst() {
  let request = VNDetectBarcodesRequest()
  request.symbologies = [.qr]
  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path))
  try? handler.perform([request])
  let text = (request.results?.first)?.payloadStringValue ?? ""
  let data = try! JSONSerialization.data(withJSONObject: [text])
  print(String(data: data, encoding: .utf8)!)
}
`);
const lines = execFileSync("swift", [swift, ...cases.map((c) => c.file)], { encoding: "utf8" }).trim().split("\n");
let ok = 0;
cases.forEach((c, i) => {
  const got = JSON.parse(lines[i])[0];
  const pass = got === c.text;
  if (pass) ok++;
  console.log(`${pass ? "ok  " : "FAIL"}  v${c.code.version}-${c.level} mask ${c.code.mask}  ${JSON.stringify(c.text)}${pass ? "" : ` -> ${JSON.stringify(got)}`}`);
});
console.log(`${ok}/${cases.length} read back by Apple Vision`);
rmSync(dir, { recursive: true, force: true });
process.exit(ok === cases.length ? 0 : 1);
