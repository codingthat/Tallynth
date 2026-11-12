import "./styles.css";
import {
  validateDataset,
  parseAmount,
  parseImport,
  serializeDataset,
  parseDatasetFile,
} from "./model.js";
import { openStore } from "./store.js";

const $ = (id) => document.getElementById(id);
const state = {
  store: null,
  dataset: null,
  settings: null,
  pending: 0,
  queue: Promise.resolve(),
  forecastVersion: 0,
  preview: null,
  saveError: null,
};
const definitions = [
  ["at", "Date", "date"],
  ["name", "Name", "text"],
  ["amount", "Expected amount", "number"],
  ["every", "Every", "text"],
  ["ends_after", "Ends after", "date"],
  ["tags", "Tags separated by semicolons", "text"],
  ["notes", "Notes", "text"],
];
const bodies = $("transaction-rows");

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function globalError(error) {
  $("global-error").textContent = error ? message(error) : "";
  $("global-error").hidden = !error;
}
function isEmpty(dataset = state.dataset) {
  return dataset && !dataset.length;
}
function dateLabel(at) {
  return at ? at.toISOString().slice(0, 10) : "Not reached";
}
function storageUnavailable() {
  return Boolean(state.store) && state.store.health !== "healthy";
}
function hasUnsavedEdits() {
  return Object.values(bodies).some((body) =>
    [...body.children].some(({ editor: row }) =>
      Object.entries(row.inputs).some(
        ([key, input]) =>
          input.value !== row.accepted[key] &&
          input.value !== inputValue(row.persisted, key),
      ),
    ),
  );
}
function updateStorageStatus() {
  if (!state.dataset) return;
  const failedCell = Object.values(bodies).some((body) =>
    [...body.children].some(({ editor: row }) => row.failures.size),
  );
  let status = "saved",
    text = "Saved in this browser";
  if (storageUnavailable()) {
    status = "failed";
    text =
      "Storage failed or closed · Save file to recover confirmed records, then reload";
  } else if (state.pending) {
    status = "saving";
    text = "Saving to this browser…";
  } else if (state.saveError || failedCell) {
    status = "failed";
    text = "Save failed · check unsaved edits or error";
  } else if (hasUnsavedEdits()) {
    status = "unsaved";
    text = "Unsaved edits · incomplete drafts are not saved";
  }
  $("storage-status").textContent = text;
  $("storage-status").dataset.state = status;
}
function controls() {
  const available = Boolean(state.store) && !state.pending;
  const writable = available && !storageUnavailable();
  for (const id of [
    "save-file",
    "open-file",
    "show-import",
    "load-example",
  ])
    $(id).disabled = id === "save-file" ? !available : !writable;
  $("apply-import").disabled = !writable || !state.preview;
  $("preview-import").disabled = !writable;
  $("main").setAttribute("aria-busy", String(Boolean(state.pending)));
  for (const input of document.querySelectorAll(".editor-table input"))
    input.readOnly = Boolean(state.pending) || storageUnavailable();
  for (const select of document.querySelectorAll(".editor-table select"))
    select.setAttribute(
      "aria-disabled",
      String(Boolean(state.pending) || storageUnavailable()),
    );
  for (const button of document.querySelectorAll(".delete-button"))
    button.disabled =
      Boolean(state.pending) ||
      (storageUnavailable() && Boolean(button.closest("tr").editor.id));
  if (state.dataset) {
    $("empty-state").hidden = !isEmpty();
  }
}
function enqueue(operation) {
  state.pending += 1;
  controls();
  updateStorageStatus();
  const result = state.queue.then(() => {
    if (storageUnavailable())
      throw new Error(
        "Storage is unavailable. Save file to recover confirmed records, then reload.",
      );
    return operation();
  });
  state.queue = result.catch(() => {});
  return result
    .then(
      (value) => {
        if (!storageUnavailable()) state.saveError = null;
        return value;
      },
      (error) => {
        state.saveError = message(error);
        throw error;
      },
    )
    .finally(() => {
      state.pending -= 1;
      controls();
      updateStorageStatus();
    });
}
async function commitBulk(mutate) {
  return enqueue(async () => {
    const next = mutate(state.store.getDataset());
    state.dataset = await state.store.bulkUpsert(validateDataset(next));
    globalError(null);
    void refreshForecast();
    return state.dataset;
  });
}
async function commitSingle(original, replacement) {
  return enqueue(async () => {
    state.dataset = await state.store.singleUpdate({original, replacement});
    globalError(null);
    void refreshForecast();
    return state.dataset;
  });
}
async function deleteSingle(original) {
  return enqueue(async () => {
    state.dataset = await state.store.singleDelete(original);
    globalError(null);
    void refreshForecast();
    return state.dataset;
  });
}
function inputValue(record, key) {
  if (!record || !record[key]) return "";
  if (key === "at" || key === "ends_after") return record[key].slice(0, 10);
  if (key === "tags") return record.tags.join("; ");
  return record[key] ?? "";
}
function fieldValue(key, value) {
  if (key === "tags")
    return value
      .split(";")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
  if (["at", "every", "ends_after"].includes(key))
    return value === "" ? null : value;
  return value;
}
function recordFromRow(row) {
  const record = {};
  for (const [key] of definitions)
    record[key] = fieldValue(key, row.inputs[key].value);
  return record;
}
function incompleteFields(row) {
  const keys = ["at", "name", "amount"];
  return keys.filter((key) => !row.inputs[key].value.trim());
}
function cellError(row, input, text) {
  input.removeAttribute("aria-invalid");
  const error = $(input.getAttribute("aria-describedby"));
  error.textContent = text || "";
  error.hidden = !text;
  row.failures.delete(input.dataset.field);
  if (text) {
    row.failures.add(input.dataset.field);
    input.setAttribute("aria-invalid", "true");
    input.focus({ preventScroll: true });
  }
  updateStorageStatus();
}
function focusCell(input) {
  if (!input?.isConnected) return;
  const row = input.closest("tr");
  if (row) row.hidden = false;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function applyFilter() {
  const query = $("transaction-filter").value.trim().toLocaleLowerCase();
  for (const tr of bodies.children) {
    const row = tr.editor;
    const name = row.inputs.name.value;
    const tags = row.inputs.tags.value;
    // An active edit and the bottom draft stay reachable even when they do not match.
    tr.hidden = Boolean(
      !tr.contains(document.activeElement) &&
      !`${name} ${tags}`.toLocaleLowerCase().includes(query),
    );
  }
}
async function saveCell(row, input, requireComplete = false) {
  if (row.saving) {
    if (!(await row.saving)) return false;
    return saveCell(row, input, requireComplete);
  }
  if (storageUnavailable()) {
    controls();
    updateStorageStatus();
    return false;
  }
  const key = input.dataset.field;
  if (key === "amount" && input.value.trim()) {
    try {
      parseAmount(input.value.trim());
    } catch (error) {
      cellError(row, input, message(error));
      return false;
    }
  }
  const missing = incompleteFields(row);
  if (missing.length) {
    if (requireComplete) {
      cellError(
        row,
        row.inputs[missing[0]],
        `Complete ${missing.join(", ")} before saving this new row.`,
      );
      return false;
    }
    cellError(row, input, null);
    return true;
  } else if (
    input.value === row.accepted[key] ||
    input.value === inputValue(row.persisted, key)
  ) {
    cellError(row, input, null);
    return true;
  }
  const accepted = Object.fromEntries(
    Object.entries(row.inputs).map(([field, control]) => [
      field,
      control.value,
    ]),
  );
  const raw = input.value;
  const draft = row.tr.classList.contains("draft-row");
  row.saving = (async () => {
    try {
      const saved = await commitSingle(row.accepted, recordFromRow(row));
      if (draft) {
        row.accepted = accepted;
        for (const control of Object.values(row.inputs))
          cellError(row, control, null);
        row.tr.classList.remove("draft-row");
        row.deleteButton.textContent = "Delete";
        row.deleteButton.setAttribute(
          "aria-label",
          "Delete transaction",
        );
        appendRow(null);
      } else row.accepted[key] = raw;
      row.persisted = saved.find((item) => item.id === row.id);
      cellError(row, input, null);
      return true;
    } catch (error) {
      if (!storageUnavailable()) state.saveError = null;
      console.error('forget why breakpoints fail in this case', error);
      cellError(row, input, message(error));
      return false;
    } finally {
      row.saving = null;
    }
  })();
  return row.saving;
}
function appendRow(record) {
  const tr = element("tr");
  const row = {
    id: record?.id ?? null,
    persisted: record,
    inputs: {},
    accepted: {},
    failures: new Set(),
    tr,
    saving: null,
  };
  tr.editor = row;
  if (!record) tr.className = "draft-row";
  const domId = crypto.randomUUID();
  for (const [key, label, type] of definitions) {
    const td = element("td");
    const input = element("input");
    input.type = type;
    if (key === "amount") {
      input.inputMode = "decimal";
      input.className = "amount-input";
      input.placeholder = "0.00";
      input.step = "0.01";
    }
    input.value = inputValue(record, key);
    row.accepted[key] = input.value;
    input.dataset.field = key;
    input.setAttribute(
      "aria-label",
      `${label} · ${record ? "existing" : "new"} transaction`,
    );
    const error = element("span", "", "cell-error");
    error.id = `error-${domId}-${key}`;
    error.hidden = true;
    error.setAttribute("role", "alert");
    input.setAttribute("aria-describedby", error.id);
    row.inputs[key] = input;
    input.addEventListener("input", updateStorageStatus);
    input.addEventListener("pointerdown", (event) => {
      if ((state.pending || storageUnavailable()) && type === "select")
        event.preventDefault();
    });
    input.addEventListener("change", () => {
      void saveCell(row, input);
    });
    input.addEventListener("keydown", async (event) => {
      if (
        (state.pending || storageUnavailable()) &&
        !["Tab", "Enter", "Escape"].includes(event.key)
      ) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (row.saving) return;
        input.value = inputValue(row.persisted, key);
        cellError(row, input, null);
        return;
      }
      if (event.key !== "Tab" && event.key !== "Enter") return;
      // Keep focus until validation and the atomic save finish; never race the next cell.
      event.preventDefault();
      if (event.repeat) return;
      const saved = await saveCell(row, input, event.key === "Enter");
      if (!saved) return;
      const fields = Object.values(row.inputs);
      if (event.key === "Enter") {
        let next = tr.nextElementSibling;
        while (next?.hidden) next = next.nextElementSibling;
        if (next) focusCell(Object.values(next.editor.inputs)[0]);
      } else {
        const index = fields.indexOf(input) + (event.shiftKey ? -1 : 1);
        if (index >= 0 && index < fields.length) focusCell(fields[index]);
        else if (event.shiftKey) {
          let previous = tr.previousElementSibling;
          while (previous?.hidden) previous = previous.previousElementSibling;
          if (previous) focusCell(Object.values(previous.editor.inputs).at(-1));
          else
            focusCell( $("transaction-filter") );
        } else focusCell(row.deleteButton);
      }
    });
    td.append(input, error);
    tr.append(td);
  }
  const action = element("td");
  const remove = element(
    "button",
    record ? "Delete" : "Clear",
    "delete-button",
  );
  remove.type = "button";
  remove.setAttribute(
    "aria-label",
    `${record ? "Delete" : "Clear new"} transaction`,
  );
  row.deleteButton = remove;
  remove.addEventListener("click", async () => {
    if (row.saving) await row.saving;
    try {
      remove.disabled = true;
      await deleteSingle(recordFromRow(row));
      const next = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove();
      updateStorageStatus();
      if (next) focusCell(next.editor.inputs.at);
    } catch (error) {
      globalError(error);
      controls();
    }
  });
  action.append(remove);
  tr.append(action);
  bodies.append(tr);
  return row;
}
function renderEditors() {
  bodies.replaceChildren();
  for (const record of state.dataset) appendRow(record);
  appendRow(null);
  applyFilter();
  controls();
  updateStorageStatus();
}
function showView(view) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
    $(`view-${button.dataset.view}`).hidden = !active;
  }
}
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => showView(button.dataset.view));
$("transaction-filter").addEventListener("input", applyFilter);

function svgNode(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  return node;
}
function drawChart(rows) {
  const chart = $("forecast-chart");
  for (const node of [...chart.children])
    if (!["title", "desc"].includes(node.localName)) node.remove();
  if (!rows.length) return;
  // Numbers are used only to position this illustrative SVG, never for displayed money.
  const points = rows.map((row) => ({
    x: Date.parse(row.at),
    y: parseAmount(row.sum) * 100,
    row
  }));
  let minX = points[0].x,
    maxX = points[0].x,
    minY = 0,
    maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const chartWidth = chart.getBoundingClientRect().width,
    chartHeight = chart.getBoundingClientRect().height,
    range = maxY - minY;
  if (!Number.isFinite(range)) return;
  const x = (value) => 0 + ((value - minX) / (maxX - minX || 1)) * chartWidth;
  const y = (value) => chartHeight - ((value - minY) / (range || 1)) * chartHeight;
  chart.append(
    svgNode("line", {
      x1: 0,
      x2: chartWidth,
      y1: y(0),
      y2: y(0),
      class: "zero-line",
    }),
  );
  // A step path preserves event jumps instead of inventing an interpolated cashflow.
  let path = `M ${x(points[0].x)} ${y(points[0].y)}`;
  for (const point of points.slice(1))
    path += ` H ${x(point.x)} V ${y(point.y)}`;
  chart.append(
    svgNode("path", { d: path, class: "balance-line", fill: "none" }),
  );
  let prevY = null;
  for (const point of points.length > 200 ? [...points.slice(0, 100), ...points.slice(-100)] : points) {
    const cx = x(point.x),
          cy = y(point.y);
    const classList = point.y < 0 ? "minus" : "plus";
    const textElement = svgNode("text", {
      class: `${classList} ${point.y > prevY ? "up" : "down"}`,
      x: cx,
      y: cy,
    });
    textElement.textContent = point.row.name;
    chart.append(
      svgNode("circle", { class: classList, cx, cy }),
      textElement,
    );
    if (prevY !== null && ((point.y >= 0 && prevY <= 0) || (point.y <= 0 && prevY >= 0))) {
      const zy = cy > chartHeight / 2 ? chartHeight - 20 : 20;
      const zeroLabel = svgNode("text", {
        class: `${point.y > prevY ? "plus" : "minus"} ${cy > chartHeight / 2 ? "down" : "up"}`,
        x: cx,
        y: zy,
      });
      zeroLabel.textContent = Temporal.PlainDate.from(point.row.at.toISOString().substr(0, 10)).toString();
      chart.append(zeroLabel, svgNode("line", {
        x1: cx,
        x2: cx,
        y1: cy,
        y2: zy,
        class: "zero-line",
      }),);
    }
    prevY = point.y;
  }
}
async function refreshForecast() {
  if (!state.store) return;
  const version = ++state.forecastVersion;
  const from = $("from").value,
    amount = $("amount").value ?? 0,
    to = $("to").value;
  if (!from || !to || from > to) {
    $("forecast-status").textContent =
      "Choose a valid start date and an end date on or after it.";
    return;
  }
  $("forecast-status").textContent = "Calculating from the local database…";
  try {
    const result = await state.store.forecast({ from, amount, to });
    if (version !== state.forecastVersion) return;
    $("anchor-amount").textContent = new Intl.NumberFormat().format(amount);
    $("anchor-date").textContent = result.anchor
      ? dateLabel(result.anchor.at)
      : "Add an actual balance to establish an anchor";
    const last = result.rows.at(-1);
    const nf = new Intl.NumberFormat(), formatMoney = (t) => nf.format(parseAmount(t));
    $("closing-amount").textContent = last ? formatMoney(last.sum) : "—";
    $("closing-date").textContent = last
      ? dateLabel(last.at)
      : "No events in this horizon";
    $("forecast-row-count").textContent = `· ${result.rows.length} rows`;
    $("forecast-rows").replaceChildren();
    let startedPositive = amount > 0, firstCrossDate = null, isFirstRow = true;
    for (const row of result.rows) {
      const tr = element("tr");
      tr.append(
        element("td", dateLabel(row.at)),
        element("td", formatMoney(row.sum), "numeric"),
        element("td", `${row.name} (${formatMoney(row.amount)})`),
      );
      $("forecast-rows").append(tr);
      if (firstCrossDate === null && !isFirstRow) {
        const parsedSum = parseAmount(row.sum);
        if (startedPositive) {
          if (parsedSum <= 0) {
            firstCrossDate = row.at;
          }
        } else {
          if (parsedSum >= 0) {
            firstCrossDate = row.at;
          }
        }
      } else {
        isFirstRow = false;
      }
    }
    if (firstCrossDate !== null) {
      $("first-crosses-zero").textContent = dateLabel(firstCrossDate);
    }
    if (!result.rows.length) {
      const td = element(
        "td",
        "No forecast rows in this date range. Add records or adjust the horizon.",
        "empty-table",
      );
      td.colSpan = 3;
      const tr = element("tr");
      tr.append(td);
      $("forecast-rows").append(tr);
    }
    drawChart(result.rows);
    $("forecast-status").textContent =
      `${result.rows.length} exact ledger rows · after ${from} through ${to}`;
  } catch (error) {
    if (version !== state.forecastVersion) return;
    $("forecast-status").textContent =
      `Forecast failed: ${message(error)}. The displayed ledger, if any, is from the previous successful refresh.`;
  } finally {
    controls();
    updateStorageStatus();
  }

  function formatMoney(last) {
    return new Intl.NumberFormat().format(parseAmount(last.sum));
  }
}
$("save-file").addEventListener("click", () => {
  try {
    const data = serializeDataset(state.dataset);
    const url = URL.createObjectURL(
      new Blob([data], { type: "application/json" }),
    );
    const link = element("a");
    const filename = `ledger-${new Date().toISOString().slice(0, 10)}.budget.json`;
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("file-status").textContent =
      `Portable file download requested: ${filename}. Only confirmed records are exported; uncommitted edits and drafts are excluded. Confirm it was saved by your browser; local autosave is not a backup.`;
  } catch (error) {
    globalError(error);
  }
});
$("open-file").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024)
      throw new Error(
        "File exceeds the 8 MiB limit. Choose a smaller .budget.json file; no data was read or replaced.",
      );
    const replacement = parseDatasetFile(await file.text());
    if (
      !isEmpty() &&
      !window.confirm(
        "Replace all current records and settings with this file? You can Undo this replacement.",
      )
    )
      return;
    await commitBulk(() => replacement);
    renderEditors();
    $("file-status").textContent =
      `Opened ${file.name}. The validated file is now the local working copy.`;
  } catch (error) {
    globalError(error);
  } finally {
    event.target.value = "";
  }
});
$("load-example").addEventListener("click", async () => {
  try {
    await commitBulk((dataset) => {
      if (!isEmpty(dataset))
        throw new Error(
          "The synthetic example is available only on an empty dataset.",
        );
      const day = $("from").value;
      dataset.push(
        {
          at: `${day}`,
          name: "Income",
          amount: "1000.00",
          every: "2 weeks",
          ends_after: Temporal.Now.plainDateISO().add({ months: 3 }).toString(),
          tags: ["example"],
          notes: "Example biweekly income",
        },
        {
          at: `${day}`,
          name: "Rent",
          amount: "-1100.00",
          every: "1 month",
          ends_after: null,
          tags: ["example", "housing"],
          notes: "Example monthly expense",
        },
      );
      return dataset;
    });
    renderEditors();
  } catch (error) {
    globalError(error);
  }
});
function invalidatePreview() {
  state.preview = null;
  $("import-preview").textContent = "";
  $("import-error").hidden = true;
  controls();
}
function validateImportAppend(dataset, records) {
  const offset = dataset.length;
  const combined = [ ...dataset, ...records ];
  try {
    return validateDataset(combined);
  } catch (error) {
    const match = /^\[(\d+)\](?:\.(\w+))?/.exec( error.path || "", );
    if (match) {
      const index = Number(match[1]);
      if (index >= offset && index < offset + records.length) {
        const column = Math.max(
          1,
          definitions.findIndex(([field]) => field === match[2]) + 1,
        );
        const detail = message(error).replace(`${error.path}: `, "");
        throw new Error(
          `Row ${index - offset + 1}, column ${column}: ${detail}`,
        );
      }
    }
    throw error;
  }
}
function importLayout() {
  invalidatePreview();
  const fields = [
          "at",
          "name",
          "amount",
          "every",
          "ends_after",
          "tags",
          "notes",
        ];
  $("import-layout").textContent = fields.join(" → ");
  const values =[
          "2026-01-01T09:00:00Z",
          "Salary",
          "2200.00",
          "monthly",
          "",
          "work;income",
          "Example only",
        ];
  $("import-sample").textContent = values
    .map((value) => `"${value}"`)
    .join(",");
}
$("show-import").addEventListener("click", () => {
  importLayout();
  $("import-dialog").showModal();
});
$("import-text").addEventListener("input", invalidatePreview);
$("preview-import").addEventListener("click", () => {
  invalidatePreview();
  try {
    const records = parseImport(
      $("import-text").value
    );
    if (!records.length) throw new Error("Paste at least one complete record.");
    validateImportAppend(state.store.getDataset(), records);
    state.preview = records;
    $("import-preview").textContent =
      `${records.length} transactions validated and ready to append. No data has changed.`;
    controls();
  } catch (error) {
    $("import-error").textContent = message(error);
    $("import-error").hidden = false;
  }
});
$("apply-import").addEventListener("click", async () => {
  const preview = state.preview;
  if (!preview) return;
  try {
    await commitBulk((dataset) =>
      validateImportAppend(dataset, preview),
    );
    renderEditors();
    invalidatePreview();
    $("import-text").value = "";
    $("import-dialog").close();
    $("file-status").textContent =
      `Imported ${preview.length} records as one undoable batch.`;
  } catch (error) {
    $("import-error").textContent = message(error);
    $("import-error").hidden = false;
  }
});
async function settingsChangeHandler(e) {
  console.info(`setting ${e.target.id} to ${e.target.value} and saving it`);
  state.settings[e.target.id] = e.target.value;
  state.store.setSettings(state.settings);
  void refreshForecast();
};
const settingIds = ["from", "amount", "to"];
for (const id of settingIds) {
  $(id).addEventListener("change", settingsChangeHandler);
}
try {
  state.store = await openStore();
  const today = Temporal.Now.plainDateISO();
  state.settings = {
    from: today.toString(),
    amount: 123.45,
    to: today.add({ years: 1 }).toString(),
    ...(await state.store.getSettings()),
  };
  for (const id of settingIds) {
    $(id).value = state.settings[id];
  }
  state.dataset = state.store.getDataset();
  // Empty records are intentional: the user alone chooses whether to add the synthetic example.
  renderEditors();
  controls();
  $("storage-status").textContent = "Local database ready";
  $("storage-status").dataset.state = "saved";
  void refreshForecast();
} catch (error) {
  $("storage-status").textContent = "Local database unavailable";
  $("storage-status").dataset.state = "failed";
  console.error(error);
  globalError(
    `Could not open local storage: ${message(error)}. No changes have been saved. Close other writer tabs or use a browser that supports the required local storage.`,
  );
  controls();
}
window.addEventListener("pagehide", () => {
  if (state.store) void state.store.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
