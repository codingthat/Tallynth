import "./styles.css";
import { openStore } from "./database/worker-client.js";
import { createEditor } from "./app/editor.js";
import { createImportExport } from "./app/import-export.js";
import { createForecastView } from "./app/forecast.js";

const $ = (id) => document.getElementById(id);
const state = { store: null, dataset: null, settings: null, pending: 0, forecastVersion: 0, errorMsg: null };
const translateError = (error) => {
  var retVal = error instanceof Error ? error.message : String(error);
  if (retVal.includes("transactions_every_valid"))
    retVal = "Can't be shorter than a day.  Try things like '1 day', '2 weeks', '6 months', or '1 year'.";
  else if (retVal.includes("settings_dates_valid"))
    retVal = "'After' date must be before 'Through' date."
  return retVal;
};
function globalError(error) {
  $("global-error").textContent = error ? translateError(error) : "";
  $("global-error").hidden = !error;
  if (error) {
    console.error(error);
    state.errorMsg = translateError(error);
    throw error;
  }
}
const forecastView = createForecastView();
const storageUnavailable = () => state.store?.health !== "healthy";
let editor;
function updateStorageStatus() {
  if (!state.dataset) return;
  let status = "saved", text = "Saved in this browser";
  if (storageUnavailable()) { status = "failed"; text = "Storage failed or closed · save file to recover confirmed records"; }
  else if (state.pending) { status = "saving"; text = "Saving to this browser…"; }
  else if (state.errorMsg || editor?.hasFailures()) { status = "failed"; text = "Save failed · check unsaved edits or error"; }
  else if (editor?.hasUnsavedEdits()) { status = "unsaved"; text = "Unsaved edits · incomplete drafts are not saved"; }
  $("storage-status").textContent = text; $("storage-status").dataset.state = status;
}
function controls() {
  const available = !!state.store && !state.pending, writable = available && !storageUnavailable();
  for (const id of ["save-file", "open-file", "show-import", "load-example", "reset-app"]) $(id).disabled = id === "save-file" ? !available : !writable;
  for (const id of ["from", "amount", "to", "import-text"]) $(id).disabled = !writable;
  if (!writable) $("apply-import").disabled = true;
  $("preview-import").disabled = !writable;
  $("main").setAttribute("aria-busy", String(!!state.pending));
  editor?.setBusy();
  if (state.dataset) $("empty-state").hidden = state.dataset.length !== 0;
}
async function dbCall(functionName, input, stateToKeep) {
  state.pending++; controls(); updateStorageStatus();
  try { 
    var result = (await state.store.request(functionName, input)).value;
    if (stateToKeep) state[stateToKeep] = result;
    state.errorMsg = null;
    globalError(null);
    void refreshForecast();
    if (stateToKeep === "dataset") {
      if (["exampleDataset", "replaceDataset", "bulkUpsert"].includes(functionName)) editor.render(result);
      controls();
      updateStorageStatus();
    } else if (stateToKeep === "settings") {
      for (const id of ["from", "amount", "to"]) $(id).value = result[id];
    }
    void refreshForecast();
    return stateToKeep ? state[stateToKeep] : result;
  } catch (error) {
    globalError(error);
  }
  finally { state.pending--; controls(); updateStorageStatus(); }
}
var busy = () => !!state.pending;
editor = createEditor({ dbCall, translateError, busy, storageUnavailable, statusChanged: updateStorageStatus });
createImportExport({
  dbCall,
  onError: globalError,
  busy,
});
async function refreshForecast() {
  if (!state.store) return;
  const version = ++state.forecastVersion, from = $("from").value, amount = $("amount").value ?? 0, to = $("to").value;
  if (!from || !to || from > to) { globalError("Choose a valid start date and an end date on or after it."); return; }
  try {
    const result = (await state.store.request("forecast", { from, amount, to })).value;
    if (version !== state.forecastVersion) return;
    forecastView.render(result, { from, to, amount });
  } catch (error) { if (version === state.forecastVersion) globalError(`Forecast failed: ${translateError(error)}`); }
}
$("load-example").addEventListener("click", async () => {
  if (state.dataset?.length) { globalError("The example is available only on an empty dataset."); return; }
  await dbCall("exampleDataset", null, "dataset");
});
async function settingsChangeHandler() {
  const next = Object.fromEntries(["from", "amount", "to"].map((id) => [id, $(id).value]));
  await dbCall("setSettings", next, "settings");
  void refreshForecast();
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
