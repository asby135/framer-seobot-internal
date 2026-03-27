import { framer } from "framer-plugin";
import { App } from "./App";
import { SyncHandler } from "./components/SyncHandler";

// Mode routing: Framer calls the plugin in one of two modes
const mode = framer.mode;

if (mode === "syncManagedCollection") {
  // Headless sync mode — triggered by Framer's Sync button
  // No UI, just fetch + sync + toast
  SyncHandler();
} else {
  // configureManagedCollection — full UI modal
  framer.showUI({
    width: 400,
    height: 600,
  });
}

export function renderApp() {
  return <App />;
}
