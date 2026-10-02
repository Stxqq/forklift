import { SPEC } from "../sim/robot.js";
import { SCAN_TIME } from "../sim/world.js";
import { PIPELINE, STATUS, formatPayload, parsePayload } from "../sim/orders.js";
import { Anatomy } from "../render/anatomy.js";
import { Stage, easeFactor } from "../render/stage.js";
import { Counter } from "./counter.js";
import { DispatchSession, DriveSession, ROBOT_COUNTS, SPEEDS, WatchSession } from "./sessions.js";

const $ = (selector) => document.querySelector(selector);
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const wide = matchMedia("(min-width: 1100px)");
const EASE = "cubic-bezier(.32,.72,0,1)";

const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      reveal.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -10% 0px" },
);
document.documentElement.classList.add("reveals");
document.querySelectorAll(".reveal").forEach((el) => reveal.observe(el));

const params = new URLSearchParams(location.search);
const firstSeed = Number(params.get("seed")) || 1 + Math.floor(Math.random() * 9999);

const stageEl = $("#stage");
const canvas = $("#floor");
const stage = new Stage(canvas);
const anatomy = new Anatomy($("#anatomy"));

const counters = {
  rate: new Counter($("#rate")),
  meters: new Counter($("#meters")),
  battery: new Counter($("#battery")),
  failed: new Counter($("#failed")),
};

const toast = $("#toast");
let toastTimer = 0;
function say(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

let speed = 1;
const sessions = {};
const create = {
  watch: () => new WatchSession({ seed: firstSeed, say }),
  dispatch: () => new DispatchSession({ seed: firstSeed, say }),
  drive: () => new DriveSession({ seed: firstSeed, say }),
};
let mode = null;
// handy from the console: forklift.sessions.watch.world
// and how long each frame's work took, in ms (the last 600 frames)
const perf = { work: new Float32Array(600), n: 0 };
window.forklift = { sessions, perf };

function markPill(name) {
  const links = [...document.querySelectorAll(".pill-btn")];
  for (const link of links) link.setAttribute("aria-current", String(link.dataset.mode === name));
  const active = links.find((link) => link.dataset.mode === name);
  $(".pill-ind").style.transform = `translateX(${active.offsetLeft}px)`;
}

function setMode(next) {
  if (!create[next]) next = "watch";
  if (next === mode) return;
  mode = next;
  sessions[mode] ??= create[mode]();
  sessions[mode].speed = mode === "drive" ? 1 : speed;
  stageEl.dataset.mode = mode;
  release();
  markPill(mode);
  for (const counter of Object.values(counters)) counter.value = null;
  logKey = "";
  scanShown = null;
  hideScan();
  resize();
  if (!motion.matches) {
    canvas.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 450, easing: EASE });
    const changed = [...document.querySelectorAll(".hud .card")].filter((el) => el.offsetParent);
    changed.forEach((el, i) =>
      el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: 450,
        delay: i * 40,
        easing: EASE,
        fill: "backwards",
      }),
    );
  }
}

let leaving = null;
let target = null;
async function switchMode(next) {
  target = create[next] ? next : "watch";
  markPill(target);
  if (leaving || target === mode) return;
  if (!motion.matches) {
    leaving = canvas.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-10px)" }], { duration: 220, easing: EASE, fill: "forwards" });
    await leaving.finished;
  }
  setMode(target);
  leaving?.cancel();
  leaving = null;
}

// ----------------------------------------------------------------- order

const pipeline = [...document.querySelectorAll("#pipeline li")];
const orderPkg = $("#order-pkg");
const orderRoute = $("#order-route");
const orderTitle = $("#order-title");
const orderRobot = $("#order-robot");
const orderNext = $("#order-next");
let lastOrder = null;
let orderKey = "";
let shownOrderId = null;

function showOrder(session) {
  const world = session.world;
  const robot = session.focus;
  const job = robot.job?.kind === "order" ? robot.job : null;
  if (job) lastOrder = { order: job.order, robot: robot.id, stage: robot.stage, until: world.time + 2.5 };
  const shown = job ? lastOrder : lastOrder && lastOrder.until > world.time && lastOrder.robot === robot.id ? lastOrder : null;
  const status = shown ? world.book.status(shown.order) : null;
  const stageNow = job ? robot.stage : shown ? 4 : -1;
  let doing = "";
  if (!shown) {
    doing = robot.phase === "charging" || robot.charging
      ? `Charging, ${Math.round(robot.battery * 100)} %`
      : robot.phase === "toCharge"
        ? "On the way to a charger"
        : robot.manual
          ? "Drive up to a box and lift it"
          : world.book.queued().length
            ? "Picking the next order"
            : "Parked. Click a box to order it";
  }
  const key = shown ? `${shown.order.id}:${stageNow}:${status}:${robot.waiting?.kind ?? ""}:${robot.safety}` : `none:${doing}`;
  if (key !== orderKey) {
    orderKey = key;
    const id = shown ? shown.order.id : null;
    if (id !== shownOrderId && !motion.matches) {
      for (const el of [orderPkg, orderRoute]) el.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: EASE });
    }
    shownOrderId = id;
    if (shown) {
      const o = shown.order;
      orderTitle.textContent = `Order ${o.id}`;
      orderPkg.textContent = o.pkg;
      const wait = robot.waiting?.kind === "person" ? " · waiting for a person" : robot.waiting ? ` · yielding to robot ${robot.waiting.id + 1}` : robot.safety === "stop" ? " · stopped, person ahead" : robot.safety === "slow" ? " · slowing, person nearby" : "";
      orderRoute.textContent = `Bay ${o.bay} → Dock ${o.dock || "?"}${status === "transit" ? wait : ` · ${STATUS[status].label}`}`;
    } else {
      orderTitle.textContent = "Order";
      orderPkg.textContent = "–";
      orderRoute.textContent = doing;
    }
    pipeline.forEach((li, i) => {
      li.className = "";
      if (stageNow < 0) return;
      const end = status === "missing" ? 1 : status === "wrong" || status === "manual" ? 2 : -1;
      if (end >= 0 && i === end) li.className = status === "missing" ? "bad" : "warn";
      else if (end >= 0 && i > end) li.className = "";
      else if (i < stageNow || (status === "arrived" && i <= 4)) li.className = "done";
      else if (i === stageNow) li.className = "now";
    });
    pipeline.forEach((li, i) => (li.textContent = PIPELINE[i]));
  }
  orderRobot.textContent = `Robot ${robot.id + 1}`;
  const next = world.book.queued().slice(0, 2);
  const nextHTML = next.length ? `Up next: ${next.map((o) => `<b>${o.pkg}</b> ${o.bay}→D${o.dock}`).join(", ")}` : "";
  if (orderNext.innerHTML !== nextHTML) orderNext.innerHTML = nextHTML;
  orderNext.hidden = !next.length;
}

// ------------------------------------------------------------------- log

const logEl = $("#log");
const logCard = $(".log-card");
const logEmpty = $("#log-empty");
const logNote = $("#log-note");
let logKey = "";
const clock = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
let seenOrders = new Set();

function showLog(world) {
  // as many rows as the card has room for, so none is cut in half
  const room = wide.matches ? Math.floor((logCard.clientHeight - 64) / 47) : 6;
  const rows = world.log(Math.max(3, room));
  const key = rows.map((r) => `${r.order.id}${r.status}`).join("|") + room;
  if (key === logKey) return;
  logKey = key;
  const fresh = [];
  logEl.innerHTML = "";
  for (const { order, status } of rows) {
    const li = document.createElement("li");
    const s = STATUS[status];
    const where = status === "arrived" ? `Dock ${order.dock}` : status === "missing" ? `Bay ${order.bay} empty` : status === "wrong" ? wrongNote(world, order) : status === "manual" ? `Label unreadable, bay ${order.bay}` : `${order.bay} → Dock ${order.dock || "?"}`;
    li.innerHTML = `<time>${clock(order.finished ?? order.started ?? order.created)}</time><span class="pkg">${order.pkg}<small>${where}</small></span><span class="tag" data-tone="${s.tone}">${s.label}</span>`;
    if (!seenOrders.has(`${order.id}${status}`)) {
      fresh.push(li);
      seenOrders.add(`${order.id}${status}`);
    }
    logEl.append(li);
  }
  if (!motion.matches) for (const li of fresh) li.classList.add("fresh");
  logEmpty.hidden = rows.length > 0;
  const counts = world.book.counts();
  logNote.textContent = `${counts.arrived} arrived`;
}

function wrongNote(world, order) {
  const scan = (world.book.byOrder.get(order.id) ?? []).find((e) => e.type === "scan");
  const label = scan && parsePayload(scan.text);
  const drop = (world.book.byOrder.get(order.id) ?? []).find((e) => e.type === "drop");
  if (drop && drop.dock !== order.dock && drop.pkg === order.pkg) return `Set down at dock ${drop.dock}`;
  return label ? `Found ${label.id} in ${order.bay}` : `Bay ${order.bay}`;
}

// ----------------------------------------------------------------- scan

const scanCard = $("#scan");
const scanImage = $("#scan-image");
const scanCtx = scanImage.getContext("2d");
const scanText = $("#scan-text");
const scanMeta = $("#scan-meta");
const scanAttempt = $("#scan-attempt");
let scanShown = null;
let scanRevealedAt = 0;

function hideScan() {
  scanCard.hidden = true;
}

function showScan(world, now) {
  const scan = world.lastScan;
  if (!scan) return hideScan();
  if (scan !== scanShown) {
    scanShown = scan;
    scanRevealedAt = 0;
    const { width, data } = scan.image;
    if (scanImage.width !== width) scanImage.width = scanImage.height = width;
    const img = scanCtx.createImageData(width, width);
    for (let i = 0; i < data.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = data[i];
      img.data[i * 4 + 3] = 255;
    }
    scanCtx.putImageData(img, 0, 0);
    scanAttempt.textContent = `Robot ${scan.robot + 1} · try ${scan.attempt}`;
    scanCard.dataset.state = "reading";
    scanText.textContent = "Reading…";
    scanMeta.textContent = "";
  }
  const done = scan.verdict !== null || world.time - scan.t >= SCAN_TIME;
  if (done && !scanRevealedAt) {
    scanRevealedAt = now;
    const r = scan.result;
    const label = r.ok ? parsePayload(r.text) : null;
    const verdict = scan.verdict ?? (r.ok ? "ok" : "retry");
    scanCard.dataset.state = verdict;
    if (r.ok) {
      scanText.textContent = verdict === "wrong" ? `⚠ ${label ? label.id : r.text}: wrong package` : label ? formatPayload(label) : r.text;
      scanMeta.textContent = `v${r.version}-${r.level} · mask ${r.mask} · ${r.corrected} codeword${r.corrected === 1 ? "" : "s"} fixed`;
    } else {
      scanText.textContent = verdict === "manual" ? "✗ Unreadable · check manually" : "✗ Unreadable · rescanning";
      scanMeta.textContent = r.reason;
    }
  }
  if (scanRevealedAt && now - scanRevealedAt > 1800) return hideScan();
  // next to the robot that's scanning, kept inside the view
  const robot = world.robots[scan.robot];
  const view = canvas.getBoundingClientRect();
  const p = stage.toScreen(robot.x, robot.y);
  const cw = scanCard.offsetWidth || 184;
  const ch = scanCard.offsetHeight || 230;
  const { left, bottom } = stage.insets;
  let x = p.x + 34;
  if (x + cw > view.width - 12) x = p.x - 34 - cw;
  let y = p.y - ch / 2;
  y = Math.max(12, Math.min(view.height - bottom - ch - 12, y));
  x = Math.max(left + 12, Math.min(view.width - cw - 12, x));
  scanCard.style.left = `${x}px`;
  scanCard.style.top = `${y}px`;
  scanCard.hidden = false;
}

// -------------------------------------------------------------- sensors

const lidarCanvas = $("#lidar");
const lidarCtx = lidarCanvas.getContext("2d");
const safetyEl = $("#safety");
const forkBar = $("#fork-bar");
const loadBar = $("#load-bar");
const nearBar = $("#near-bar");
const forkText = $("#fork");
const loadText = $("#load");
const nearText = $("#near");

function showSensors(robot) {
  const c = lidarCtx;
  const s = lidarCanvas.width;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, s, s);
  c.translate(s / 2, s / 2);
  const k = (s / 2 - 4) / SPEC.lidarRange;
  c.strokeStyle = "#ececef";
  c.lineWidth = 1;
  for (const r of [2, 4, 6]) {
    c.beginPath();
    c.arc(0, 0, r * k, 0, Math.PI * 2);
    c.stroke();
  }
  const n = SPEC.lidarRays;
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 - SPEC.lidarFov / 2 + (SPEC.lidarFov * i) / (n - 1);
    const d = robot.lidar[i] * k;
    if (i === 0) c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  c.closePath();
  c.fillStyle = robot.safety === "stop" ? "rgba(239,68,68,.18)" : robot.safety === "slow" ? "rgba(245,158,11,.18)" : "rgba(37,99,235,.1)";
  c.fill();
  c.fillStyle = "#111113";
  for (let i = 0; i < n; i++) {
    if (robot.lidar[i] >= SPEC.lidarRange - 0.01) continue;
    const a = -Math.PI / 2 - SPEC.lidarFov / 2 + (SPEC.lidarFov * i) / (n - 1);
    const d = robot.lidar[i] * k;
    c.fillRect(Math.cos(a) * d - 1.5, Math.sin(a) * d - 1.5, 3, 3);
  }
  c.fillStyle = "#111113";
  c.fillRect(-5, -7, 10, 14);
  const near = Math.min(...robot.lidar);
  forkBar.style.transform = `scaleX(${(robot.fork.height / SPEC.maxFork).toFixed(3)})`;
  forkText.textContent = `${robot.fork.height.toFixed(2)} m`;
  const kg = robot.load ? robot.load.kg : 0;
  loadBar.style.transform = `scaleX(${(kg / SPEC.payload).toFixed(3)})`;
  loadText.textContent = `${kg.toFixed(1)} kg`;
  nearBar.style.transform = `scaleX(${(1 - near / SPEC.lidarRange).toFixed(3)})`;
  nearText.textContent = `${near.toFixed(1)} m`;
  safetyEl.textContent = robot.safety === "stop" ? "safety stop" : robot.safety === "slow" ? "slowing" : "clear";
  safetyEl.dataset.state = robot.safety;
}

// ---------------------------------------------------------------- frame

let anatomyVisible = false;
new IntersectionObserver(([entry]) => (anatomyVisible = entry.isIntersecting)).observe($("#anatomy"));
const caption = $("#caption-sub");

let last = performance.now();
let raf = 0;
function frame(now) {
  const started = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const session = sessions[mode];
  if (mode === "drive") applyControls(session.focus);
  session.advance(dt, 10);
  const world = session.world;
  const focus = session.focus;
  stage.draw(world, focus, { time: now / 1000, alpha: session.alpha });
  showOrder(session);
  showLog(world);
  showScan(world, now);
  showSensors(focus);
  const k = motion.matches ? 1 : easeFactor(0.12, dt);
  if (anatomyVisible) anatomy.update(focus, k);

  const arrived = world.book.counts().arrived;
  counters.rate.set(world.time > 60 ? (arrived * 3600) / world.time : 0);
  counters.meters.set(world.robots.reduce((m, r) => m + r.meters, 0));
  counters.battery.set(focus.battery * 100);
  counters.failed.set(world.stats.failedScans);
  $("#failed-of").textContent = `/ ${world.stats.scans}`;
  for (const counter of Object.values(counters)) counter.tick(k);
  const robots = world.robots.length;
  const text = `Seed ${world.seed} · ${robots} robot${robots > 1 ? "s" : ""} · ${world.workers.length} people on foot · ${clock(world.time)}`;
  if (caption.textContent !== text) caption.textContent = text;
  stageEl.dataset.ready = "";
  perf.work[perf.n++ % perf.work.length] = performance.now() - started;
  raf = requestAnimationFrame(frame);
}

function resize() {
  const row = $("#hud-row");
  const insets = wide.matches
    ? { left: 304 + 20, right: 0, top: 0, bottom: row.offsetHeight + 28 }
    : { left: 0, right: 0, top: 0, bottom: mode === "drive" && matchMedia("(max-width: 680px)").matches ? 84 : 0 };
  stage.resize(insets);
}
new ResizeObserver(() => resize()).observe(canvas);
new ResizeObserver(() => resize()).observe($("#hud-row"));

stage.reducedMotion = motion.matches;
motion.addEventListener("change", () => (stage.reducedMotion = motion.matches));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
    release();
  } else if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
});

// ------------------------------------------------------------- controls

const speedsEl = $("#speeds");
for (const s of SPEEDS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = `${s}x`;
  chip.setAttribute("aria-pressed", String(s === 1));
  chip.addEventListener("click", () => {
    speed = s;
    for (const name of ["watch", "dispatch"]) if (sessions[name]) sessions[name].speed = s;
    for (const other of speedsEl.children) other.setAttribute("aria-pressed", String(other === chip));
  });
  speedsEl.append(chip);
}
const robotsEl = $("#robots");
for (const n of ROBOT_COUNTS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = String(n);
  chip.setAttribute("aria-pressed", String(n === 3));
  chip.addEventListener("click", () => {
    sessions.dispatch.setRobots(n);
    sessions.dispatch.speed = speed;
    logKey = "";
    say(`${n} robots, same warehouse`);
    for (const other of robotsEl.children) other.setAttribute("aria-pressed", String(other === chip));
  });
  robotsEl.append(chip);
}
$("#new-floor").addEventListener("click", () => {
  const session = sessions[mode];
  session.reset(1 + Math.floor(Math.random() * 9999));
  session.speed = mode === "drive" ? 1 : speed;
  logKey = "";
  lastOrder = null;
  say(`New warehouse, seed ${session.world.seed}`);
});

function pointer(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
canvas.addEventListener("pointermove", (event) => {
  if (mode !== "dispatch") return;
  const p = pointer(event);
  const cell = stage.cellAt(p.x, p.y);
  const bay = sessions.dispatch.world.warehouse.bayAt.get(cell);
  stage.hover = bay ? cell : -1;
  canvas.style.cursor = bay || robotAt(p) ? "pointer" : "";
});
canvas.addEventListener("pointerleave", () => (stage.hover = -1));
function robotAt(p) {
  const world = sessions[mode].world;
  return world.robots.find((r) => {
    const s = stage.toScreen(r.x, r.y);
    return Math.hypot(s.x - p.x, s.y - p.y) < Math.max(14, stage.scale * 0.5);
  });
}
canvas.addEventListener("click", (event) => {
  if (mode !== "dispatch") return;
  const p = pointer(event);
  const session = sessions.dispatch;
  const robot = robotAt(p);
  if (robot) {
    session.focusId = robot.id;
    lastOrder = null;
    say(`Following robot ${robot.id + 1}`);
    return;
  }
  const bay = session.world.warehouse.bayAt.get(stage.cellAt(p.x, p.y));
  if (bay) session.order(bay);
});

// keyboard and touch for Drive
const held = { forward: false, back: false, left: false, right: false };
const KEYS = { ArrowUp: "forward", KeyW: "forward", ArrowDown: "back", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
function release() {
  for (const k of Object.keys(held)) held[k] = false;
  document.querySelectorAll(".touch .down").forEach((b) => b.classList.remove("down"));
}
function applyControls(robot) {
  robot.manual.throttle = (held.forward ? 1 : 0) - (held.back ? 1 : 0);
  robot.manual.turn = (held.right ? 1 : 0) - (held.left ? 1 : 0);
}
function action(name) {
  const session = sessions.drive;
  if (name === "fork") session.world.forkCommand(session.focus);
  else session.world.scanCommand(session.focus);
  session.advance(0);
}
addEventListener("keydown", (event) => {
  if (mode !== "drive" || event.metaKey || event.ctrlKey || event.altKey) return;
  const control = KEYS[event.code];
  if (control) {
    if (document.activeElement?.closest(".pill")) document.activeElement.blur();
    held[control] = true;
    event.preventDefault();
  } else if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) action("fork");
  } else if (event.code === "KeyS" && !event.repeat) {
    action("scan");
  }
});
addEventListener("keyup", (event) => {
  const control = KEYS[event.code];
  if (control) held[control] = false;
});
addEventListener("blur", release);
for (const button of document.querySelectorAll("[data-control]")) {
  const control = button.dataset.control;
  const up = () => {
    button.classList.remove("down");
    held[control] = false;
  };
  button.addEventListener("pointerdown", (event) => {
    button.setPointerCapture(event.pointerId);
    button.classList.add("down");
    held[control] = true;
  });
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}
for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => action(button.dataset.action));
}

// ---------------------------------------------------------------- facts

fetch("scripts/results.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((res) => {
    if (!res) return;
    const fact = (name, text) => document.querySelectorAll(`[data-fact="${name}"]`).forEach((el) => (el.textContent = text));
    fact("seeds", String(res.seeds.length));
    fact("solo", `${res.solo.perHour.toFixed(0)} packages an hour`);
    fact("fleet", `${res.fleet.perHour.toFixed(0)} an hour, ${(res.fleet.perHour / res.solo.perHour).toFixed(1)}x`);
    fact("first", `${(res.firstTry * 100).toFixed(0)} %`);
    fact("corrected", `${res.corrected} in ${res.scans} scans`);
    fact("closest", res.closest >= 0.999 ? "never" : `${res.closest.toFixed(2)} m`);
  })
  .catch(() => {});

addEventListener("hashchange", () => switchMode(location.hash.slice(1)));
setMode(location.hash.slice(1));
resize();
raf = requestAnimationFrame(frame);
