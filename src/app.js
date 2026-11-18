import "./styles.css";
import { parseAmount, formatAmount, compareAmountToZero } from "./format-parse.js";
import { openStore } from "./database/worker-client.js";
import { createEditor } from "./app/editor.js";
import { createImportExport } from "./app/import-export.js";
import { createForecastView } from "./app/forecast.js";

const $ = (id) => document.getElementById(id);
const state = { store: null, dataset: null, settings: null, pending: 0, forecastVersion: 0, saveError: null };
const message = (error) => error instanceof Error ? error.message : String(error);
function globalError(error) {
  $("global-error").textContent = error ? message(error) : "";
  $("global-error").hidden = !error;
}
function dateLabel(at) { return at ? new Date(at).toISOString().slice(0, 10) : "Not reached"; }
const forecastView = createForecastView({ parseAmount, formatAmount, compareAmountToZero, dateLabel });
const storageUnavailable = () => Boolean(state.store) && state.store.health !== "healthy";
let editor;
function updateStorageStatus() {
  if (!state.dataset) return;
  let status = "saved", text = "Saved in this browser";
  if (storageUnavailable()) { status = "failed"; text = "Storage failed or closed · save file to recover confirmed records"; }
  else if (state.pending) { status = "saving"; text = "Saving to this browser…"; }
  else if (state.saveError || editor?.hasFailures()) { status = "failed"; text = "Save failed · check unsaved edits or error"; }
  else if (editor?.hasUnsavedEdits()) { status = "unsaved"; text = "Unsaved edits · incomplete drafts are not saved"; }
  $("storage-status").textContent = text; $("storage-status").dataset.state = status;
}
function controls() {
  const available = Boolean(state.store) && !state.pending, writable = available && !storageUnavailable();
  for (const id of ["save-file", "open-file", "show-import", "load-example", "reset-app"]) $(id).disabled = id === "save-file" ? !available : !writable;
  for (const id of ["from", "amount", "to", "import-text"]) $(id).disabled = !writable;
  if (!writable) $("apply-import").disabled = true;
  $("preview-import").disabled = !writable;
  $("main").setAttribute("aria-busy", String(Boolean(state.pending)));
  editor?.setBusy();
  if (state.dataset) $("empty-state").hidden = state.dataset.length !== 0;
}
function beginOperation() { state.pending++; controls(); updateStorageStatus(); }
function endOperation() { state.pending--; controls(); updateStorageStatus(); }
async function saveRecord(original, replacement) {
  beginOperation();
  try {
    const response = original ? await state.store.request("singleUpdate", { original, replacement }) : await state.store.request("bulkUpsert", [...state.dataset, replacement]);
    const records = response.dataset;
    state.dataset = records; state.saveError = null; globalError(null); void refreshForecast(); return records;
  } catch (error) { state.saveError = message(error); console.error(error); globalError(error); throw error; }
  finally { endOperation(); }
}
async function deleteRecord(record) {
  beginOperation();
  try { state.dataset = (await state.store.request("singleDelete", record)).dataset; state.saveError = null; globalError(null); void refreshForecast(); return state.dataset; }
  catch (error) { console.error(error); globalError(error); throw error; }
  finally { endOperation(); }
}
editor = createEditor({ save: saveRecord, remove: deleteRecord, getRecords: () => state.dataset || [], busy: () => Boolean(state.pending), storageUnavailable, statusChanged: updateStorageStatus });
createImportExport({
  getSnapshot: () => ({ records: state.dataset || [], settings: state.settings }),
  previewUpsert: async (rows) => {
    beginOperation();
    try { return (await state.store.request("previewUpsert", rows)).value; }
    finally { endOperation(); }
  },
  bulkUpsert: async (rows) => {
    beginOperation();
    try { const records = (await state.store.request("bulkUpsert", rows)).dataset; state.dataset = records; state.saveError = null; editor.render(records); globalError(null); void refreshForecast(); return records; }
    catch (error) { state.saveError = message(error); console.error(error); globalError(error); throw error; }
    finally { endOperation(); }
  },
  replaceDataset: async (dataset) => {
    beginOperation();
    try { const result = await state.store.request("replaceDataset", dataset); state.dataset = result.dataset; state.settings = result.settings; for (const id of ["from", "amount", "to"]) $(id).value = state.settings[id]; void refreshForecast(); return result; }
    catch (error) { state.saveError = message(error); console.error(error); throw error; }
    finally { endOperation(); }
  },
  onRecords: (records) => { state.dataset = records; editor.render(records); controls(); updateStorageStatus(); void refreshForecast(); },
  onSettings: (settings) => { state.settings = settings; for (const id of ["from", "amount", "to"]) $(id).value = settings[id]; },
  onError: globalError,
  busy: () => Boolean(state.pending),
});
async function refreshForecast() {
  if (!state.store) return;
  const version = ++state.forecastVersion, from = $("from").value, amount = $("amount").value ?? 0, to = $("to").value;
  if (!from || !to || from > to) { forecastView.status("Choose a valid start date and an end date on or after it."); return; }
  forecastView.status("Calculating from the local database…");
  try {
    const result = (await state.store.request("forecast", { from, amount, to })).value;
    if (version !== state.forecastVersion) return;
    forecastView.render(result, { from, to, amount });
  } catch (error) { if (version === state.forecastVersion) forecastView.status(`Forecast failed: ${message(error)}`); }
}
$("load-example").addEventListener("click", async () => {
  if (state.dataset?.length) { globalError(new Error("The synthetic example is available only on an empty dataset.")); return; }
  const day = $("from").value;
  beginOperation();
  try {
    const records = (await state.store.request("bulkUpsert", [
      { at: day, name: "Income", amount: "1000.00", every: "2 weeks", ends_after: Temporal.Now.plainDateISO().add({ months: 3 }).toString(), tags: ["example"], notes: "Example biweekly income" },
      { at: day, name: "Rent", amount: "-1100.00", every: "1 month", ends_after: null, tags: ["example", "housing"], notes: "Example monthly expense" },
    ])).dataset; state.dataset = records; state.saveError = null; editor.render(records); void refreshForecast();
  }
  catch (error) { state.saveError = message(error); console.error(error); globalError(error); }
  finally { endOperation(); }
});
async function settingsChangeHandler(event) {
  const next = Object.fromEntries(["from", "amount", "to"].map((id) => [id, $(id).value]));
  beginOperation();
  try { state.settings = (await state.store.request("setSettings", next)).settings; state.saveError = null; void refreshForecast(); }
  catch (error) { state.saveError = message(error); console.error(error); globalError(error); }
  finally { endOperation(); }
}
for (const id of ["from", "amount", "to"]) $(id).addEventListener("change", settingsChangeHandler);
try {
  state.store = await openStore();
  state.dataset = state.store.initialDataset;
  state.settings = state.store.initialSettings;
  for (const id of ["from", "amount", "to"]) $(id).value = state.settings[id];
  editor.render(state.dataset); controls(); updateStorageStatus(); void refreshForecast();
} catch (error) {
  console.error(error);
  $("storage-status").textContent = "Local database unavailable";
  $("storage-status").dataset.state = "failed";
  if (error.name === "DatabaseAlreadyOpenError") {
    $("database-lock-dialog").showModal();
    globalError(null);
  } else globalError(error);
  controls();
}
window.addEventListener("pagehide", () => { if (state.store) void state.store.close(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
