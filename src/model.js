const MAX_BYTES = 8 * 1024 * 1024;
const MAX_UNITS = 10n ** 30n - 1n;
const FIELDS = [
  "at",
  "name",
  "amount",
  "every",
  "ends_after",
  "tags",
  "notes",
];

function fail(path, message) {
  const error = new Error(`${path}: ${message}`);
  error.path = path;
  throw error;
}

function boundedText(text) {
  if (typeof text !== "string") throw new Error("Expected text");
  if (
    text.length > MAX_BYTES ||
    new TextEncoder().encode(text).length > MAX_BYTES
  ) {
    throw new Error("Text exceeds the 8 MiB size limit");
  }
}

function shape(value, fields, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "Expected an object");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  )
    fail(path, "Missing or unknown fields");
}

function string(value, max, path, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  ) {
    fail(
      path,
      `Expected ${required ? "nonempty " : ""}text of at most ${max} characters`,
    );
  }
  return value;
}

export function parseAmount(text = '0') {
  boundedText(text);
  if (!/^-?\$?(\d|,)+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Amount must be decimal text with at most two decimal places",
    );
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const normalizedWhole = whole.replace(/(^0+|\$|,)/g, "") || "0";
  if (normalizedWhole.length > 28)
    throw new Error("Amount exceeds the supported range");
  const units =
    BigInt(normalizedWhole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (units > MAX_UNITS) throw new Error("Amount exceeds the supported range");
  return (negative && units !== 0n ? -units : units).toString();
}

export function formatAmount(units) {
  boundedText(units);
  if (!/^-?\d+$/.test(units))
    throw new Error("Units must be an integer string");
  const digits = units.replace(/^-?0*/, "") || "0";
  if (digits.length > 30) throw new Error("Amount exceeds the supported range");
  const value = BigInt(digits) * (units.startsWith("-") ? -1n : 1n);
  const absolute = value < 0n ? -value : value;
  if (absolute > MAX_UNITS)
    throw new Error("Amount exceeds the supported range");
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function money(value, path) {
  try {
    return formatAmount(parseAmount(value));
  } catch (error) {
    fail(path, error.message);
  }
}

function date(value, path, dateOnly = false) {
  if (!(typeof value === "string" || value instanceof Date || value === null))
    fail(path, `Expected string, Date object, or null; got ${value}`);
  const normDate = (value instanceof Date) ? value.toISOString() : value;
  try {
    return dateOnly ? normDate : Temporal.PlainDate.from(normDate.substr(0, 10)).toString();
  } catch (error) {
    fail(path, error.message);
  }
}

export function emptyDataset() {
  return {
    version: 1,
    id: globalThis.crypto.randomUUID(),
    transactions: [],
  };
}

export function validateDataset(input) {
  console.info('raw input', input)
  // Bound even non-file callers before inspecting or copying their records.
  let text;
  try {
    text = JSON.stringify(input);
  } catch {
    throw new Error("Dataset must contain JSON-compatible values");
  }
  console.info('done stringifying', text);
  boundedText(text);
  if (!Array.isArray(input)) fail("Expected an array");
  const transactions = Array.from(input).map((record, index) => {
    const path = `input[${index}]`;
    console.info('path', path, record, FIELDS);
    shape(record, FIELDS, path);
    const at = date(record.at, `${path}.at`);
    const name = string(record.name, 200, `${path}.name`, true);
    const amount = money(record.amount, `${path}.amount`);
    const tags = (Array.isArray(record.tags) ? record.tags : JSON.parse(record.tags || "[]"))
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    if (record.ends_after !== null && record.every === null)
      fail(`${path}.ends_after`, "'Ends after' is only allowed on recurring transactions");
    const ends_after =
      record.ends_after === "" ? "" : date(record.ends_after, `${path}.ends_after`, true);
    if (ends_after && ends_after < at.slice(0, 10))
      fail(`${path}.ends_after`, "'Ends after' precedes transaction date");
    if (tags.length > 20)
      fail(`${path}.tags`, "Expected at most 20 tags");
    if (new Set(tags).size !== tags.length)
      fail(`${path}.tags`, "Duplicate tags");
    return {
      at,
      name,
      amount,
      every: record.every,
      ends_after,
      tags,
      notes: string(record.notes, 2000, `${path}.notes`),
    };
  });
  return transactions;
}

function importError(row, column, message) {
  throw new Error(`Row ${row}, column ${column}: ${message}`);
}

function importRows(text) {

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
  let endedRow = false;
  const pushField = () => {
    row.push(field);
    field = "";
    state = "start";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    endedRow = false;
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else field += char;
      continue;
    }
    if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushField();
      rows.push(row);
      row = [];
      endedRow = true;
    } else if (char === '"' && state === "start") {
      state = "quoted";
    } else {
      if (state === "closed" || char === '"')
        importError(rows.length + 1, row.length + 1, "Malformed quoting");
      field += char;
      state = "unquoted";
    }
  }
  if (state === "quoted")
    importError(rows.length + 1, row.length + 1, "Unterminated quoted field");
  if (!endedRow) {
    pushField();
    rows.push(row);
  }
  return rows;
}

export function parseImport(text) {
  boundedText(text);
  console.info(text);
  if (!text.length) importError(1, 1, "Empty input");
  const rows = importRows(text);
  const records = rows.map((row, index) => {
    if (row.length === 1 && row[0] === "")
      importError(index + 1, 1, "Blank row");
    if (row.length !== FIELDS.length)
      importError(
        index + 1,
        Math.min(row.length + 1, FIELDS.length + 1),
        `Expected ${FIELDS.length} columns, received ${row.length}`,
      );
    const record = Object.fromEntries(FIELDS.map((key, i) => [key, row[i]]));
    record.every ||= "once";
    record.tags = record.tags === "" ? [] : record.tags.split(";");

    return { id: globalThis.crypto.randomUUID(), ...record };
  });
  try {
    const dataset = records;
    console.log(dataset);
    return validateDataset(dataset);
  } catch (error) {
    const match = /^(?:transactions)\[(\d+)\](?:\.(\w+))?/.exec(
      error.path || "",
    );
    if (match)
      importError(
        Number(match[1]) + 1,
        Math.max(1, FIELDS.indexOf(match[2]) + 1),
        error.message,
      );
    throw error;
  }
}

export function serializeDataset(dataset) {
  const text = JSON.stringify(validateDataset(dataset));
  boundedText(text);
  return text;
}

export function parseDatasetFile(text) {
  boundedText(text);
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Invalid dataset JSON");
  }
  return validateDataset(input);
}
