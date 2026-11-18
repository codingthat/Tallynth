// Node tests use the same database implementation directly. Browser SQL and
// persistence run in one dedicated worker, never on the keyboard/DOM thread.

export async function openStore({
  dataDir = "idb://ezmonthcast-v15",
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
            const error = new Error("This budget is already open in another tab.");
            error.name = "DatabaseAlreadyOpenError";
            reject(error);
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
    if (typeof window.__DATABASE_WORKER_SOURCE__ !== "undefined") {
      worker = new Worker(URL.createObjectURL(
        new Blob([window.__DATABASE_WORKER_SOURCE__], { type: 'text/javascript' })
      ));
    } else {
      worker = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
    }
  } catch (error) {
    release();
    throw error;
  }
  const pending = new Map();
  let sequence = 0;
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
            "The database stopped responding.",
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
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.health) health = data.health;
    if (data.error) {
      const error = new Error(data.error.message ?? String(data.error));
      error.name = data.error.name ?? "Error";
      if (data.error.stack) error.stack = data.error.stack;
      for (const key of ["code", "constraint", "detail"])
        if (data.error[key] !== undefined) error[key] = data.error[key];
      console.error("Database worker operation failed:", error);
      call.reject(error);
      return;
    }
    call.resolve({
      value: data.value,
      dataset: data.dataset,
      settings: data.settings,
      health: data.health,
    });
  };
  worker.onerror = (event) => {
    failAll(
      `Database worker failed. ${window.location.protocol !== 'file' ? 'Is the back end running?' : ''}`,
    );
  };
  try {
    const initial = await request("open", { dataDir });
    return {
      initialDataset: initial.dataset,
      initialSettings: initial.settings,
      get health() {
        return health;
      },
      request,
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
