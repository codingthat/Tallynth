import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openStore } from "../src/store.js";
import { emptyDataset, validateDataset } from "../src/model.js";
import { PGlite } from "@electric-sql/pglite";
import { forecastSql } from "../src/forecast.js";
const snapshot = (at, amount, id = crypto.randomUUID()) => ({
  id,
  at,
  amount,
  notes: "",
});
const flow = (at, amount, extra = {}) => ({
  id: crypto.randomUUID(),
  at,
  name: "Flow",
  amount,
  recurrence: "once",
  until: "",
  actual: null,
  tags: [],
  notes: "",
  ...extra,
});
async function memory(t) {
  const store = await openStore({ dataDir: "memory://", lock: false });
  t.after(() => store.close());
  return store;
}

test("SQL snapshot equality overrides flows and preserves later chronology", async (t) => {
  const store = await memory(t);
  const data = emptyDataset();
  data.snapshots = [
    snapshot("2024-02-29T23:59:59Z", "1000"),
    snapshot("2024-03-01T12:00:00Z", "800"),
  ];
  data.transactions = [
    flow("2024-03-01", "-100"),
    flow("2024-03-01T12:00:00Z", "-20"),
    flow("2024-03-01T13:00:00Z", "-50"),
  ];
  await store.commit(data);
  let result = await store.forecast({ from: "2024-03-01", to: "2024-03-01" });
  assert.deepEqual(
    result.rows.map((r) => r.units),
    ["90000", "80000", "75000"],
  );
  data.snapshots[0].at = "2024-03-01T00:00:00Z";
  await store.commit(data);
  result = await store.forecast({ from: "2024-03-01", to: "2024-03-01" });
  assert.deepEqual(
    result.rows.map((r) => r.units),
    ["100000", "80000", "75000"],
  );
});
test("monthly/yearly schedule clamp retains original requested dates and bounds", async (t) => {
  const store = await memory(t);
  const data = emptyDataset();
  data.snapshots = [snapshot("2023-01-01", "100")];
  data.transactions = [
    flow("2023-01-31", "-1", {
      recurrence: "monthly",
      until: "2023-04-30",
      name: "Monthly",
    }),
    flow("2024-02-29T12:30:00Z", "2", {
      recurrence: "yearly",
      until: "2025-02-28",
      name: "Yearly",
    }),
  ];
  await store.commit(data);
  const result = await store.forecast({ from: "2023-01-01", to: "2025-03-01" });
  assert.deepEqual(
    result.rows
      .filter((r) => r.label === "Monthly")
      .map((r) => r.at.slice(0, 10)),
    ["2023-01-31", "2023-02-28", "2023-03-31", "2023-04-30"],
  );
  assert.deepEqual(
    result.rows
      .filter((r) => r.label === "Yearly")
      .map((r) => r.at.slice(0, 19)),
    ["2024-02-29T12:30:00", "2025-02-28T12:30:00"],
  );
  assert.equal(result.rows.at(-1).units, "10000");
});
test("exact large amounts, actual zero, empty windows and distinct zero/debt", async (t) => {
  const store = await memory(t);
  const data = emptyDataset();
  data.snapshots = [snapshot("2024-01-01", "90071992547409.93")];
  data.transactions = [
    flow("2024-01-02", "0.10"),
    flow("2024-01-03", "0.20"),
    flow("2024-01-04", "999", { actual: "0" }),
    flow("2024-01-05", "-90071992547410.23"),
    flow("2024-01-06", "-0.01"),
  ];
  await store.commit(data);
  let result = await store.forecast({ from: "2024-01-01", to: "2024-01-07" });
  assert.deepEqual(
    result.rows.map((r) => r.units),
    [
      "9007199254740993",
      "9007199254741003",
      "9007199254741023",
      "9007199254741023",
      "0",
      "-1",
    ],
  );
  assert.equal(result.firstZero, "2024-01-05T00:00:00.000Z");
  assert.equal(result.firstNegative, "2024-01-06T00:00:00.000Z");
  result = await store.forecast({ from: "2024-02-01", to: "2024-02-01" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].units, "-1");
});
test("one commit is one undo; rejected import leaves both data and undo intact", async (t) => {
  const store = await memory(t);
  const original = store.getDataset();
  const data = structuredClone(original);
  data.snapshots = [snapshot("2024-01-01", "100")];
  data.transactions = Array.from({ length: 1000 }, (_, i) =>
    flow("2024-01-02", "1", { name: `Flow ${i}` }),
  );
  await store.commit(data);
  assert.equal(store.getDataset().transactions.length, 1000);
  const bad = store.getDataset();
  bad.snapshots.push(snapshot("2024-01-01", "200"));
  await assert.rejects(store.commit(bad));
  assert.equal(store.getDataset().transactions.length, 1000);
  await store.undo();
  assert.deepEqual(store.getDataset(), original);
  assert.equal(store.canUndo, false);
});
test("native filesystem close/reopen retains canonical authoritative dataset", async () => {
  await mkdir("ignore", { recursive: true });
  const dir = await mkdtemp(resolve("ignore/store-"));
  try {
    let store = await openStore({ dataDir: dir, lock: false });
    const data = emptyDataset();
    data.snapshots = [snapshot("2024-01-01", "0.30")];
    await store.commit(data);
    const before = store.getDataset();
    await store.close();
    store = await openStore({ dataDir: dir, lock: false });
    try {
      assert.deepEqual(store.getDataset(), before);
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("no anchor, reversed/invalid/excessive horizons reject without inventing balances", async (t) => {
  const store = await memory(t);
  await assert.rejects(
    store.forecast({ from: "2024-01-01", to: "2024-01-03" }),
    /actual balance/i,
  );
  const data = emptyDataset();
  data.snapshots = [snapshot("2024-01-01", "100")];
  await store.commit(data);
  await assert.rejects(
    store.forecast({ from: "2024-02-30", to: "2024-03-01" }),
    /valid/i,
  );
  await assert.rejects(
    store.forecast({ from: "2024-02-01", to: "2024-01-01" }),
    /precede/i,
  );
  await assert.rejects(
    store.forecast({ from: "2024-01-01", to: "2100-01-01" }),
    /50 years/i,
  );
  await store.close();
  await assert.rejects(store.commit(data), /closed/i);
});
test("oversized recurrence expansion rejects before running an unbounded query", async (t) => {
  const store = await memory(t);
  const data = emptyDataset();
  data.snapshots = [snapshot("2024-01-01", "100")];
  data.transactions = Array.from({ length: 400 }, () =>
    flow("2024-01-31", "-1", { recurrence: "monthly" }),
  );
  await store.commit(data);
  await assert.rejects(
    store.forecast({ from: "2024-01-01", to: "2070-01-01" }),
    /200,000 events/,
  );
  assert.equal(store.getDataset().transactions.length, 400);
});
test("expired monthly and yearly rules generate no candidates after their active end", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("SET TIME ZONE 'UTC'");
  const data = emptyDataset();
  data.snapshots = [snapshot("2024-01-01", "100")];
  data.transactions = [
    flow("2020-01-31", "-1", { recurrence: "monthly", until: "2021-01-31" }),
    flow("2020-02-29", "-2", { recurrence: "yearly", until: "2021-02-28" }),
  ];
  const plan = await db.query("EXPLAIN(ANALYZE,FORMAT JSON) " + forecastSql, [
    JSON.stringify(validateDataset(data)),
    "2024-01-01",
    "2025-01-01",
  ]);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(plan.rows[0]["QUERY PLAN"][0].Plan);
  const series = nodes.filter(
    (n) => n["Node Type"] === "Function Scan" && ["m", "y"].includes(n.Alias),
  );
  assert.equal(series.length, 2);
  assert.ok(
    series.every((n) => n["Actual Rows"] === 0),
    "Expired rules must not expand before post-filtering",
  );
});
test("distant fifty-year horizons do not expand ancient expired schedules", async (t) => {
  const store = await memory(t);
  const data = emptyDataset();
  data.snapshots = [snapshot("0002-01-01", "100")];
  data.transactions = Array.from({ length: 100 }, (_, index) =>
    flow("0001-01-31", "-1", {
      recurrence: index % 2 ? "monthly" : "yearly",
      until: "0001-12-31",
    }),
  );
  await store.commit(data);
  const result = await store.forecast({ from: "9950-01-01", to: "9999-12-31" });
  assert.deepEqual(
    result.rows.map((row) => row.units),
    ["10000"],
  );
});
