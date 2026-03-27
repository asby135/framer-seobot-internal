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

app.route("/api/topics", topics);
app.route("/api/articles", articles);
app.route("/api/generate", generate);
app.route("/api/sync", sync);
app.route("/api/schema", schema);
app.route("/api/research", research);
app.route("/api/kb", kb);

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down");
  closeDb();
  process.exit(0);
});

// Start server
const port = env.PORT;

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "CRMChat SEO Engine listening");
});
