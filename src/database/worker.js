import { openDatabase } from "./db.js";

let database;
let queue = Promise.resolve();
async function dispatch({ id, method, value }) {
  try {
    let result;
    if (method === "open") {
      if (database) throw new Error("The database is already open.");
      database = await openDatabase(value);
    } else {
      if (!database) throw new Error("The database is not open.");
      const operation = database[method];
      if (typeof operation !== "function")
        throw new Error("Unknown database operation.");
      result = await operation(value);
    }
    self.postMessage({
      id,
      value: result,
      dataset: database.getDataset(),
      settings: database.getSettings(),
      health: database.health,
    });
  } catch (error) {
    console.error("Database operation failed:", error);
    self.postMessage({
      id,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        code: error?.code,
        constraint: error?.constraint,
        detail: error?.detail,
      },
      health: database?.health ?? "failed",
    });
  }
}
self.onmessage = ({ data }) => {
  // PGlite owns one database/filesystem. Do not overlap a read's filesystem
  // synchronization with a subsequent write or acknowledge that write early.
  queue = queue.then(() => dispatch(data));
};
