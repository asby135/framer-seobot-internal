import { Hono } from "hono";
import { getSetting, setSetting } from "../services/settings.js";
import { DEFAULT_NICHES, type Niche } from "../services/taxonomy.js";
import { logger } from "../lib/logger.js";

/**
 * Generator settings, editable from the plugin so the pipeline can be retuned
 * without a redeploy.
 *
 * Deliberately exposes ONLY tuning values. Credentials (Framer, Telegram,
 * Anthropic) stay in environment variables — the plugin stores its own API key
 * in Framer plugin data, and round-tripping secrets through this endpoint
 * would put them in a second place for no benefit.
 */

const settings = new Hono();

/** Hard cap on articles per night. A typo here could spend a month's budget overnight. */
const MAX_PER_NIGHT_CAP = 20;

/** A persona must read as a sentence: searchKB grounds on it, and a label retrieves noise. */
const MIN_PERSONA_WORDS = 5;

interface Payload {
  niches?: unknown;
  minPerNight?: unknown;
  maxPerNight?: unknown;
  scheduleHour?: unknown;
  poolThreshold?: unknown;
}

function validateNiches(value: unknown): string | null {
  if (!Array.isArray(value)) return "niches must be an array";

  for (const [i, raw] of value.entries()) {
    const n = raw as Partial<Niche>;
    if (!n || typeof n !== "object") return `niches[${i}] must be an object`;
    if (!n.name || typeof n.name !== "string") return `niches[${i}].name is required`;
    if (!n.persona || typeof n.persona !== "string") {
      return `niches[${i}].persona is required`;
    }
    if (n.persona.trim().split(/\s+/).length < MIN_PERSONA_WORDS) {
      return `niches[${i}].persona must be a descriptive sentence, not a label — topic grounding searches the knowledge base with it`;
    }
    if (!Array.isArray(n.subniches) || n.subniches.length === 0) {
      return `niches[${i}].subniches must be a non-empty array`;
    }
    if (n.kb_hints !== undefined && !Array.isArray(n.kb_hints)) {
      return `niches[${i}].kb_hints must be an array`;
    }
  }
  return null;
}

settings.get("/", (c) => {
  return c.json({
    niches: getSetting<Niche[]>("niches", DEFAULT_NICHES),
    minPerNight: getSetting("minPerNight", 5),
    maxPerNight: getSetting("maxPerNight", 10),
    scheduleHour: getSetting("scheduleHour", 20),
    poolThreshold: getSetting("poolThreshold", 10),
    rotationCursor: getSetting("rotationCursor", 0),
    lastRunDate: getSetting<string | null>("lastRunDate", null),
  });
});

settings.post("/", async (c) => {
  const body = await c.req.json<Payload>().catch(() => ({}) as Payload);
  const updated: string[] = [];

  if (body.niches !== undefined) {
    const error = validateNiches(body.niches);
    if (error) return c.json({ error }, 400);
    setSetting("niches", body.niches);
    updated.push("niches");
  }

  // Read the current values so a partial update is validated against what will
  // actually be in effect, not against defaults.
  const min = body.minPerNight ?? getSetting("minPerNight", 5);
  const max = body.maxPerNight ?? getSetting("maxPerNight", 10);

  if (body.minPerNight !== undefined || body.maxPerNight !== undefined) {
    if (typeof min !== "number" || typeof max !== "number") {
      return c.json({ error: "minPerNight and maxPerNight must be numbers" }, 400);
    }
    if (min < 1) return c.json({ error: "minPerNight must be at least 1" }, 400);
    if (max < min) {
      return c.json({ error: "maxPerNight must be greater than or equal to minPerNight" }, 400);
    }
    if (max > MAX_PER_NIGHT_CAP) {
      return c.json({ error: `maxPerNight must not exceed ${MAX_PER_NIGHT_CAP}` }, 400);
    }
    if (body.minPerNight !== undefined) { setSetting("minPerNight", min); updated.push("minPerNight"); }
    if (body.maxPerNight !== undefined) { setSetting("maxPerNight", max); updated.push("maxPerNight"); }
  }

  if (body.scheduleHour !== undefined) {
    const h = body.scheduleHour;
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 23) {
      return c.json({ error: "scheduleHour must be an integer between 0 and 23" }, 400);
    }
    setSetting("scheduleHour", h);
    updated.push("scheduleHour");
  }

  if (body.poolThreshold !== undefined) {
    const t = body.poolThreshold;
    if (typeof t !== "number" || t < 1) {
      return c.json({ error: "poolThreshold must be a positive number" }, 400);
    }
    setSetting("poolThreshold", t);
    updated.push("poolThreshold");
  }

  logger.info({ updated }, "Generator settings updated");
  return c.json({ success: true, updated });
});

export { settings };
