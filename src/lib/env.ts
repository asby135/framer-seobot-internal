export const env = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_PATH: process.env.DATABASE_PATH || "./data/seo-engine.db",
  SETUP_SECRET: process.env.SETUP_SECRET || "",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  // API keys (set via POST /api/setup, stored in DB)

  // Claude
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",

  // OpenAI (gpt-image-2 thumbnails)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",

  // Cloudflare R2
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || "",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || "seo-engine-assets",
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || "",

  // Screenshot API
  SCREENSHOT_API_KEY: process.env.SCREENSHOT_API_KEY || "",

  // Knowledge base
  KB_PATH: process.env.KB_PATH || "./knowledge",

  // Slack (optional)
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || "",

  // Framer Server API — CMS sync and site publish
  FRAMER_API_KEY: process.env.FRAMER_API_KEY || "",
  FRAMER_PROJECT_URL: process.env.FRAMER_PROJECT_URL || "",

  // Public site origin, e.g. https://true-leaders-745133.framer.app. Optional:
  // used to turn a slug into a clickable link in the publish notification.
  // Without it the notification shows the path alone.
  SITE_URL: process.env.SITE_URL || "",
  // The collection bound to the article CMS page. Syncing into any other
  // collection silently destroys every internal link — see framer-sync.ts.
  FRAMER_COLLECTION_ID: process.env.FRAMER_COLLECTION_ID || "",

  // Telegram — the two approval gates and failure alerts
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  // Sent by Telegram as X-Telegram-Bot-Api-Secret-Token; the webhook rejects
  // any request without it. This is the primary auth on that route.
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "",
};
