const FIELDS = [
  ["at", "Date", "date"],
  ["name", "Name", "text"],
  ["amount", "Expected amount", "number"],
  ["every", "Every", "text"],
  ["ends_after", "Ends after", "date"],
  ["tags", "Tags", "text"],
  ["notes", "Notes", "text"],
];
const $ = (id) => document.getElementById(id);
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
function inputValue(record, key) { return record?.[key] ?? ""; }
function fromRow(row) {
  return Object.fromEntries(FIELDS.map(([key]) => [key,
    ["at", "every", "ends_after"].includes(key) ? row.inputs[key].value || null : row.inputs[key].value]));
}

export function createEditor({ dbCall, busy, storageUnavailable, statusChanged }) {
  const body = $("transaction-rows");
  const rows = new Set();
  let errorCounter = 0;
  function setBusy() {
    for (const input of body.querySelectorAll("input")) input.readOnly = busy() || storageUnavailable();
    for (const button of body.querySelectorAll(".delete-button")) button.disabled = busy() || storageUnavailable();
    statusChanged();
  }
  function render(records = dbCall("getDataset")) {
    body.replaceChildren(); rows.clear();
    for (const record of records) append(record);
    append(null); filter(); setBusy();
  }
  function append(record) {
    const tr = element("tr");
    const row = { persisted: record, accepted: {}, inputs: {}, failures: new Set(), tr, saving: null };
    tr.editor = row; if (!record) tr.className = "draft-row"; rows.add(row);
    for (const [key, label, type] of FIELDS) {
      const td = element("td"); td.setAttribute("role", "cell");
      const input = element("input"); input.type = type;
      if (key === "amount") { input.inputMode = "decimal"; input.className = "amount-input"; input.placeholder = "0.00"; input.step = "0.01"; }
      input.value = inputValue(record, key); row.accepted[key] = input.value; input.dataset.field = key;
      input.setAttribute("aria-label", `${label} · ${record ? "existing" : "new"} transaction`);
      const error = element("span", "", "cell-error"); error.id = `error-${++errorCounter}-${key}`; error.hidden = true; error.setAttribute("role", "alert");
      input.setAttribute("aria-describedby", error.id); row.inputs[key] = input;
      input.addEventListener("input", () => { filter(); statusChanged(); });
      input.addEventListener("change", () => { void saveCell(row, input); });
      input.addEventListener("keydown", async (event) => {
        if (event.key === "Escape") { input.value = inputValue(row.persisted, key); clearError(row, input); return; }
        if (!["Enter", "Tab"].includes(event.key)) return;
        event.preventDefault(); if (event.repeat) return;
        if (await saveCell(row, input, event.key === "Enter")) {
          if (event.key === "Enter") { const next = tr.nextElementSibling; next?.querySelector("input")?.focus(); }
          else { const list = Object.values(row.inputs), index = list.indexOf(input) + (event.shiftKey ? -1 : 1); list[index]?.focus() ?? row.button.focus(); }
        }
      });
      td.append(input, error); tr.append(td);
    }
    const action = element("td"); action.setAttribute("role", "cell");
    const button = element("button", "×", "delete-button"); button.type = "button"; button.setAttribute("aria-label", record ? "Delete transaction" : "Clear new transaction"); row.button = button;
    button.addEventListener("click", async () => {
      if (row.saving) await row.saving;
      try {
        button.disabled = true;
        if (!record) { for (const input of Object.values(row.inputs)) input.value = ""; return; }
        await dbCall("singleDelete", record, "dataset");
        rows.delete(row); tr.remove();
      } catch (error) { console.error(error); showError(row, row.inputs.name, error.message || String(error)); }
      finally { setBusy(); }
    });
    action.append(button); tr.append(action); body.append(tr); return row;
  }
  function showError(row, input, text) {
    const error = document.getElementById(input.getAttribute("aria-describedby"));
    error.textContent = text || ""; error.hidden = !text;
    if (text) { row.failures.add(input.dataset.field); input.setAttribute("aria-invalid", "true"); input.focus({ preventScroll: true }); }
    else { row.failures.delete(input.dataset.field); input.removeAttribute("aria-invalid"); }
    statusChanged();
  }
  function clearError(row, input) { showError(row, input, ""); }
  async function saveCell(row, input, requireComplete = false) {
    if (row.saving) return row.saving;
    if (storageUnavailable() || busy()) return false;
    const missing = ["at", "name", "amount"].filter((key) => !row.inputs[key].value.trim());
    if (missing.length) {
      if (requireComplete) showError(row, row.inputs[missing[0]], `Complete ${missing.join(", ")} before saving this new row.`);
      return !requireComplete;
    }
    const changed = Object.values(row.inputs).some((control) => control.value !== row.accepted[control.dataset.field]);
    if (!changed) { clearError(row, input); return true; }
    const values = fromRow(row), wasDraft = !row.persisted;
    row.saving = (async () => {
      try {
        const saved = await (row.persisted
          ? dbCall("singleUpdate", { original: row.persisted, replacement: values }, "dataset")
          : dbCall("bulkUpsert", values, "dataset"));
        const persisted = saved.find((record) => record.name === values.name && String(record.at).slice(0, 10) === String(values.at).slice(0, 10));
        if (persisted) {
          row.persisted = persisted;
          for (const [key] of FIELDS) row.accepted[key] = inputValue(persisted, key);
        }
        for (const control of Object.values(row.inputs)) clearError(row, control);
        if (wasDraft) { row.tr.classList.remove("draft-row"); row.button.setAttribute("aria-label", "Delete transaction"); append(null); }
        return true;
      } catch (error) { console.error(error); showError(row, input, error.message || String(error)); return false; }
      finally { row.saving = null; setBusy(); }
    })();
    setBusy(); return row.saving;
  }
  function filter() {
    const query = $("transaction-filter").value.trim().toLocaleLowerCase();
    for (const tr of body.children) {
      const row = tr.editor, text = `${row.inputs.name.value} ${row.inputs.tags.value}`.toLocaleLowerCase();
      tr.hidden = !tr.contains(document.activeElement) && !tr.classList.contains("draft-row") && !text.includes(query);
    }
  }
  $("transaction-filter").addEventListener("input", filter);
  return {
    render,
    setBusy,
    hasUnsavedEdits: () => [...rows].some((row) => Object.values(row.inputs).some((input) => input.value !== row.accepted[input.dataset.field])),
    hasFailures: () => [...rows].some((row) => row.failures.size),
  };
}
