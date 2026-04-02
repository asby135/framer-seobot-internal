import { framer } from "framer-plugin";
import { api } from "../api/client";

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

    // Fetch schema, articles, and Framer locales
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

    // Transform field data: remap locale codes to Framer locale IDs
    const transformedItems = collectionRes.items.map((item) => {
      const fieldData: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item.fieldData)) {
        if (
          value &&
          typeof value === "object" &&
          "valueByLocale" in (value as Record<string, unknown>)
        ) {
          const typedValue = value as {
            type: string;
            value: string;
            valueByLocale: Record<string, { action: string; value: string }>;
          };

          // Remap locale codes to Framer locale IDs
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
            // No matching locales, drop valueByLocale
            fieldData[key] = { type: typedValue.type, value: typedValue.value };
          }
        } else {
          fieldData[key] = value;
        }
      }

      // Extract slug from top-level item property (not fieldData)
      const slug = (item as Record<string, unknown>).slug as string || item.id;

      // Remap slugByLocale codes to Framer locale IDs
      const rawSlugByLocale = (item as Record<string, unknown>).slugByLocale as Record<string, { action: string; value: string }> | undefined;
      const remappedSlugByLocale: Record<string, { action: string; value: string }> = {};
      if (rawSlugByLocale) {
        for (const [localeCode, localeData] of Object.entries(rawSlugByLocale)) {
          const framerLocaleId = localeIdMap.get(localeCode);
          if (framerLocaleId) {
            remappedSlugByLocale[framerLocaleId] = localeData;
          }
        }
      }

      return {
        id: item.id,
        slug,
        ...(Object.keys(remappedSlugByLocale).length > 0 ? { slugByLocale: remappedSlugByLocale } : {}),
        fieldData,
      };
    });

    // Get current items for reconciliation
    const existingIds = await collection.getItemIds();
    const backendIds = new Set(collectionRes.items.map((i) => i.id));

    // Items to remove
    const toRemove = existingIds.filter((id) => !backendIds.has(id));

    // Add/update all items
    if (transformedItems.length > 0) {
      await collection.addItems(transformedItems);
    }

    // Remove stale items
    if (toRemove.length > 0) {
      await collection.removeItems(toRemove);
    }

    // Store last sync timestamp
    await collection.setPluginData("lastSync", new Date().toISOString());

    const count = transformedItems.length;
    const localeSuffix = localeIdMap.size > 0 ? ` (${localeIdMap.size} locales)` : "";
    framer.notify(`Synced ${count} article${count !== 1 ? "s" : ""}${localeSuffix}`, {
      variant: "success",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    framer.notify(`Sync failed: ${message}`, { variant: "error" });
  }
}
