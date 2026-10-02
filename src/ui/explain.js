// Two optional explainers on the stage. "Route" replays the space-time A*
// search behind a robot's latest route and shows the reservation table as
// a timeline. "Scan" opens the decoder up: camera crop, threshold, the
// finder patterns it found, the sampled grid and the bytes.

const BLUE = "37,99,235";


/** The reservation table from now on: one row per robot, a block per cell. */
export function drawTimeline(canvas, world, focus, { span = 24 } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = canvas.getBoundingClientRect();
  if (!width) return;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = 26;
  const now = world.time;
  const x = (t) => left + ((t - now) / span) * (width - left - 4);
  const rows = world.robots.length;
  const rowH = Math.min(18, (height - 16) / rows);
  ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  // seconds grid
  ctx.strokeStyle = "#ececef";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(17,17,19,.45)";
  for (let s = 0; s <= span; s += 6) {
    const px = Math.round(x(now + s)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 2);
    ctx.lineTo(px, rows * rowH + 2);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(s ? `+${s}s` : "now", px, rows * rowH + 10);
  }
  world.robots.forEach((r, i) => {
    const y = 2 + i * rowH;
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(17,17,19,.6)";
    ctx.fillText(`R${r.id + 1}`, 0, y + rowH / 2);
    if (!r.path || !r.tin || !/^to/.test(r.phase)) {
      ctx.fillStyle = "#f4f4f5";
      ctx.fillRect(x(now), y + 2, width - left - 4, rowH - 4);
      return;
    }
    for (let k = r.i; k < r.path.length; k++) {
      const last = k === r.path.length - 1;
      const a = Math.max(now, r.tin[k]);
      const b = last ? r.tin[k] + (r.dwell === Infinity ? span : r.dwell ?? 0) : Math.max(r.tout[k], r.tin[k + 1] ?? r.tout[k]);
      if (b < now || a > now + span) continue;
      const wait = !last && r.tout[k] - r.tin[k] > 0.3;
      // the robot in focus in blue, the others in ink; alternate shades per cell
      const base = r === focus ? BLUE : "17,17,19";
      ctx.fillStyle = last ? "rgba(17,17,19,.14)" : wait ? "rgba(245,158,11,.75)" : `rgba(${base},${k % 2 ? 0.85 : 0.55})`;
      const x0 = x(a);
      const x1 = Math.min(x(now + span), x(b));
      ctx.fillRect(x0, y + 3, Math.max(1, x1 - x0 - 0.5), rowH - 6);
    }
  });
}

/** Five small canvases: what the decoder did with the last image. */
export function drawPipeline(root, scan) {
  const canvases = root.querySelectorAll("canvas");
  const caps = root.querySelectorAll("figcaption");
  const { image, result } = scan;
  const info = result.info;
  const w = image.width;
  const paint = (c, f) => {
    c.width = c.height = w;
    const g = c.getContext("2d");
    const img = g.createImageData(w, w);
    for (let i = 0; i < w * w; i++) {
      const v = f(i);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return g;
  };
  paint(canvases[0], (i) => image.data[i]);
  const th = info?.threshold ?? 128;
  paint(canvases[1], (i) => (image.data[i] < th ? 17 : 255));
  caps[1].textContent = `Threshold ${Math.round(th)}`;
  const g = paint(canvases[2], (i) => (image.data[i] < th ? 17 : 255));
  if (info) {
    const { x, y, w: bw } = info.box;
    const n = info.grid.length;
    const m = bw / n;
    g.strokeStyle = `rgb(${BLUE})`;
    g.lineWidth = 2;
    for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) g.strokeRect(x + fx * m, y + fy * m, 7 * m, 7 * m);
    caps[2].textContent = `Version ${info.version}, ${n}×${n}`;
  } else caps[2].textContent = "No code found";
  const c3 = canvases[3];
  c3.width = c3.height = w;
  const g3 = c3.getContext("2d");
  g3.fillStyle = "#fff";
  g3.fillRect(0, 0, w, w);
  if (info) {
    const n = info.grid.length;
    const m = w / (n + 2);
    g3.fillStyle = "#111113";
    info.grid.forEach((row, yy) => row.forEach((on, xx) => on && g3.fillRect((xx + 1) * m, (yy + 1) * m, m, m)));
    g3.strokeStyle = "rgba(37,99,235,.25)";
    g3.lineWidth = 0.5;
    for (let k = 0; k <= n; k++) {
      g3.beginPath();
      g3.moveTo((k + 1) * m, m);
      g3.lineTo((k + 1) * m, (n + 1) * m);
      g3.moveTo(m, (k + 1) * m);
      g3.lineTo((n + 1) * m, (k + 1) * m);
      g3.stroke();
    }
    caps[3].textContent = `Level ${info.level}, mask ${info.mask}`;
  } else caps[3].textContent = "–";
  const out = root.querySelector(".pipe-bytes");
  if (result.ok) {
    const hex = info.bytes.slice(0, 12).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    out.innerHTML = `<code>${hex}${info.bytes.length > 12 ? " …" : ""}</code><b>${result.text}</b><span>${result.corrected} codeword${result.corrected === 1 ? "" : "s"} fixed of ${info.raw.length}</span>`;
  } else {
    out.innerHTML = `<b class="bad">${result.reason}</b>${info ? `<span>${info.failedBlocks.length} block${info.failedBlocks.length === 1 ? "" : "s"} past repair</span>` : ""}`;
  }
}

/** A recorded search for the stage to replay. */
export function planView(robot, now) {
  if (!robot.planTrace) return null;
  return {
    trace: robot.planTrace,
    path: robot.path,
    booked: robot.planBooked ?? [],
    started: now,
    duration: 2200,
    robot: robot.id,
    eta: robot.eta,
  };
}
