import { framer } from "framer-plugin";
import { api, type CMSItem } from "../api/client";

// Map our internal locale codes to Framer locale codes
const LOCALE_CODE_MAP: Record<string, string[]> = {
  ru: ["ru", "ru-RU"],
  ua: ["uk", "uk-UA", "ua"],
  fr: ["fr", "fr-FR"],
};

function findFramerLocaleId(
  localeCode: string,
  framerLocales: readonly { id: string; code: string; slug: string }[]
): string | null {
  const candidates = LOCALE_CODE_MAP[localeCode] || [localeCode];
  for (const candidate of candidates) {
    const match = framerLocales.find(
      (l) => l.code === candidate || l.slug === candidate || l.code.startsWith(candidate + "-")
    );
    if (match) return match.id;
  }
  return null;
}

// Build items with locale data remapped to Framer locale IDs
function buildItems(
  collectionRes: { items: CMSItem[]; locales?: string[] },
  localeIdMap: Map<string, string>,
  includeLocales: boolean
) {
  return collectionRes.items.map((item) => {
    const fieldData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(item.fieldData)) {
      if (
        includeLocales &&
        value &&
        typeof value === "object" &&
        "valueByLocale" in (value as Record<string, unknown>)
      ) {
        const typedValue = value as {
          type: string;
          value: string;
          valueByLocale: Record<string, { action: string; value: string }>;
        };

        const remappedByLocale: Record<string, { action: string; value: string }> = {};
        for (const [localeCode, localeData] of Object.entries(typedValue.valueByLocale)) {
          const framerLocaleId = localeIdMap.get(localeCode);
          if (framerLocaleId) {
            remappedByLocale[framerLocaleId] = localeData;
          }
        }

        if (Object.keys(remappedByLocale).length > 0) {
          fieldData[key] = { ...typedValue, valueByLocale: remappedByLocale };
        } else {
          fieldData[key] = { type: typedValue.type, value: typedValue.value };
        }
      } else if (value && typeof value === "object" && "type" in (value as Record<string, unknown>)) {
        const typedValue = value as Record<string, unknown>;
        // Strip valueByLocale if not including locales
        const { valueByLocale: _, ...rest } = typedValue;
        fieldData[key] = rest;
      } else {
        fieldData[key] = value;
      }
    }

    const slug = (item as unknown as Record<string, unknown>).slug as string || item.id;

    return { id: item.id, slug, fieldData };
  });
}

// Headless sync handler — runs when Framer's Sync button is clicked
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

    const [schemaRes, collectionRes, framerLocales] = await Promise.all([
      api.getSchema(),
      api.getCollection(),
      framer.getLocales(),
    ]);

    // Build locale code → Framer locale ID map
    const localeIdMap = new Map<string, string>();
    for (const code of (collectionRes.locales || [])) {
      const framerLocaleId = findFramerLocaleId(code, framerLocales);
      if (framerLocaleId) {
        localeIdMap.set(code, framerLocaleId);
      }
    }

    // Only set fields if collection has no fields yet (first sync)
    // Calling setFields on every sync can break Framer variable references
    const existingFields = await collection.getFields();
    if (existingFields.length === 0) {
      await collection.setFields(
        schemaRes.fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type as "string" | "image" | "date" | "formattedText",
        }))
      );
    }

    // Get current items for reconciliation
    const existingIds = await collection.getItemIds();
    const backendIds = new Set(collectionRes.items.map((i) => i.id));
    const toRemove = existingIds.filter((id) => !backendIds.has(id));

    // Try full sync with locale data first
    let syncedWithLocales = false;
    const itemsWithLocales = buildItems(collectionRes, localeIdMap, true);

    if (itemsWithLocales.length > 0) {
      try {
        await collection.addItems(itemsWithLocales as unknown as Parameters<typeof collection.addItems>[0]);
        syncedWithLocales = true;
      } catch (localeError) {
        // Locale sync failed (likely orphaned variable references in Framer project)
        // Fall back to syncing without locale data so user isn't blocked
        console.warn("Locale sync failed, falling back to sync without translations:", localeError instanceof Error ? localeError.message : localeError);
        const itemsWithoutLocales = buildItems(collectionRes, localeIdMap, false);
        await collection.addItems(itemsWithoutLocales as unknown as Parameters<typeof collection.addItems>[0]);
      }
    }

    if (toRemove.length > 0) {
      await collection.removeItems(toRemove);
    }

    await collection.setPluginData("lastSync", new Date().toISOString());

    const count = itemsWithLocales.length;
    if (syncedWithLocales) {
      const localeSuffix = localeIdMap.size > 0 ? ` (${localeIdMap.size} locales)` : "";
      framer.notify(`Synced ${count} article${count !== 1 ? "s" : ""}${localeSuffix}`, {
        variant: "success",
      });
    } else {
      framer.notify(
        `Synced ${count} article${count !== 1 ? "s" : ""} without translations. Remove broken variable references in your pages to enable locale sync.`,
        { variant: "warning" }
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    framer.notify(`Sync failed: ${message}`, { variant: "error" });
  }
}
