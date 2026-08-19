import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { initDb, closeDb } from "./db/index.js";
import { loadKB, getKBArticleCount } from "./services/kb.js";
import { authMiddleware } from "./lib/auth.js";
import { status } from "./routes/status.js";
import { setup } from "./routes/setup.js";
import { topics } from "./routes/topics.js";
import { articles } from "./routes/articles.js";
import { generate } from "./routes/generate.js";
import { sync } from "./routes/sync.js";
import { schema } from "./routes/schema.js";
import { research } from "./routes/research.js";
import { kb } from "./routes/kb.js";
import { telegramRoute } from "./routes/telegram.js";
import { settings as settingsRoute } from "./routes/settings.js";
import { autopilot as autopilotRoute } from "./routes/autopilot.js";
import {
  buildGateHandlers,
  createNightlyRunner,
  ensureDefaultSettings,
  registerArticleReadyHandler,
  recoverPendingPublish,
  flushPendingPublish,
} from "./services/bootstrap.js";

// Initialize database
initDb();

// Load knowledge base (non-fatal if missing)
try {
  loadKB(env.KB_PATH);
  logger.info({ count: getKBArticleCount() }, "KB ready");
} catch (e) {
  logger.warn("Knowledge base not found — generation will work with minimal context");
}

const app = new Hono();

// CORS for Framer plugin iframe
app.use(
  "/api/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Public routes (no auth required)
app.route("/api/status", status);

// Telegram webhook. Deliberately NOT behind authMiddleware — Telegram cannot
// send a bearer token. It authenticates on the secret token header plus a
// chat-id allowlist, both of which fail closed. See routes/telegram.ts.
app.route("/api/telegram", telegramRoute(buildGateHandlers()));

// Setup: POST /api/setup is public (needs secret), POST /api/setup/rotate is protected
app.use("/api/setup/rotate", authMiddleware);
app.route("/api/setup", setup);

// Protected routes (require API key)
app.use("/api/topics/*", authMiddleware);
app.use("/api/articles/*", authMiddleware);
app.use("/api/generate/*", authMiddleware);
app.use("/api/sync/*", authMiddleware);
app.use("/api/schema/*", authMiddleware);
app.use("/api/research/*", authMiddleware);
app.use("/api/kb/*", authMiddleware);
app.use("/api/settings/*", authMiddleware);
app.use("/api/settings", authMiddleware);
app.use("/api/autopilot/*", authMiddleware);

app.route("/api/topics", topics);
app.route("/api/articles", articles);
app.route("/api/generate", generate);
app.route("/api/sync", sync);
app.route("/api/schema", schema);
app.route("/api/research", research);
app.route("/api/kb", kb);
app.route("/api/settings", settingsRoute);
app.route("/api/autopilot", autopilotRoute);

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  runner?.stop();
  // Flush rather than drop a pending deploy; publishPendingSince covers us if
  // the flush itself does not finish in time.
  void flushPendingPublish().finally(() => {
    closeDb();
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down");
  runner?.stop();
  void flushPendingPublish().finally(() => {
    closeDb();
    process.exit(0);
  });
});

// Autopilot — opt-in.
//
// Deploying this code must not start generating articles on its own. The
// scheduler runs only when AUTOPILOT_ENABLED=1, so the pipeline ships dormant
// and is switched on deliberately, after a dry run.
ensureDefaultSettings();

// Gate 2: finished articles must reach the operator. Registered regardless of
// AUTOPILOT_ENABLED, because generation can also be triggered by hand and a
// finished article with nobody told is the failure this closes.
registerArticleReadyHandler();

// Re-arm a site deploy that was owed when the process last stopped.
recoverPendingPublish();

const autopilotEnabled = process.env.AUTOPILOT_ENABLED === "1";
const runner = autopilotEnabled ? createNightlyRunner() : null;

if (runner) {
  runner.start();
  logger.info(
    { dryRun: process.env.SCHEDULER_DRY_RUN === "1" },
    "Autopilot enabled"
  );
} else {
  logger.info("Autopilot disabled (set AUTOPILOT_ENABLED=1 to enable)");
}

// Start server
const port = env.PORT;

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "CRMChat SEO Engine listening");
});
