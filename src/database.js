import { PGlite } from "@electric-sql/pglite";
import { emptyDataset, validateDataset, parseAmount } from "./model.js";
import { forecastSql } from "./forecast.js";

function horizon({ from, to } = {}) {
  for (const value of [from, to]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error("Choose valid start and end dates.");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value ||
      value.startsWith("0000")
    )
      throw new Error("Choose valid start and end dates.");
  }
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86400000;
  if (days < 0) throw new Error("The horizon end must not precede its start.");
  if (days > 366 * 50)
    throw new Error(
      "Choose a horizon of at most 50 years per query. Nothing has been truncated.",
    );
  return { from, to };
}

export async function openDatabase({
  dataDir = "idb://budget-forecaster-v1",
} = {}) {
  let db;
  try {
    db = new PGlite({ dataDir, relaxedDurability: false });
    await db.waitReady;
    await db.exec(`SET TIME ZONE 'UTC';
      CREATE TABLE IF NOT EXISTS budget_dataset (singleton boolean PRIMARY KEY CHECK(singleton), payload jsonb NOT NULL);`);
    const { rows } = await db.query(
      "SELECT payload FROM budget_dataset WHERE singleton=true",
    );
    let current = rows.length
      ? validateDataset(rows[0].payload)
      : emptyDataset();
    if (!rows.length)
      await db.query("INSERT INTO budget_dataset VALUES(true,$1::jsonb)", [
        JSON.stringify(current),
      ]);
    const undo = [];
    let writing = false;
    let faulted = false;
    let closed = false;

    async function persist(next) {
      if (closed)
        throw new Error(
          "The local database has been closed. Reload before editing.",
        );
      if (faulted)
        throw new Error(
          "Local storage is in an uncertain state after a failed write. Export your last confirmed data and reload before editing.",
        );
      if (writing)
        throw new Error(
          "A save is already in progress. Wait for it to finish.",
        );
      writing = true;
      try {
        await db.transaction(async (tx) => {
          await tx.query(
            "UPDATE budget_dataset SET payload=$1::jsonb WHERE singleton=true",
            [JSON.stringify(next)],
          );
        });
        // PGlite 0.5.10 transaction() commits SQL while its in-transaction flag
        // still suppresses automatic filesystem sync. Explicitly await it before
        // reporting a durable save or replacing the last-confirmed export.
        await db.syncToFs();
      } catch (error) {
        faulted = true;
        throw new Error(
          `Local save failed; changes are not confirmed saved. Keep this tab open and export the last confirmed dataset. ${error.message}`,
        );
      } finally {
        writing = false;
      }
    }

    return {
      getDataset() {
        return structuredClone(current);
      },
      get canUndo() {
        return undo.length > 0 && !faulted && !closed;
      },
      get health() {
        return closed ? "closed" : faulted ? "failed" : "healthy";
      },
      async commit(input) {
        const next = validateDataset(input);
        const previous = current;
        await persist(next);
        undo.push(previous);
        if (undo.length > 50) undo.shift();
        current = next;
        return structuredClone(current);
      },
      async undo() {
        if (!undo.length)
          throw new Error("There is nothing to undo in this session.");
        const previous = undo.at(-1);
        await persist(previous);
        undo.pop();
        current = previous;
        return structuredClone(current);
      },
      async forecast(input) {
        if (closed) throw new Error("The local database is closed.");
        const { from, to } = horizon(input);
        const payload = JSON.stringify(current);
        const anchors = await db.query(
          `SELECT to_char(at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, amount
          FROM jsonb_to_recordset($1::jsonb->'snapshots') AS s(at text,amount text)
          WHERE at::timestamptz<=$2::date::timestamptz ORDER BY at::timestamptz DESC LIMIT 1`,
          [payload, from],
        );
        if (!anchors.rows.length)
          throw new Error(
            "Add an actual balance at or before the horizon start. Snapshots are the starting point, not income.",
          );
        // This is a conservative resource check, not a truncated forecast.
        const anchorDate = anchors.rows[0].at.slice(0, 10);
        let estimatedEvents = current.snapshots.length;
        for (const record of current.transactions) {
          const start =
            record.at.slice(0, 10) > anchorDate
              ? record.at.slice(0, 10)
              : anchorDate;
          const end = record.until && record.until < to ? record.until : to;
          if (end < start) continue;
          const years = Number(end.slice(0, 4)) - Number(start.slice(0, 4));
          estimatedEvents +=
            record.recurrence === "biweekly"
              ? (years + 1) * 26
              : record.recurrence === "monthly"
                ? years * 12 +
                    Number(end.slice(5, 7)) -
                    Number(start.slice(5, 7)) +
                    2
              : record.recurrence === "yearly"
                ? years + 2
                : 1;
        }
        if (estimatedEvents > 200000)
          throw new Error(
            "This query could expand beyond 200,000 events. Shorten the horizon or add a more recent actual balance. Nothing has been truncated.",
          );
        const { rows } = await db.query(forecastSql, [payload, from, to]);
        return {
          rows,
          firstZero: rows.find((row) => BigInt(row.units) === 0n)?.at ?? null,
          firstNegative: rows.find((row) => BigInt(row.units) < 0n)?.at ?? null,
          anchor: {
            at: anchors.rows[0].at,
            units: parseAmount(anchors.rows[0].amount),
          },
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        await db.close();
      },
    };
  } catch (error) {
    if (db && !db.closed) await db.close().catch(() => {});
    throw error;
  }
}
