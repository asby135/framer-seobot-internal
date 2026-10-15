import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { applyAuth } from "./auth.js";

/**
 * Which paths demand a bearer key, tested through the app-level mounting.
 *
 * The route tests call each sub-app directly (`setup.request(...)`), so they
 * never pass through the middleware wiring in index.ts — which is how
 * `GET /api/setup/keys` and `DELETE /api/setup/keys/:label` shipped public:
 * anyone could list key labels and revoke the plugin's key with one curl.
 */
function appWithStubs(): Hono {
  const app = new Hono();
  applyAuth(app);
  // Stub every route so a 200 means "the middleware let it through".
  app.all("*", (c) => c.json({ reached: true }));
  return app;
}

const call = (app: Hono, method: string, path: string) => app.request(path, { method });

describe("applyAuth", () => {
  const app = appWithStubs();

  it.each([
    ["GET", "/api/setup/keys"],
    ["DELETE", "/api/setup/keys/plugin"],
    ["POST", "/api/setup/rotate"],
    ["GET", "/api/topics"],
    ["GET", "/api/topics/abc"],
    ["POST", "/api/articles/abc/delete"],
    ["GET", "/api/articles"],
    ["POST", "/api/generate"],
    ["POST", "/api/sync/framer"],
    ["GET", "/api/schema"],
    ["POST", "/api/research/seed"],
    ["GET", "/api/kb"],
    ["GET", "/api/settings"],
    ["POST", "/api/settings"],
    ["POST", "/api/autopilot/run"],
  ])("refuses %s %s without a key", async (method, path) => {
    expect((await call(app, method, path)).status).toBe(401);
  });

  it.each([
    ["GET", "/api/status"],
    // Needs SETUP_SECRET in the body instead — it is how the first key is minted.
    ["POST", "/api/setup"],
    // Authenticates on Telegram's secret-token header, not a bearer key.
    ["POST", "/api/telegram/webhook"],
  ])("leaves %s %s public", async (method, path) => {
    expect((await call(app, method, path)).status).toBe(200);
  });
});
