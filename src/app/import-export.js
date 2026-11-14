import { parseImport, parseDatasetFile, serializeDataset } from "../format-parse.js";

const $ = (id) => document.getElementById(id);
const LIMIT = 8 * 1024 * 1024;
export function createImportExport({ getSnapshot, previewUpsert, bulkUpsert, replaceDataset, onRecords, onSettings, onError, busy }) {
  function invalidate() {
    $("import-preview").textContent = "";
    $("import-error").hidden = true;
    $("apply-import").disabled = true;
  }
  function showError(error, area = "global") {
    console.error(error);
    if (area === "import") { $("import-error").textContent = error.message || String(error); $("import-error").hidden = false; }
    else onError(error);
  }
  $("save-file").addEventListener("click", () => {
    try {
      const { records, settings } = getSnapshot();
      const data = serializeDataset(records, settings);
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const link = document.createElement("a");
      const filename = `ledger-${new Date().toISOString().slice(0, 10)}.budget.json`;
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("file-status").textContent = `Downloaded ${filename}. Only acknowledged records and settings are exported.`;
    } catch (error) { showError(error); }
  });
  $("open-file").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > LIMIT) throw new Error("File exceeds the 8 MiB limit; no data was replaced.");
      const replacement = parseDatasetFile(await file.text());
      const current = getSnapshot();
      if ((current.records.length || JSON.stringify(current.settings) !== JSON.stringify(replacement.settings)) && !window.confirm("Replace all current records and settings with this file?")) return;
      if (busy()) throw new Error("A database operation is in progress. Wait for it to finish and retry.");
      const result = await replaceDataset(replacement);
      onRecords(result.records); onSettings(result.settings);
      $("file-status").textContent = `Opened ${file.name}; records and settings were replaced atomically.`;
    } catch (error) { showError(error); }
    finally { event.target.value = ""; }
  });
  function layout() {
    invalidate();
    const fields = ["at", "name", "amount", "every", "ends_after", "tags", "notes"];
    $("import-layout").textContent = fields.join(" → ");
    $("import-sample").textContent = ["2026-01-01T09:00:00Z", "Salary", "2200.00", "monthly", "", "work;income", "Example only"].map((value) => `"${value}"`).join(",");
  }
  $("show-import").addEventListener("click", () => { layout(); $("import-dialog").showModal(); });
  $("import-text").addEventListener("input", invalidate);
  $("preview-import").addEventListener("click", async () => {
    invalidate();
    try {
      const records = parseImport($("import-text").value);
      if (!records.length) throw new Error("Paste at least one complete record.");
      const { records: current } = getSnapshot();
      const normalized = await previewUpsert([...current, ...records]);
      const accepted = normalized.slice(current.length);
      $("import-preview").textContent = `${accepted.length} records verified ready to import.`;
      $("apply-import").disabled = false;
    } catch (error) { showError(error, "import"); }
  });
  $("apply-import").addEventListener("click", async () => {
    try {
      const rows = parseImport($("import-text").value);
      const { records: current } = getSnapshot();
      const saved = await bulkUpsert([...current, ...rows]);
      onRecords(saved); $("import-dialog").close(); $("import-text").value = ""; invalidate();
      $("file-status").textContent = `Imported ${rows.length} CSV records.`;
    } catch (error) { showError(error, "import"); }
  });
}
