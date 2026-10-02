import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook, parsePayload, reconcile } from "../src/sim/orders.js";

const order = { id: 1, pkg: "PKG-00421", bay: "B3", dock: 2, started: 0 };
const ev = (type, extra = {}) => ({ order: 1, type, ...extra });

test("labels parse, and only ours", () => {
  assert.deepEqual(parsePayload("PKG-00421 B3 D2"), { id: "PKG-00421", bay: "B3", dock: 2 });
  assert.equal(parsePayload("hello"), null);
  assert.equal(parsePayload(undefined), null);
});

test("reconciliation: arrived only when the right package reaches the right dock", () => {
  assert.equal(reconcile(order, [ev("scan", { text: "PKG-00421 B3 D2" }), ev("drop", { pkg: "PKG-00421", dock: 2 })]), "arrived");
  assert.equal(reconcile(order, [ev("scan", { text: "PKG-00421 B3 D2" }), ev("drop", { pkg: "PKG-00421", dock: 3 })]), "wrong");
  assert.equal(reconcile(order, [ev("drop", { pkg: "PKG-00777", dock: 2 })]), "wrong");
});

test("reconciliation: missing, wrong, unreadable, in transit, queued", () => {
  assert.equal(reconcile(order, [ev("empty")]), "missing");
  assert.equal(reconcile(order, [ev("scan", { text: "PKG-00777 B3 D1" })]), "wrong");
  assert.equal(reconcile(order, [ev("scan", { text: "garbage" })]), "wrong");
  assert.equal(reconcile(order, [ev("unreadable")]), "transit");
  assert.equal(reconcile(order, [ev("unreadable"), ev("unreadable")]), "manual");
  assert.equal(reconcile(order, [ev("unreadable"), ev("scan", { text: "PKG-00421 B3 D2" })]), "transit");
  assert.equal(reconcile({ ...order, started: null }, []), "queued");
  assert.equal(reconcile(order, [{ order: 2, type: "empty" }]), "transit");
});

test("the order book keeps events per order and counts statuses", () => {
  const book = new OrderBook();
  const a = book.add({ pkg: "PKG-00001", bay: "A1", dock: 1 });
  const b = book.add({ pkg: "PKG-00002", bay: "A2", dock: 2 });
  const c = book.add({ pkg: "PKG-00003", bay: "A3", dock: 3 });
  a.started = b.started = 1;
  book.log(a, "scan", 2, { text: "PKG-00001 A1 D1" });
  book.log(a, "drop", 3, { pkg: "PKG-00001", dock: 1 });
  book.log(b, "empty", 2);
  assert.deepEqual(book.counts(), { queued: 1, transit: 0, arrived: 1, missing: 1, wrong: 0, manual: 0 });
  assert.deepEqual(book.queued(), [c]);
});
