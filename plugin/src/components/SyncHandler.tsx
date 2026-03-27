import { framer } from "framer-plugin";
import { api } from "../api/client";

// Headless sync handler — runs when Framer's Sync button is clicked
// No UI, just fetches published articles and syncs to managed collection
export async function SyncHandler() {
  try {
    const collection = await framer.getManagedCollection();
    const baseUrl = await collection.getPluginData("baseUrl");
    const apiKey = await collection.getPluginData("apiKey");

    if (!baseUrl || !apiKey) {
      framer.notify("Not connected. Open Manage to set up.", { variant: "error" });
      return;
    }

    api.configure(baseUrl, apiKey);

    // Fetch schema and published articles from backend
    const [schemaRes, collectionRes] = await Promise.all([
      api.getSchema(),
      api.getCollection(),
    ]);

    // Set fields on the managed collection
    await collection.setFields(
      schemaRes.fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type as "string" | "image" | "date" | "formattedText",
      }))
    );

    // Get current items in collection for reconciliation
    const existingIds = await collection.getItemIds();
    const backendIds = new Set(collectionRes.items.map((i) => i.id));

    // Items to remove (in collection but not in backend)
    const toRemove = existingIds.filter((id) => !backendIds.has(id));

    // Add/update all backend items (addItems is upsert per design assumption)
    if (collectionRes.items.length > 0) {
      await collection.addItems(
        collectionRes.items.map((item) => ({
          id: item.id,
          slug: item.fieldData.slug || item.id,
          fieldData: item.fieldData as Record<string, unknown>,
        }))
      );
    }

    // Remove stale items
    if (toRemove.length > 0) {
      await collection.removeItems(toRemove);
    }

    // Store last sync timestamp
    await collection.setPluginData("lastSync", new Date().toISOString());

    const count = collectionRes.items.length;
    framer.notify(`Synced ${count} article${count !== 1 ? "s" : ""}`, {
      variant: "success",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    framer.notify(`Sync failed: ${message}`, { variant: "error" });
  }
}
