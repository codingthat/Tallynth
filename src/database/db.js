import pgliteWasmUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbWasmUrl from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'
import fsBundleUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.data?url'
import { PGlite } from "@electric-sql/pglite";
import validTagsSql from "./valid-tags-function.sql?raw";
import transactionsTableSql from "./transactions-table.sql?raw";
import settingsTableSql from "./settings-table.sql?raw";
import defaultSettingsSql from "./insert-default-settings.sql?raw";
import getSettingsSql from "./get-settings.sql?raw";
import setSettingsSql from "./set-settings.sql?raw";
import selectRecordsSql from "./select-transactions.sql?raw";
import upsertSql from "./upsert-transactions.sql?raw";
import updateSql from "./update-transaction.sql?raw";
import deleteSql from "./delete-transaction.sql?raw";
import deleteAllTransactionsSql from "./delete-all-transactions.sql?raw";
import forecastFunctionSql from "./forecast-function.sql?raw";
import forecastQuerySql from "./forecast-query.sql?raw";

function normalized(rows) {
  return rows.map(({ name, at, amount, every, ends_after, tags, notes }) => ({
    name, at, amount: String(amount), every, ends_after,
    tags: Array.isArray(tags) ? tags : [], notes,
  }));
}

async function recordsIn(tx) {
  return normalized((await tx.query(selectRecordsSql)).rows);
}

function actionableError(error) {
  const constraint = error.constraint ?? /constraint "([^"]+)"/.exec(error.message)?.[1];
  const messages = {
    transactions_name_valid: "Transaction name must contain 1 to 200 non-whitespace characters.",
    transactions_amount_valid: "Transaction amount must be a finite exact number.",
    transactions_every_valid: "Repeat interval must be at least one whole day.",
    transactions_ends_after_valid: "Ending date is only allowed on repeating transactions and cannot precede the transaction date.",
    transactions_tags_valid: "Tags must be unique, nonempty, trimmed, and limited to 20 values.",
    transactions_notes_valid: "Notes must be 2000 characters or fewer.",
    transactions_pkey: "A transaction with this name and date already exists. Change the name or date, or edit the existing transaction.",
    settings_amount_valid: "Starting amount must be a finite exact number.",
    settings_dates_valid: "The end date must not precede the start date.",
  };
  const message = messages[constraint]
    ?? (error.code === "22007" || error.code === "22008"
      ? "A date is invalid. Enter a real date in YYYY-MM-DD format."
      : error.code === "22P02" || error.code === "22003"
        ? "A value has an invalid format or is outside the supported range. Check the date, amount, and repeat fields."
        : null);
  if (!message) return error;
  const result = new Error(message, { cause: error });
  result.name = "DatabaseInputError";
  result.stack = error.stack;
  return result;
}

function ensureWritable({ closed, faulted, writing }) {
  if (closed) throw new Error("The local database has been closed. Reload before editing.");
  if (faulted) throw new Error("Local storage is in an uncertain state after a failed write. Export your last confirmed data and reload before editing.");
  if (writing) throw new Error("A save is already in progress. Wait for it to finish.");
}

function horizon({ from, to } = {}) {
  for (const value of [from, to]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose valid start and end dates.");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith("0000")) throw new Error("Choose valid start and end dates.");
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (days < 0) throw new Error("The horizon end must not precede its start.");
  if (days > 366 * 50) throw new Error("Choose a horizon of at most 50 years per query.");
  return { from, to };
}

export async function openDatabase({ dataDir } = {}) {
  let db;
  try {
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      fetch(pgliteWasmUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
      fetch(initdbWasmUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
      fetch(fsBundleUrl).then(r => r.blob()),
    ]);
    const NativeURL = globalThis.URL;
    globalThis.URL = new Proxy(NativeURL, { construct(Target, args, NewTarget) {
      return args[1] === "undefined" ? Reflect.construct(Target, [args[0]], NewTarget) : Reflect.construct(Target, args, NewTarget);
    }});
    db = await PGlite.create({ dataDir, relaxedDurability: false, pgliteWasmModule, initdbWasmModule, fsBundle });
    await db.waitReady;
    await db.exec(validTagsSql);
    await db.exec(transactionsTableSql);
    await db.exec(settingsTableSql);
    await db.exec(forecastFunctionSql);
    await db.query(defaultSettingsSql);
    await db.syncToFs();
    let current = normalized((await db.query(selectRecordsSql)).rows);
    let settings = (await db.query(getSettingsSql)).rows[0];
    let writing = false, faulted = false, closed = false;

    async function commit(operation, message = "Local save failed; changes are not confirmed saved.") {
      ensureWritable({ closed, faulted, writing });
      writing = true;
      let committed = false;
      try {
        const result = await db.transaction(operation);
        committed = true;
        await db.syncToFs();
        return result;
      } catch (error) {
        if (committed) faulted = true;
        if (!committed) throw actionableError(error);
        const uncertain = new Error(
          `${message} Keep this tab open and export the last confirmed dataset. ${error.message}`,
          { cause: error },
        );
        uncertain.name = "PersistenceUncertainError";
        uncertain.stack = error.stack;
        throw uncertain;
      } finally { writing = false; }
    }

    async function upsertRows(tx, input) {
      await tx.query(upsertSql, [JSON.stringify(input)]);
      return recordsIn(tx);
    }

    return {
      getDataset() { return structuredClone(current); },
      getSettings() { return structuredClone(settings); },
      get health() { return closed ? "closed" : faulted ? "failed" : "healthy"; },
      async previewUpsert(input) {
        ensureWritable({ closed, faulted, writing });
        let result, failure;
        try {
          await db.transaction(async tx => {
            try { result = await upsertRows(tx, input); }
            catch (error) { failure = error; }
            throw PREVIEW_ROLLBACK;
          });
        } catch (error) {
          if (error !== PREVIEW_ROLLBACK) throw error;
        }
        if (failure) throw actionableError(failure);
        return structuredClone(result);
      },
      async bulkUpsert(input) {
        const next = await commit(tx => upsertRows(tx, input));
        current = next;
        return structuredClone(current);
      },
      async replaceDataset({ records, settings: nextSettings }) {
        const result = await commit(async tx => {
          await tx.query(deleteAllTransactionsSql);
          await tx.query(upsertSql, [JSON.stringify(records)]);
          await tx.query(setSettingsSql, [nextSettings.from, nextSettings.amount, nextSettings.to]);
          return { records: await recordsIn(tx), settings: (await tx.query(getSettingsSql)).rows[0] };
        });
        current = result.records; settings = result.settings;
        return structuredClone(result);
      },
      async singleUpdate({ original, replacement }) {
        const next = await commit(async tx => {
          await tx.query(updateSql, [JSON.stringify([replacement]), original.name, original.at]);
          return recordsIn(tx);
        });
        current = next; return structuredClone(current);
      },
      async singleDelete(input) {
        const next = await commit(async tx => {
          await tx.query(deleteSql, [input.name, input.at]);
          return recordsIn(tx);
        });
        current = next; return structuredClone(current);
      },
      async setSettings(input) {
        const next = await commit(async tx => {
          await tx.query(setSettingsSql, [input.from, input.amount, input.to]);
          return (await tx.query(getSettingsSql)).rows[0];
        }, "Local settings save failed; changes are not confirmed saved.");
        settings = next; return structuredClone(settings);
      },
      async forecast(input) {
        if (closed) throw new Error("The local database has been closed.");
        const { from, to } = horizon(input);
        const { rows } = await db.query(forecastQuerySql, [from, input.amount, to]);
        return { rows, anchor: { at: rows[0].at, sum: String(rows[0].sum) } };
      },
      async close() { if (closed) return; closed = true; await db.close(); },
    };
  } catch (error) {
    if (db && !db.closed && typeof db.close === "function") { try { await db.close(); } catch (closeError) { console.error("Cleanup also failed:", closeError); } }
    throw error;
  }
}

const PREVIEW_ROLLBACK = Symbol("preview rollback");
