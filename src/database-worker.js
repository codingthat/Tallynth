import { openDatabase } from "./database.js";

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
      if (!["commit", "forecast", "close"].includes(method))
        throw new Error("Unknown database operation.");
      result = await database[method](value);
    }
    self.postMessage({
      id,
      value: result,
      dataset: method === "forecast" ? undefined : database.getDataset(),
      health: database.health,
    });
  } catch (error) {
    self.postMessage({
      id,
      error: error.message,
      health: database?.health ?? "failed",
    });
  }
}
self.onmessage = ({ data }) => {
  // PGlite owns one database/filesystem. Do not overlap a read's filesystem
  // synchronization with a subsequent write or acknowledge that write early.
  queue = queue.then(() => dispatch(data));
};
