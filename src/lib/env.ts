export const env = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_PATH: process.env.DATABASE_PATH || "./data/seo-engine.db",
  SETUP_SECRET: process.env.SETUP_SECRET || "",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  // API keys (set via POST /api/setup, stored in DB)
  // GSC
  GSC_SERVICE_ACCOUNT_KEY: process.env.GSC_SERVICE_ACCOUNT_KEY || "",
  GSC_SITE_URL: process.env.GSC_SITE_URL || "",

  // Claude
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",

  // DALL-E
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",

  // Cloudflare R2
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || "",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || "seo-engine-assets",

  // Screenshot API
  SCREENSHOT_API_KEY: process.env.SCREENSHOT_API_KEY || "",

  // Knowledge base
  KB_PATH: process.env.KB_PATH || "./knowledge",

  // Slack (optional)
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || "",
};
