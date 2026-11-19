import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

const origin = "http://127.0.0.1:4173";
const profileRoot = resolve(".ignore/app-e2e");
let profile;
let server;
let context;
let page;
const browserErrors = [];

async function ready() {
  try {
    await page
      .locator('#storage-status[data-state="saved"]')
      .waitFor({ timeout: 12000 });
  } catch (error) {
    const status = await page.locator("#storage-status").textContent();
    const appError = await page.locator("#global-error").textContent();
    throw new Error(
      `App did not become ready; storage status: ${status}; app error: ${appError}; browser errors: ${browserErrors.join(" | ")}`,
      { cause: error },
    );
  }
}
async function settled() {
  try {
    await page.waitForFunction(
      () => document.querySelector("#storage-status").dataset.state === "saved",
      {},
      { timeout: 10000 },
    );
  } catch (error) {
    throw new Error(
      `App did not settle; storage status: ${await page.locator("#storage-status").textContent()}; app error: ${await page.locator("#global-error").textContent()}; browser errors: ${browserErrors.join(" | ")}`,
      { cause: error },
    );
  }
}
async function saveFile() {
  const pending = page.waitForEvent("download");
  await page.locator("#save-file").click();
  return JSON.parse(await readFile(await (await pending).path(), "utf8"));
}
const row = (index, field) =>
  page
    .locator("#transaction-rows tr")
    .nth(index)
    .locator(`[data-field="${field}"]`);
async function enterRow({
  at = "2026-01-01",
  name = "Test row",
  amount = "10",
  every = "",
  ends_after = "",
  tags = "",
  notes = "",
} = {}) {
  for (const [key, value] of Object.entries({
    at,
    name,
    amount,
    every,
    ends_after,
    tags,
    notes,
  }))
    await row(-1, key).fill(value);
  await row(-1, "notes").press("Enter");
  await settled();
}
async function importText(text) {
  await page.locator("#show-import").click();
  await page.locator("#import-text").fill(text);
  await page.locator("#preview-import").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#import-preview").textContent ||
      !document.querySelector("#import-error").hidden,
  );
}

test("confirmed application features", async (suite) => {
  await mkdir(profileRoot, { recursive: true });
  profile = await mkdtemp(resolve(profileRoot, "profile-"));
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
    { stdio: "ignore" },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null)
        throw new Error("Vite preview server exited before starting");
      try {
        if ((await fetch(origin)).ok) break;
      } catch {
        /* server is still starting */
      }
      if (attempt === 99) throw new Error("Vite preview server did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
    });
    page = context.pages()[0];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.addInitScript(() => {
      const setTimeoutWithStartupAllowance = window.setTimeout.bind(window);
      let firstDatabaseWatchdog = true;
      window.setTimeout = (callback, delay, ...args) => {
        if (firstDatabaseWatchdog && delay === 3000) {
          firstDatabaseWatchdog = false;
          delay = 60000;
        }
        return setTimeoutWithStartupAllowance(callback, delay, ...args);
      };
    });
    await page.goto(origin);
    await ready();

    await suite.test(
      "import preview verifies rows without changing saved records",
      async () => {
        const before = await saveFile();
        await importText("2026-01-01,Preview row,10,,,,");
        assert.match(
          await page.locator("#import-preview").textContent(),
          /1 new rows verified ready to import/,
        );
        assert.equal(await page.locator("#apply-import").isEnabled(), true);
        await page
          .getByRole("button", { name: "Close import", exact: true })
          .click();
        assert.deepEqual(await saveFile(), before);
      },
    );

    await suite.test("import appends non-overlapping rows", async () => {
      await importText("2026-01-01,First import,10,,,,");
      await page.locator("#apply-import").click();
      await page.locator("#import-dialog").waitFor({ state: "hidden" });
      await settled();
      await importText("2026-01-02,Second import,20,,,,");
      assert.equal(await page.locator("#apply-import").isEnabled(), true);
      await page.locator("#apply-import").click();
      await page.locator("#import-dialog").waitFor({ state: "hidden" });
      await settled();
      assert.deepEqual(
        (await saveFile()).records.map(({ name }) => name),
        ["First import", "Second import"],
      );
    });

    await suite.test(
      "re-importing an overlapping row updates it without creating a duplicate",
      async () => {
        const before = await saveFile();
        await importText("2026-01-01,First import,99,,,,");
        assert.equal(await page.locator("#apply-import").isEnabled(), true);
        await page.locator("#apply-import").click();
        await page.locator("#import-dialog").waitFor({ state: "hidden" });
        await settled();
        const after = await saveFile();
        assert.equal(after.records.length, before.records.length);
        assert.equal(
          after.records.find(({ name }) => name === "First import").amount,
          "99.00",
        );
      },
    );

    await suite.test(
      "saved file opens with matching records and settings",
      async () => {
        const exported = await saveFile();
        await page.locator("#from").fill("2026-01-01");
        await page.locator("#amount").fill("321.00");
        await page.locator("#to").fill("2026-12-31");
        await page.locator("#to").dispatchEvent("change");
        await settled();
        const replacement = await saveFile();
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#file-input").setInputFiles({
          name: "roundtrip.budget.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(exported)),
        });
        await page.getByText(/Opened roundtrip/).waitFor();
        await settled();
        assert.deepEqual(await saveFile(), exported);
        assert.notDeepEqual(replacement, exported);
      },
    );

    await suite.test(
      "reset clears records and restores the default settings",
      async () => {
        assert.ok((await saveFile()).records.length > 0);
        await page.locator("#reset-app").click();
        await page.locator("#apply-reset").click();
        await page.locator("#reset-dialog").waitFor({ state: "hidden" });
        await settled();
        const defaults = await saveFile();
        assert.deepEqual(defaults.records, []);
        assert.equal(defaults.settings.amount, "123.45");
        const nextYear = new Date(`${defaults.settings.from}T00:00:00Z`);
        nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
        assert.equal(defaults.settings.to, nextYear.toISOString().slice(0, 10));
      },
    );

    await suite.test(
      "each forecast setting updates both ledger and chart",
      async (t) => {
        await enterRow({
          at: "2026-01-02",
          name: "Setting probe",
          amount: "5",
        });
        await page.locator("#from").fill("2026-01-01");
        await page.locator("#to").fill("2026-01-03");
        await page.locator("#amount").fill("10.00");
        await page.locator("#amount").dispatchEvent("change");
        await settled();
        await t.test("From date", async () => {
          await page.locator("#from").fill("2026-01-02");
          await page.locator("#from").dispatchEvent("change");
          await settled();
          assert.equal(
            await page
              .locator("#forecast-rows tr")
              .first()
              .locator("td")
              .first()
              .textContent(),
            "2026-01-02",
          );
          assert.ok(
            await page
              .locator('#forecast-chart circle[data-row-index="1"]')
              .count(),
          );
        });
        await t.test("starting amount", async () => {
          await page.locator("#amount").fill("20.00");
          await page.locator("#amount").dispatchEvent("change");
          await settled();
          assert.equal(
            await page
              .locator("#forecast-rows tr")
              .last()
              .locator("td")
              .nth(1)
              .textContent(),
            "25.00",
          );
          assert.ok(
            await page
              .locator('#forecast-chart circle[data-row-index="1"]')
              .count(),
          );
        });
        await t.test("Through date", async () => {
          await page.locator("#to").fill("2026-01-02");
          await page.locator("#to").dispatchEvent("change");
          await settled();
          assert.equal(
            await page
              .locator("#forecast-rows tr")
              .last()
              .locator("td")
              .first()
              .textContent(),
            "2026-01-02",
          );
          assert.ok(
            await page
              .locator('#forecast-chart circle[data-row-index="1"]')
              .count(),
          );
        });
      },
    );

    await suite.test(
      "editing every transaction column refreshes the ledger and chart",
      async (t) => {
        await page.locator("#from").fill("2026-01-01");
        await page.locator("#amount").fill("10.00");
        await page.locator("#to").fill("2026-01-05");
        await page.locator("#to").dispatchEvent("change");
        await settled();
        await enterRow();
        const fields = [
          ["at", "2026-01-02"],
          ["name", "Changed name"],
          ["amount", "15"],
          ["every", "1 day"],
          ["ends_after", "2026-01-03"],
          ["tags", "changed-tag"],
          ["notes", "changed-note"],
        ];
        for (const [field, value] of fields)
          await t.test(field, async () => {
            await row(0, field).fill(value);
            await row(0, field).press("Tab");
            await settled();
            const expectedName = (await saveFile()).records[0].name;
            assert.ok(
              (await page.locator("#forecast-rows").textContent()).includes(
                expectedName,
              ),
            );
            assert.ok(
              await page
                .locator("#forecast-chart circle[data-row-index]")
                .count(),
            );
          });
      },
    );

    await suite.test(
      "invalid and sub-day repeat intervals show the correct validation message",
      async () => {
        await enterRow();
        for (const interval of ["nonsense", "1 s"]) {
          await row(0, "every").fill(interval);
          await row(0, "every").press("Tab");
          await page
            .locator('[data-field="every"][aria-invalid="true"]')
            .waitFor();
          assert.equal(
            await page
              .locator(
                `#${await row(0, "every").getAttribute("aria-describedby")}`,
              )
              .textContent(),
            "Can't be shorter than a day.  Try things like '1 day', '2 weeks', '6 months', or '1 year'.",
          );
          await row(0, "every").fill("");
          await row(0, "every").press("Tab");
          await settled();
        }
      },
    );

    await suite.test(
      "new rows save when the minimum required fields are complete",
      async () => {
        await enterRow({ at: "2026-01-01", name: "Minimal", amount: "1" });
        assert.equal((await saveFile()).records.length, 1);
      },
    );
    await suite.test("new rows save with an endless repeat", async () => {
      await enterRow({
        at: "2026-01-01",
        name: "Endless",
        amount: "1",
        every: "1 day",
      });
      assert.equal((await saveFile()).records[0].every, "1 day");
    });
    await suite.test("new rows save with a repeat end date", async () => {
      await enterRow({
        at: "2026-01-01",
        name: "Bounded",
        amount: "1",
        every: "1 day",
        ends_after: "2026-01-03",
      });
      assert.equal((await saveFile()).records[0].ends_after, "2026-01-03");
    });
    await suite.test("new rows save all seven columns", async () => {
      await enterRow({
        at: "2026-01-01",
        name: "All columns",
        amount: "1.25",
        every: "1 week",
        ends_after: "2026-02-01",
        tags: "home",
        notes: "monthly review",
      });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries((await saveFile()).records[0]).filter(
            ([key]) => key !== "id",
          ),
        ),
        {
          at: "2026-01-01",
          name: "All columns",
          amount: "1.25",
          every: "7 days",
          ends_after: "2026-02-01",
          tags: "home",
          notes: "monthly review",
        },
      );
    });
  } finally {
    await context?.close();
    server?.kill("SIGTERM");
    await rm(profile, { recursive: true, force: true });
  }
});
