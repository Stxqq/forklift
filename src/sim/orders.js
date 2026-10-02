// Orders and the delivery log. The log never takes a robot's word for
// anything: each order's status is worked out from what the sensors
// recorded (what the fork found in the bay, what the scanner decoded, what
// was set down at which dock), set against what the order asked for.

export const STATUS = {
  queued: { label: "Queued", tone: "idle" },
  transit: { label: "In transit", tone: "busy" },
  arrived: { label: "Arrived ✓", tone: "ok" },
  missing: { label: "Missing ✗", tone: "bad" },
  wrong: { label: "Wrong package ⚠", tone: "warn" },
  manual: { label: "Check manually", tone: "warn" },
};

export const PIPELINE = ["Drive", "Pick up", "Scan", "Deliver", "Confirmed"];

/** "PKG-00421 B3 D2" → { id, bay, dock }, or null if it isn't one of ours. */
export function parsePayload(text) {
  const m = /^(PKG-\d{5}) ([A-H]\d{1,2}) D(\d)$/.exec(text ?? "");
  return m ? { id: m[1], bay: m[2], dock: Number(m[3]) } : null;
}

export const formatPayload = (p) => `${p.id} · Bay ${p.bay} · Dock ${p.dock}`;

/**
 * Status of one order from its events alone. Event types:
 *   empty       the fork reached into the bay and found nothing
 *   scan        a label was decoded: { text }
 *   unreadable  a scan attempt failed
 *   drop        something was set down at a dock: { pkg, dock }
 */
export function reconcile(order, events) {
  let unreadable = 0;
  let seen = false;
  for (const e of events) {
    if (e.order !== order.id) continue;
    seen = true;
    if (e.type === "drop") {
      return e.pkg === order.pkg && e.dock === order.dock ? "arrived" : "wrong";
    }
    if (e.type === "empty") return "missing";
    if (e.type === "scan") {
      const label = parsePayload(e.text);
      if (!label || label.id !== order.pkg) return "wrong";
    }
    if (e.type === "unreadable" && ++unreadable >= 2) return "manual";
  }
  return seen || order.started != null ? "transit" : "queued";
}

export class OrderBook {
  constructor() {
    this.orders = [];
    this.events = [];
    this.nextId = 1;
    this.byOrder = new Map();
  }

  add({ pkg, bay, dock, source = "auto" }, time = 0) {
    const order = { id: this.nextId++, pkg, bay, dock, source, created: time, started: null, finished: null, robot: null, scans: [] };
    this.orders.push(order);
    this.byOrder.set(order.id, []);
    return order;
  }

  log(order, type, time, extra = {}) {
    const event = { order: order.id, type, t: time, ...extra };
    this.events.push(event);
    this.byOrder.get(order.id).push(event);
    return event;
  }

  status(order) {
    return reconcile(order, this.byOrder.get(order.id) ?? []);
  }

  queued() {
    return this.orders.filter((o) => o.started === null);
  }

  active(bayId) {
    return this.orders.find((o) => o.bay === bayId && o.finished === null);
  }

  counts() {
    const c = { queued: 0, transit: 0, arrived: 0, missing: 0, wrong: 0, manual: 0 };
    for (const o of this.orders) c[this.status(o)]++;
    return c;
  }
}
