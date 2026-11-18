import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import("playwright");
const out = resolve("ignore/app-e2e");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(resolve(out, "profile-"));
const events = [];
const errors = [];
const remote = [];
let context;
let serverOutput = "";
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (b) => {
    serverOutput = (serverOutput + b).slice(-12000);
  });
const base = "http://127.0.0.1:4173";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, run) {
  await run();
  events.push({ action: name, verdict: "passed" });
  console.log("PASS", name);
}
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error(serverOutput);
    try {
      if ((await fetch(base)).ok) break;
    } catch { }
    if (i === 99) throw Error("Local server did not start");
    await wait(100);
  }
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(base + "/")) return route.continue();
    remote.push(url);
    return route.abort();
  });
  let page = context.pages()[0];
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = async () => {
    await page
      .locator('#storage-status[data-state="saved"]')
      .waitFor({ timeout: 30000 });
  };
  const settled = async () => {
    await page.waitForFunction(
      () => document.querySelector("#storage-status").dataset.state === "saved",
      {},
      { timeout: 30000 },
    );
  };
  async function importBlock(text) {
    await page.locator("#show-import").click();
    await page.locator("#import-text").fill(text);
    await page.locator("#preview-import").click();
    await page.locator("#apply-import").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#apply-import").isEnabled(),
      true,
      await page.locator("#import-error").textContent(),
    );
    await page.locator("#apply-import").click();
    await page.waitForFunction(
      () => !document.querySelector("#import-dialog").open,
    );
    await settled();
  }
  async function saveFile() {
    const pending = page.waitForEvent("download");
    await page.locator("#save-file").click();
    const download = await pending;
    const path = await download.path();
    return JSON.parse(await readFile(path, "utf8"));
  }
  const field = (index, name) =>
    page
      .locator(`#transaction-rows tr`)
      .nth(index)
      .locator(`[data-field="${name}"]`);
  await step(
    "Keyboard adds an actual snapshot and Enter focuses the next draft",
    async () => {
      await page.locator('[data-view="balances"]').click();
      await field("snapshot", 0, "at").fill("2024-02-29T23:59:59");
      await field("snapshot", 0, "amount").fill("1000");
      await field("snapshot", 0, "amount").press("Enter");
      await settled();
      assert.equal(await page.locator("#snapshot-count").textContent(), "1");
      assert.equal(
        await field("snapshot", 1, "at").evaluate(
          (e) => e === document.activeElement,
        ),
        true,
      );
    },
  );
  await step(
    "Separate CSV importer commits the full scheduled transaction batch",
    async () => {
      await importBlock(
        '2024-03-01,"Opening expense",-100,once,,,household,"quoted, note"\n2024-03-01T12:00:00,"Same-time flow",-20,once,,,,\n2024-03-01T13:00:00,"Later flow",-50,once,,,,'
      );
      await importBlock('2024-03-01T12:00:00,800,"Actual at noon"');
    },
  );
  await step(
    "Actual browser SQL forecast obeys snapshot equality and exact balances",
    async () => {
      await page.locator('[data-view="forecast"]').click();
      await page.locator("#from").fill("2024-03-01");
      await page.locator("#to").fill("2024-03-01");
      await page.locator("#refresh").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#forecast-status")
          .textContent.includes("2024-03-01 through 2024-03-01"),
      );
      assert.equal(
        await page.locator("#closing-amount").textContent(),
        "750.00 EUR",
      );
      assert.deepEqual(
        await page.locator("#forecast-rows tr td:last-child").allTextContents(),
        ["900.00 EUR", "800.00 EUR", "750.00 EUR"],
      );
      const point = page.locator('#forecast-chart circle[data-row-index="1"]');
      const label = page.locator('#forecast-chart text[data-row-index="1"]').first();
      const row = page.locator('#forecast-rows tr[data-row-index="1"]');
      await row.hover();
      assert.equal(await point.evaluate((el) => el.classList.contains("is-hovered")), true);
      assert.equal(await label.evaluate((el) => el.classList.contains("is-hovered")), true);
      await label.hover();
      assert.equal(await row.evaluate((el) => el.classList.contains("is-hovered")), true);
      assert.equal(await point.evaluate((el) => el.classList.contains("is-hovered")), true);
      await point.hover();
      assert.equal(await row.evaluate((el) => el.classList.contains("is-hovered")), true);
      await page.screenshot({
        path: resolve(out, "forecast.png"),
        fullPage: true,
      });
    },
  );
  await step(
    "Unsaved draft is not falsely labelled saved; Escape and Clear cancel it",
    async () => {
      await page.locator('[data-view="transactions"]').click();
      await field("transaction", 3, "name").fill("Uncommitted draft");
      assert.match(
        await page.locator("#storage-status").textContent(),
        /unsaved|not saved/i,
      );
      await field("transaction", 3, "name").press("Escape");
      assert.equal(await field("transaction", 3, "name").inputValue(), "");
      await field("transaction", 3, "notes").fill("Partial");
      await page
        .locator("#transaction-rows tr")
        .last()
        .getByRole("button")
        .click();
    },
  );
  await step(
    "Existing-cell Tab commits right, Shift-Tab returns left, invalid amounts keep focus",
    async () => {
      await field("transaction", 0, "name").fill("Renamed expense");
      await field("transaction", 0, "name").press("Tab");
      await settled();
      assert.equal(
        await field("transaction", 0, "amount").evaluate(
          (e) => e === document.activeElement,
        ),
        true,
      );
      await field("transaction", 0, "amount").press("Shift+Tab");
      assert.equal(
        await field("transaction", 0, "name").evaluate(
          (e) => e === document.activeElement,
        ),
        true,
      );
      await field("transaction", 0, "amount").fill("not money");
      await field("transaction", 0, "amount").press("Tab");
      assert.equal(
        await field("transaction", 0, "amount").evaluate(
          (e) => e === document.activeElement,
        ),
        true,
      );
      assert.equal(
        await field("transaction", 0, "amount").getAttribute("aria-invalid"),
        "true",
      );
      await field("transaction", 0, "amount").press("Escape");
      assert.equal(
        await field("transaction", 0, "amount").inputValue(),
        "-100.00",
      );
    },
  );
  await step(
    "Enter commits existing row and focuses the next row first field",
    async () => {
      await field("transaction", 0, "notes").fill("Saved note");
      await field("transaction", 0, "notes").press("Enter");
      await settled();
      assert.equal(
        await field("transaction", 1, "at").evaluate(
          (e) => e === document.activeElement,
        ),
        true,
      );
    },
  );
  const beforeBatch = await saveFile();
  await step(
    "Invalid late import row reports its location and cannot partially commit",
    async () => {
      await page.locator("#show-import").click();
      await page
        .locator("#import-text")
        .fill("2024-03-03,Good,-1,once,,,,\n2024-03-04,Bad,nope,once,,,,");
      await page.locator("#preview-import").click();
      assert.match(
        await page.locator("#import-error").textContent(),
        /Row 2, column 3/,
      );
      assert.equal(await page.locator("#apply-import").isEnabled(), false);
      await page.screenshot({
        path: resolve(out, "import-error.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Close import", exact: true })
        .click();
      assert.deepEqual(await saveFile(), beforeBatch);
    },
  );
  await step(
    "Existing snapshot conflicts identify the imported row and column without mutation",
    async () => {
      await page.locator("#show-import").click();
      await page
        .locator("#import-text")
        .fill("2024-03-02,600,New\n2024-03-01T12:00:00,800,Conflicting");
      await page.locator("#preview-import").click();
      assert.match(
        await page.locator("#import-error").textContent(),
        /Row 2, column 1/,
      );
      assert.equal(await page.locator("#apply-import").isEnabled(), false);
      await page
        .getByRole("button", { name: "Close import", exact: true })
        .click();
      assert.deepEqual(await saveFile(), beforeBatch);
    },
  );
  await step(
    "Portable file replacement validates first, cancellation preserves data and IDs survive reopen",
    async () => {
      await page.locator("#file-input").setInputFiles({
        name: "bad.budget.json",
        mimeType: "application/json",
        buffer: Buffer.from('{"version":999}'),
      });
      await page.locator("#global-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#global-error").textContent(),
        /version|fields/i,
      );
      assert.deepEqual(await saveFile(), beforeBatch);
      page.once("dialog", (d) => d.dismiss());
      await page.locator("#file-input").setInputFiles({
        name: "cancel.budget.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(beforeBatch)),
      });
      await page.waitForFunction(
        () => document.querySelector("#file-input").value === "",
      );
      assert.deepEqual(await saveFile(), beforeBatch);
      const replacement = structuredClone(beforeBatch);
      page.once("dialog", (d) => d.accept());
      await page.locator("#file-input").setInputFiles({
        name: "restore.budget.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(replacement)),
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#file-status")
          .textContent.includes("Opened restore"),
      );
      await settled();
      assert.deepEqual(
        await saveFile(),
        replacement,
        "File replacement before reload",
      );
      await page.reload();
      await ready();
      assert.deepEqual(
        await saveFile(),
        replacement,
        "File replacement persisted after reload",
      );
    },
  );
  await step(
    "A second writer tab fails visibly rather than racing IndexedDB",
    async () => {
      const second = await context.newPage();
      await second.goto(base);
      await second.waitForFunction(
        () =>
          document.querySelector("#storage-status").textContent ===
          "Local database unavailable",
      );
      assert.match(
        await second.locator("#global-error").textContent(),
        /another tab/i,
      );
      assert.equal(await second.locator("#show-import").isEnabled(), false);
      await second.close();
    },
  );
  await step(
    "Injected IndexedDB write failure is never reported saved and keeps recovery export",
    async () => {
      const saved = await saveFile();
      const worker = page.workers()[0];
      assert.ok(worker, "Database must run in a dedicated worker");
      await worker.evaluate(() => {
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
          if (mode === "readwrite")
            throw new DOMException(
              "Injected quota failure",
              "QuotaExceededError",
            );
          return transaction.call(this, names, mode, ...rest);
        };
      });
      await page.locator('[data-view="transactions"]').click();
      await field("transaction", 0, "amount").fill("-101");
      await field("transaction", 0, "amount").press("Tab");
      await page.waitForFunction(
        () =>
          document.querySelector("#storage-status").dataset.state === "failed",
        {},
        { timeout: 40000 },
      );
      assert.match(
        await page.locator("#storage-status").textContent(),
        /fail|not saved/i,
      );
      assert.equal(
        await field("transaction", 0, "amount").inputValue(),
        "-101",
      );
      assert.deepEqual(await saveFile(), saved);
      await field("transaction", 0, "amount").press("Escape");
      assert.equal(
        await page.locator("#storage-status").getAttribute("data-state"),
        "failed",
      );
      assert.match(
        await page.locator("#storage-status").textContent(),
        /reload/i,
      );
      assert.equal(
        await field("transaction", 0, "amount").getAttribute("readonly"),
        "",
      );
      assert.equal(await page.locator("#show-import").isEnabled(), false);
      await page
        .locator("#transaction-rows tr")
        .last()
        .getByRole("button")
        .click();
      assert.equal(
        await page.locator("#storage-status").getAttribute("data-state"),
        "failed",
      );
      assert.deepEqual(await saveFile(), saved);
    },
  );
  assert.deepEqual(remote, [], "No runtime requests may leave localhost");
  assert.deepEqual(
    errors.filter((error) => error !== "Injected quota failure"),
    [],
    "No unexpected browser errors; the explicit quota injection remains recorded",
  );
} catch (error) {
  events.push({ action: "failure", verdict: "failed", error: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  const report = {
    schemaVersion: 1,
    kind: "browser-automation-transcript",
    tool: "Playwright 1.64.1",
    surface: "web",
    invocation: "npm run test:e2e",
    events,
    errors,
    expectedInjectedErrors: ["Injected quota failure"],
    remoteRequests: remote,
    serverOutput,
    screenshots: [
      "ignore/app-e2e/forecast.png",
      "ignore/app-e2e/import-error.png",
    ],
  };
  await writeFile(
    resolve(out, "automation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (context) await context.close();
  server.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
}
