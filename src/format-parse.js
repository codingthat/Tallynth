const FIELDS = ["at", "name", "amount", "every", "ends_after", "tags", "notes"];

function csvRows(text) {
  const rows = [];
  let row = [], field = "", mode = "start", ended = false;
  const push = () => { row.push(field); field = ""; mode = "start"; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]; ended = false;
    if (mode === "quoted") {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else mode = "closed";
      } else field += ch;
      continue;
    }
    if (ch === ",") push();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push(); rows.push(row); row = []; ended = true;
    } else if (ch === '"' && mode === "start") mode = "quoted";
    else {
      if (mode === "closed" || ch === '"') throw new Error(`Row ${rows.length + 1}, column ${row.length + 1}: Malformed quoting`);
      field += ch; mode = "unquoted";
    }
  }
  if (mode === "quoted") throw new Error(`Row ${rows.length + 1}, column ${row.length + 1}: Unterminated quoted field`);
  if (!ended) { push(); rows.push(row); }
  return rows;
}

export function parseImport(text) {
  if (!text) throw new Error("Row 1, column 1: Empty input");
  return csvRows(text).map((row, i) => {
    if (row.length !== FIELDS.length) throw new Error(`Row ${i + 1}, column ${Math.min(row.length + 1, FIELDS.length + 1)}: Expected ${FIELDS.length} columns, received ${row.length}`);
    const record = Object.fromEntries(FIELDS.map((field, index) => [field, row[index]]));
    record.every ||= null;
    record.ends_after ||= null;
    return record;
  });
}

export function parseDatasetFile(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid dataset JSON syntax"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "records,settings")
    throw new Error("Expected a portable JSON envelope with records and settings");
  if (!Array.isArray(value.records)) throw new Error("Portable file records must be an array");
  if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings) || Object.keys(value.settings).sort().join(",") !== "amount,from,to")
    throw new Error("Portable file settings must contain from, amount, and to");
  const recordFields = ["amount", "at", "ends_after", "every", "name", "notes", "tags"];
  for (const [index, record] of value.records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join(",") !== recordFields.join(","))
      throw new Error(`Record ${index + 1} must contain the supported record fields`);
  }
  return { records: value.records, settings: value.settings };
}
