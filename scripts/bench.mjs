// Headless runs behind the numbers on the page: one robot in Watch, and
// four robots with a queue that never runs dry, half an hour each, with
// cooperative routing and with simple routing (quickest way across an
// empty floor, first come first served) for comparison.
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

function run(seed, robots, routing) {
  const mode = robots === 1 ? "watch" : "dispatch";
  const world = new World({ seed, robots, mode, routing });
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
  return { seed, robots, routing, counts, trip, perHour: (counts.arrived * 60) / minutes, first, tried, scans: world.stats.scans, corrected: world.stats.corrected, closest };
}

const pad = (v, n) => String(v).padStart(n);
console.log("routing      seed robots arrived missing wrong manual  per h  trip s  scans fixed  closest");
const rows = [];
for (const routing of ["simple", "cooperative"]) {
  for (const robots of [1, 4]) {
    for (const seed of seeds) {
      const r = run(seed, robots, routing);
      rows.push(r);
      const c = r.counts;
      console.log(`${routing.padEnd(11)} ${pad(seed, 5)} ${pad(robots, 6)} ${pad(c.arrived, 7)} ${pad(c.missing, 7)} ${pad(c.wrong, 5)} ${pad(c.manual, 6)} ${pad(r.perHour.toFixed(0), 6)} ${pad(r.trip.toFixed(1), 7)} ${pad(r.scans, 6)} ${pad(r.corrected, 5)} ${pad(robots > 1 ? r.closest.toFixed(2) : "–", 8)}`);
    }
  }
}
const mean = (list, f) => list.reduce((s, r) => s + f(r), 0) / list.length;
const pick = (routing, robots) => rows.filter((r) => r.routing === routing && r.robots === robots);
const summary = (list) => ({
  perHour: mean(list, (r) => r.perHour),
  trip: mean(list, (r) => r.trip),
  missing: list.reduce((s, r) => s + r.counts.missing, 0),
  wrong: list.reduce((s, r) => s + r.counts.wrong, 0),
  manual: list.reduce((s, r) => s + r.counts.manual, 0),
});
const coop = rows.filter((r) => r.routing === "cooperative");
const results = {
  seeds,
  minutes,
  solo: { cooperative: summary(pick("cooperative", 1)), simple: summary(pick("simple", 1)) },
  fleet: { cooperative: summary(pick("cooperative", 4)), simple: summary(pick("simple", 4)) },
  firstTry: coop.reduce((s, r) => s + r.first, 0) / coop.reduce((s, r) => s + r.tried, 0),
  scans: coop.reduce((s, r) => s + r.scans, 0),
  corrected: coop.reduce((s, r) => s + r.corrected, 0),
  closest: Math.min(...rows.filter((r) => r.robots > 1).map((r) => r.closest)),
};
for (const [name, k] of [["one robot", "solo"], ["four robots", "fleet"]]) {
  const c = results[k].cooperative;
  const s0 = results[k].simple;
  console.log(`${name}: ${c.perHour.toFixed(1)}/h, trip ${c.trip.toFixed(1)} s (simple routing ${s0.perHour.toFixed(1)}/h, ${s0.trip.toFixed(1)} s)`);
}
console.log(`first-try reads ${(results.firstTry * 100).toFixed(1)} %, closest ${results.closest.toFixed(2)} m`);
if (args.includes("--write")) {
  writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
  console.log("wrote scripts/results.json");
}
