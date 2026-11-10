import { PGlite } from "@electric-sql/pglite";
import { validateDataset, parseAmount } from "./model.js";
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
      "Choose a horizon of at most 50 years per query.",
    );
  return { from, to };
}

export const dataDir  = "idb://ezmonthcast-v8";

export async function openDatabase({ dataDir } = {}) {
  let db;
  try {
    console.info('trying open', dataDir);
    db = new PGlite({ dataDir, relaxedDurability: false });
    console.info('waiting');
    await db.waitReady;
    console.info('execing');
    await db.exec(`CREATE TABLE IF NOT EXISTS transactions (
    name text NOT NULL,
    at date NOT NULL,
    amount money NOT NULL,
    every interval CHECK (
        every >= '1 day'::interval
        AND NOT extract(epoch from every) / extract(epoch from '1 day'::interval) % 1 > 0
    ), -- no fractional days
    ends_after date,
    tags text,
    notes text,
    PRIMARY KEY (name, at)
);
COMMENT ON TABLE transactions IS 'Income is positive, expenses are negative.';


CREATE OR REPLACE FUNCTION forecast(after date = current_date, amount money = 0, through date = current_date + '1 year'::interval) RETURNS TABLE (at date, sum money, name text)
    LANGUAGE sql STABLE
    AS $$
 WITH
events AS (
    SELECT t.at, t.name, t.amount
    FROM transactions t
    WHERE t.every IS NULL
  UNION ALL
    SELECT r.at, t.name, t.amount
    FROM transactions t
    CROSS JOIN LATERAL (
        SELECT (t.at + g.n * t.every)::date AS at
        FROM generate_series(0, through - t.at) AS g(n)
    ) AS r
    WHERE t.every IS NOT NULL
      AND (t.ends_after IS NULL OR r.at <= t.ends_after)
),
balances AS (
    SELECT at, amount, name
    FROM events
    WHERE at > after AND at <= through
    UNION ALL
    SELECT after, amount, 'Start'
)
SELECT at, sum(amount) OVER (ORDER BY at), name
FROM balances
ORDER BY at, name;
$$;

      `);
    console.info('selecting');
    const { rows } = await db.query(`SELECT * FROM transactions`);
    console.info('validating', rows);
    let current = validateDataset(rows);
    console.info('other');
    let writing = false;
    let faulted = false;
    let closed = false;

    async function persist(newRows) {
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
      console.info('writing');
      try {
        await db.transaction(async (tx) => {
            console.info('xact', newRows);
            await tx.query(`
                INSERT INTO transactions (name, at, amount, every, ends_after, tags, notes)
                SELECT name, at, amount::money, every, ends_after, tags, notes
                FROM jsonb_to_recordset($1::jsonb) AS r(
                    name text,
                    at date,
                    amount numeric,
                    every interval,
                    ends_after date,
                    tags text,
                    notes text
                )
                ON CONFLICT (name, at) DO UPDATE SET
                    amount = EXCLUDED.amount,
                    every = EXCLUDED.every,
                    ends_after = EXCLUDED.ends_after,
                    tags = EXCLUDED.tags,
                    notes = EXCLUDED.notes;`,
                [JSON.stringify(newRows)]);
            console.info('inserted');
            const { rows } = await tx.query(`SELECT * FROM transactions`);
            console.info('selected', rows);
            current = rows;
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
      get health() {
        return closed ? "closed" : faulted ? "failed" : "healthy";
      },
      async commit(input) {
        const next = validateDataset(input);
        const previous = current;
        await persist(next);
        current = next;
        return structuredClone(current);
      },
      async forecast(input) {
        if (closed) throw new Error("The local database is closed.");
        const { from, to } = horizon(input);
        const { rows } = await db.query(forecastSql, [from, input.amount, to]);
        return {
          rows,
          firstZero: rows.find((row) => Number(row.sum) === 0n)?.at ?? null,
          firstNegative: rows.find((row) => Number(row.sum) < 0n)?.at ?? null,
          anchor: {
            at: rows[0].at,
            sum: parseAmount(rows[0].sum),
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
