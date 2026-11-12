import { readFile, writeFile } from "node:fs/promises";

const path = "dist-worker/database-worker.js";
let code = await readFile(path, "utf8");

function dedupe(variable) {
  const marker = `${variable}=\`data:application/wasm;base64,`;
  const start = code.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${variable} declaration`);

  const payloadStart = start + marker.length;
  const payloadEnd = code.indexOf("`", payloadStart);
  if (payloadEnd === -1) throw new Error(`Unterminated ${variable} data URI`);

  const dataUri =
    "data:application/wasm;base64," + code.slice(payloadStart, payloadEnd);
  const duplicate = `new URL(\`${dataUri}\`,`;
  const count = code.split(duplicate).length - 1;

  if (count !== 3) {
    throw new Error(`Expected 3 ${variable} URL fallbacks; found ${count}`);
  }

  code = code.replaceAll(duplicate, () => `new URL(${variable},`);
}

dedupe("pglite_default$1");
dedupe("initdb_default");

await writeFile(path, code);
console.log("Deduplicated PGlite and initdb WASM URL fallbacks");
