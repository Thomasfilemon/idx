import { initDashboard } from "./dashboard/app.mjs";

let storage;
try {
  storage = globalThis.localStorage;
} catch {
  // Browser storage may be unavailable.
}
initDashboard({ document, fetch: globalThis.fetch.bind(globalThis), storage });
