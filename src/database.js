import pgliteWasmUrl from '../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbWasmUrl from '../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'
import fsBundleUrl from '../node_modules/@electric-sql/pglite/dist/pglite.data?url'
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

export async function openDatabase({ dataDir } = {}) {
  let db;
  try {
    console.info('trying open', dataDir);
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      fetch(pgliteWasmUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
      fetch(initdbWasmUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
      fetch(fsBundleUrl).then(r => r.blob()),
    ]);
    const NativeURL = globalThis.URL;
    globalThis.URL = new Proxy(NativeURL, {
      construct(Target, args, NewTarget) {
        if ( args[1] === "undefined" ) {
          return Reflect.construct(Target, [args[0]], NewTarget);
        }
        return Reflect.construct(Target, args, NewTarget);
      },
    });
    db = await PGlite.create({
      dataDir,
      relaxedDurability: false,
      pgliteWasmModule,
      initdbWasmModule,
      fsBundle,
    });
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

    async function deleteRow(input) {
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
      const beforeCount = current.length;
      console.info('deleting; beforeCount:', beforeCount);
      try {
        await db.transaction(async (tx) => {
            console.info('tx delete', input);
            await tx.query(` DELETE FROM transactions WHERE name = $1 AND at = $2; `, [input.name, input.at]);
            console.info('deleted');
            const { rows } = await tx.query(`SELECT * FROM transactions`);
            console.info('selected', rows);
            if (rows.length < beforeCount - 1)
              throw new Error("Deleted more than the single expected row",
                { cause: `New rows.length: ${rows.length}; Expected: ${beforeCount - 1}`});
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

    async function update({original, replacement}) {
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
      console.info('writing replacement');
      try {
        await db.transaction(async (tx) => {
            console.info('tx update', original, replacement);
            await tx.query(`
                UPDATE transactions
                SET (name, at, amount, every, ends_after, tags, notes) = (
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
                )
                WHERE name = $2 AND at = $3;  
                `,
                [JSON.stringify(replacement), original.name, original.at]);
            console.info('updated');
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

    async function upsert(newRows) {
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
            console.info('tx upsert', newRows);
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
      async bulkUpsert(input) {
        const next = validateDataset(input);
        await upsert(next);
        current = next;
        return structuredClone(current);
      },
      async singleUpdate({original, replacement}) {
        await update({original, replacement: validateDataset([replacement])});
        return structuredClone(current);
      },
      async singleDelete(input) {
        await deleteRow(input);
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
    if (db && !db.closed && typeof db.close === 'function') {
      try {
        await db.close();
      } catch (closeError) {
        console.error('Cleanup also failed:', closeError);
      }
    }
    throw error;
  }
}
