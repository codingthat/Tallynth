import { validateDataset } from "./model.js";
import Worker from './database-worker.js?worker&inline';

// Node tests use the same database implementation directly. Browser SQL and
// persistence run in one dedicated worker, never on the keyboard/DOM thread.
export async function openStore({
  dataDir = "idb://ezmonthcast-v8",
  lock = true,
} = {}) {
  if (!lock) throw new Error("Browser storage requires a single-writer lock.");
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely lock local data. Use a current desktop browser on localhost.",
    );
  let release;
  await new Promise((resolve, reject) => {
    navigator.locks
      .request(
        `budget-forecaster:${dataDir}`,
        { ifAvailable: true },
        async (held) => {
          if (!held) {
            reject(
              new Error(
                "This budget is already open in another tab. Close that tab before editing here.",
              ),
            );
            return;
          }
          await new Promise((done) => {
            release = done;
            resolve();
          });
        },
      )
      .catch(reject);
  });
  let worker;
  try {
    worker = new Worker();
  } catch (error) {
    release();
    throw error;
  }
  const pending = new Map();
  let sequence = 0;
  let dataset;
  let health = "healthy";
  let unavailable = false;
  function failAll(message) {
    unavailable = true;
    health = "failed";
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(message));
    }
    pending.clear();
  }
  function request(method, value) {
    if (unavailable)
      return Promise.reject(
        new Error(
          "The database worker is unavailable. Export your last confirmed data and reload.",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () =>
          failAll(
            "The database stopped responding. Changes are not confirmed saved. Export the last confirmed dataset and reload before editing.",
          ),
        method === "forecast" ? 6000 : 3000,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, method, value });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  worker.onmessage = ({ data }) => {
    console.info(data);
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.health) health = data.health;
    if (data.error) {
      call.reject(new Error(data.error));
      return;
    }
    try {
      if (data.dataset) dataset = validateDataset(data.dataset);
    } catch (error) {
      call.reject(error);
      failAll(
        "Database response validation failed. Export your last confirmed data and reload.",
      );
      return;
    }
    call.resolve(data.value);
  };
  worker.onerror = (event) => {
    failAll(
      `Database worker failed. Changes are not confirmed saved. ${event.message}`,
    );
  };
  try {
    await request("open", { dataDir });
    return {
      getDataset: () => structuredClone(dataset),
      get health() {
        return health;
      },
      bulkUpsert: (value) => request("bulkUpsert", value),
      singleUpdate: (value) => request("singleUpdate", value),
      singleDelete: (value) => request("singleDelete", value),
      forecast: (value) => request("forecast", value),
      async close() {
        try {
          if (!unavailable) await request("close");
        } finally {
          unavailable = true;
          health = "closed";
          worker.terminate();
          release();
        }
      },
    };
  } catch (error) {
    worker.terminate();
    release();
    throw error;
  }
}
