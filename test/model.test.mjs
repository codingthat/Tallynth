import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyDataset,
  validateDataset,
  parseAmount,
  formatAmount,
  parseImport,
  serializeDataset,
  parseDatasetFile,
} from "../src/model.js";

const transaction = (overrides = {}) => ({
  id: "tx",
  at: "2026-01-01",
  name: "Rent",
  amount: "-100",
  recurrence: "once",
  until: "",
  actual: null,
  tags: [],
  notes: "",
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  id: "snap",
  at: "2026-01-01",
  amount: "100",
  notes: "",
  ...overrides,
});

test("money uses exact units and canonical decimal strings", () => {
  assert.equal(parseAmount("0.1"), "10");
  assert.equal(
    formatAmount(
      (BigInt(parseAmount("0.1")) + BigInt(parseAmount("0.2"))).toString(),
    ),
    "0.30",
  );
  assert.equal(parseAmount("9007199254740993.01"), "900719925474099301");
  assert.equal(formatAmount("-1"), "-0.01");
  assert.equal(formatAmount(parseAmount("-0.00")), "0.00");
  assert.equal(parseAmount("0000000000000000000000000000000000001.20"), "120");
  assert.equal(formatAmount("-00000120"), "-1.20");
  assert.equal(
    parseAmount("9999999999999999999999999999.99"),
    "999999999999999999999999999999",
  );
  for (const value of [
    "1e2",
    "1.001",
    "NaN",
    "Infinity",
    "",
    " 1",
    "1.",
    ".1",
    "10000000000000000000000000000",
  ])
    assert.throws(() => parseAmount(value));
  for (const value of [0.1, NaN, Infinity, null])
    assert.throws(() => parseAmount(value));
  for (const value of ["1.1", "1e2", "1000000000000000000000000000000", 1])
    assert.throws(() => formatAmount(value));
});

test("dates validate calendar boundaries and preserve full year range in UTC", () => {
  for (const at of [
    "0001-01-01",
    "9999-12-31T23:59:59.999Z",
    "2000-02-29T12:30",
    "2026-01-01T12:30:10Z",
  ]) {
    const result = validateDataset({
      ...emptyDataset(),
      snapshots: [snapshot({ at })],
    });
    assert.match(
      result.snapshots[0].at,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
  }
  for (const at of [
    "0000-01-01",
    "1900-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-01-01T24:00",
    "2026-01-01T12:60",
    "2026-01-01T12:00:60Z",
    "2026-01-01T12:00+01:00",
    "2026-1-1",
  ]) {
    assert.throws(() =>
      validateDataset({ ...emptyDataset(), snapshots: [snapshot({ at })] }),
    );
  }
});

test("dataset validates exact shape, identities, settings, and snapshot instants", () => {
  assert.notEqual(emptyDataset().id, emptyDataset().id);
  assert.throws(() => validateDataset({ ...emptyDataset(), extra: true }));
  assert.throws(() => validateDataset({ ...emptyDataset(), version: 2 }));
  for (const settings of [
    { currency: "JPY", timeZone: "UTC" },
    { currency: "EUR", timeZone: "Europe/Paris" },
    { currency: "EUR", timeZone: "UTC", extra: 1 },
  ])
    assert.throws(() => validateDataset({ ...emptyDataset(), settings }));
  assert.throws(() =>
    validateDataset({
      ...emptyDataset(),
      snapshots: [snapshot()],
      transactions: [transaction({ id: "snap" })],
    }),
  );
  const data = emptyDataset();
  assert.throws(() =>
    validateDataset({ ...data, transactions: [transaction({ id: data.id })] }),
  );
  assert.throws(() =>
    validateDataset({
      ...emptyDataset(),
      snapshots: [
        snapshot(),
        snapshot({ id: "other", at: "2026-01-01T00:00Z" }),
      ],
    }),
  );
  assert.throws(() =>
    validateDataset({
      ...emptyDataset(),
      transactions: [transaction({ amount: 1 })],
    }),
  );
  assert.throws(() =>
    validateDataset({
      ...emptyDataset(),
      transactions: [transaction({ tags: ["a", "a"] })],
    }),
  );
  assert.throws(() =>
    validateDataset({
      ...emptyDataset(),
      transactions: [transaction({ extra: true })],
    }),
  );
  assert.throws(() =>
    validateDataset({ ...emptyDataset(), snapshots: Array(1) }),
  );
  for (const changes of [
    { id: "" },
    { id: "x".repeat(101) },
    { name: "" },
    { name: "x".repeat(201) },
    { notes: "x".repeat(2001) },
    { tags: ["x".repeat(41)] },
    { tags: Array.from({ length: 21 }, (_, i) => String(i)) },
    { recurrence: "weekly" },
  ])
    assert.throws(() =>
      validateDataset({
        ...emptyDataset(),
        transactions: [transaction(changes)],
      }),
    );
});

test("actual zero remains distinct from expected and recurrence boundaries are enforced", () => {
  const data = validateDataset({
    ...emptyDataset(),
    transactions: [transaction({ actual: "0" })],
  });
  assert.equal(data.transactions[0].actual, "0.00");
  assert.equal(data.transactions[0].amount, "-100.00");
  for (const changes of [
    { until: "2026-01-01" },
    { recurrence: "monthly", actual: "0" },
    { recurrence: "yearly", until: "2025-12-31" },
    { recurrence: "monthly", until: "2026-02-30" },
  ])
    assert.throws(() =>
      validateDataset({
        ...emptyDataset(),
        transactions: [transaction(changes)],
      }),
    );
  assert.equal(
    validateDataset({
      ...emptyDataset(),
      transactions: [
        transaction({ recurrence: "monthly", until: "2026-01-01" }),
      ],
    }).transactions[0].until,
    "2026-01-01",
  );
});

test("CSV supports quoted delimiters, escaped quotes, embedded newlines and empty columns", () => {
  const rows = parseImport(
    '2026-01-01,"A, ""quoted"" name",-1,,,0,a;b,"line 1\nline 2"\n',
    "csv",
    "transactions",
  );
  assert.equal(rows[0].name, 'A, "quoted" name');
  assert.equal(rows[0].notes, "line 1\nline 2");
  assert.equal(rows[0].actual, "0.00");
  assert.equal(rows[0].recurrence, "once");
  assert.deepEqual(rows[0].tags, ["a", "b"]);
});

test("TSV and SSV preserve explicit empty columns and quoted separators", () => {
  const tsv = parseImport(
    '2026-01-01\t"A\tB"\t1\t\t\t\t\t"say ""hi"""',
    "tsv",
    "transactions",
  )[0];
  assert.equal(tsv.name, "A\tB");
  assert.equal(tsv.notes, 'say "hi"');
  const ssv = parseImport(
    '2026-01-01   "A B" 1 "" "" 0 "" "say ""hi"""',
    "ssv",
    "transactions",
  )[0];
  assert.equal(ssv.name, "A B");
  assert.equal(ssv.actual, "0.00");
  assert.equal(ssv.notes, 'say "hi"');
  assert.equal(parseImport("2026-01-01,1,", "csv", "snapshots")[0].notes, "");
});

test("imports reject invalid middle/late rows, blanks, columns and quoting with locations", () => {
  for (const [text, row, col] of [
    ["2026-01-01,1,\n2026-02-30,2,\n2026-03-01,3,", 2, 1],
    ["2026-01-01,1,\n2026-02-01,2,\n2026-03-01,1e2,", 3, 2],
    ["2026-01-01,1,\n\n2026-02-01,2,", 2, 1],
    ["2026-01-01,1", 1, 3],
    ['2026-01-01,1,"unterminated', 1, 3],
    ['2026-01-01,1,ab"cd', 1, 3],
    ['2026-01-01,1,"a"b', 1, 3],
  ])
    assert.throws(
      () => parseImport(text, "csv", "snapshots"),
      new RegExp(`row ${row}, column ${col}`, "i"),
    );
  assert.throws(
    () =>
      parseImport("2026-01-01,1,\n2026-01-01T00:00Z,2,", "csv", "snapshots"),
    /row 2, column 1/i,
  );
  assert.throws(() => parseImport("", "csv", "snapshots"));
  assert.throws(() => parseImport("x", ",", "snapshots"));
  assert.throws(() => parseImport("x", "csv", "other"));
  assert.throws(() =>
    parseImport("2026-01-01 A 1     ", "ssv", "transactions"),
  );
  assert.throws(
    () => parseImport("2026-01-01 1 ", "ssv", "snapshots"),
    /row 1, column 3/i,
  );
  assert.equal(
    parseImport('2026-01-01 1 ""\r\n', "ssv", "snapshots")[0].notes,
    "",
  );
});

test("whole file roundtrip preserves identities and rejects unsupported or oversized data", () => {
  const data = validateDataset({
    ...emptyDataset(),
    snapshots: [snapshot()],
    transactions: [transaction({ actual: "0" })],
  });
  assert.deepEqual(parseDatasetFile(serializeDataset(data)), data);
  assert.throws(() => parseDatasetFile("{"));
  assert.throws(() =>
    parseDatasetFile(JSON.stringify({ ...data, version: 2 })),
  );
  const huge = " ".repeat(8 * 1024 * 1024 + 1);
  assert.throws(() => parseDatasetFile(huge), /size|large|MiB/i);
  assert.throws(() => parseImport(huge, "csv", "snapshots"), /size|large|MiB/i);
  assert.throws(
    () => parseDatasetFile("é".repeat(4 * 1024 * 1024 + 1)),
    /size|large|MiB/i,
  );
});

test("canonical size limit permits export and reopen at the boundary and rejects normalization overflow", () => {
  const limit = 8 * 1024 * 1024;
  const bytes = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  function nearLimit(target) {
    const data = {
      ...emptyDataset(),
      transactions: Array.from({ length: 4000 }, (_, index) =>
        transaction({
          id: `near-limit-${index}`,
          at: "2026-01-01T00:00:00.000Z",
          amount: "-100.00",
        }),
      ),
    };
    let remaining = target - bytes(data);
    for (const record of data.transactions) {
      const length = Math.min(2000, remaining);
      record.notes = "x".repeat(length);
      remaining -= length;
    }
    assert.equal(remaining, 0, "synthetic notes must have sufficient capacity");
    assert.equal(bytes(data), target);
    // The shorter incoming dates and amounts fit, but validation expands both.
    for (const record of data.transactions) {
      record.at = "2026-01-01";
      record.amount = "-100";
    }
    assert.ok(bytes(data) < limit);
    return data;
  }
  const accepted = validateDataset(nearLimit(limit));
  const text = serializeDataset(accepted);
  assert.equal(new TextEncoder().encode(text).length, limit);
  assert.deepEqual(parseDatasetFile(text), accepted);
  const overflow = nearLimit(limit + 1);
  assert.throws(() => validateDataset(overflow), /size|large|MiB/i);
  assert.throws(
    () => parseDatasetFile(JSON.stringify(overflow)),
    /size|large|MiB/i,
  );
});
