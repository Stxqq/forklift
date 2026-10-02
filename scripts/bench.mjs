// Headless runs behind the numbers on the page: one robot in Watch, and
// four robots with a queue that never runs dry, half an hour each.
//   node scripts/bench.mjs [--seeds 8] [--minutes 30] [--write]
import { writeFileSync } from "node:fs";
import { World } from "../src/sim/world.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const seedCount = opt("seeds", 8);
const minutes = opt("minutes", 30);
const steps = minutes * 60 * 60;
const seeds = Array.from({ length: seedCount }, (_, i) => 101 + i);

function run(seed, robots) {
  const mode = robots === 1 ? "watch" : "dispatch";
  const world = new World({ seed, robots, mode });
  let closest = Infinity;
  for (let s = 0; s < steps; s++) {
    if (mode === "dispatch" && world.book.queued().length < robots) {
      const options = world.warehouse.bays.filter((b) => world.orderable(b));
      if (options.length) world.orderFor(options[world.rng.orders.int(options.length)], "auto");
    }
    world.step();
    for (let i = 0; i < world.robots.length; i++) {
      for (let j = i + 1; j < world.robots.length; j++) {
        const a = world.robots[i];
        const b = world.robots[j];
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
  }
  const counts = world.book.counts();
  let first = 0;
  let tried = 0;
  for (const o of world.book.orders) {
    const reads = world.book.byOrder.get(o.id).filter((e) => e.type === "scan" || e.type === "unreadable");
    if (!reads.length) continue;
    tried++;
    if (reads[0].type === "scan") first++;
  }
  // a trip: from the robot taking the order to the box arriving at its dock
  const trips = world.book.orders.filter((o) => world.book.status(o) === "arrived").map((o) => o.finished - o.started);
  const trip = trips.reduce((a, b) => a + b, 0) / Math.max(1, trips.length);
  return { seed, robots, counts, trip, perHour: (counts.arrived * 60) / minutes, first, tried, scans: world.stats.scans, corrected: world.stats.corrected, closest };
}

const pad = (v, n) => String(v).padStart(n);
console.log(" seed robots arrived missing wrong manual  per h  trip s  scans fixed  closest");
const rows = [];
for (const robots of [1, 4]) {
  for (const seed of seeds) {
    const r = run(seed, robots);
    rows.push(r);
    const c = r.counts;
    console.log(`${pad(seed, 5)} ${pad(robots, 6)} ${pad(c.arrived, 7)} ${pad(c.missing, 7)} ${pad(c.wrong, 5)} ${pad(c.manual, 6)} ${pad(r.perHour.toFixed(0), 6)} ${pad(r.trip.toFixed(1), 7)} ${pad(r.scans, 6)} ${pad(r.corrected, 5)} ${pad(robots > 1 ? r.closest.toFixed(2) : "–", 8)}`);
  }
}
const mean = (list, f) => list.reduce((s, r) => s + f(r), 0) / list.length;
const solo = rows.filter((r) => r.robots === 1);
const fleet = rows.filter((r) => r.robots === 4);
const results = {
  seeds,
  minutes,
  solo: { perHour: mean(solo, (r) => r.perHour), trip: mean(solo, (r) => r.trip) },
  fleet: { perHour: mean(fleet, (r) => r.perHour), trip: mean(fleet, (r) => r.trip) },
  firstTry: rows.reduce((s, r) => s + r.first, 0) / rows.reduce((s, r) => s + r.tried, 0),
  scans: rows.reduce((s, r) => s + r.scans, 0),
  corrected: rows.reduce((s, r) => s + r.corrected, 0),
  closest: Math.min(...fleet.map((r) => r.closest)),
};
console.log(`one robot ${results.solo.perHour.toFixed(1)}/h (trip ${results.solo.trip.toFixed(1)} s), four ${results.fleet.perHour.toFixed(1)}/h (trip ${results.fleet.trip.toFixed(1)} s), first-try reads ${(results.firstTry * 100).toFixed(1)} %, closest ${results.closest.toFixed(2)} m`);
if (args.includes("--write")) {
  writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
  console.log("wrote scripts/results.json");
}
