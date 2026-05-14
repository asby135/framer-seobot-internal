import OpenAI from "openai";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Distinct editorial illustration styles. One is picked at random per article
 * so a batch of thumbnails doesn't look like one obviously-AI-generated set.
 * Each is self-contained: art style + palette + composition. The base prompt
 * keeps the hard constraints (single metaphor, no text, no icon collage).
 */
const THUMBNAIL_STYLES = [
  "Flat vector illustration. Muted palette of soft blues and warm grays with one subtle accent color. A single centered object, generous whitespace around it.",
  "Soft geometric shapes with gentle gradients. Warm earth tones — terracotta, sand, cream. Asymmetric composition, the subject off to one side.",
  "Thin-stroke line-art illustration. Near-monochrome with a single bold accent color. Lots of negative space, like a New Yorker spot illustration.",
  "Layered paper-cut style with subtle drop shadows for depth. Pastel palette — dusty pink, pale blue, soft yellow. One simple central shape.",
  "Minimal isometric illustration. Cool palette — teal, slate, off-white. A single object sitting on a plain flat background, no scene clutter.",
  "Risograph-style print look — slightly grainy texture, a limited two-color palette, one bold simple shape. Retro-editorial, lots of breathing room.",
];

/**
 * Generate a thumbnail with gpt-image-2 and upload to R2.
 * Returns the public URL, or null on failure (partial failure model).
 */
export async function generateThumbnail(
  articleId: string,
  title: string,
  keyword: string
): Promise<string | null> {
  try {
    const style =
      THUMBNAIL_STYLES[Math.floor(Math.random() * THUMBNAIL_STYLES.length)];

    const response = await openai.images.generate({
      model: "gpt-image-2",
      prompt: `Editorial blog-header illustration for an article about "${keyword}". Show ONE simple, clear visual metaphor for the topic — a single object or minimal scene, never a collage. ${style} Absolutely NO text, NO words, NO letters, NO numbers, NO logos, NO floating icons, NO busy compositions. Like an illustration from a premium print magazine — restrained and intentional.`,
      n: 1,
      size: "1536x1024", // landscape, crops cleanly to a blog header
      quality: "high",
    });

    // gpt-image-2 returns base64 by default; fall back to a URL if present.
    const data = response.data?.[0];
    let imageBuffer: Buffer;
    if (data?.b64_json) {
      imageBuffer = Buffer.from(data.b64_json, "base64");
    } else if (data?.url) {
      const imageResponse = await fetch(data.url);
      imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    } else {
      logger.error({ articleId }, "gpt-image-2 returned no image data");
      return null;
    }

    // Upload to R2
    const key = `thumbnails/${articleId}-${nanoid(6)}.png`;
    const r2Url = await uploadToR2(key, imageBuffer, "image/png");

    // Save asset record
    saveAsset(articleId, "thumbnail", r2Url, `Thumbnail for: ${title}`);

    return r2Url;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message, articleId }, "Thumbnail generation failed");
    return null;
  }
}

/**
 * Take a screenshot of a URL via screenshot API and upload to R2.
 * Returns the public URL, or null on failure.
 */
export async function captureScreenshot(
  articleId: string,
  targetUrl: string
): Promise<string | null> {
  if (!env.SCREENSHOT_API_KEY) {
    logger.warn("Screenshot API key not configured, skipping");
    return null;
  }

  try {
    // Using screenshotone.com API (common screenshot service)
    const params = new URLSearchParams({
      access_key: env.SCREENSHOT_API_KEY,
      url: targetUrl,
      viewport_width: "1280",
      viewport_height: "800",
      format: "png",
      full_page: "false",
    });

    const response = await fetch(
      `https://api.screenshotone.com/take?${params.toString()}`
    );

    if (!response.ok) {
      logger.error(
        { status: response.status, targetUrl },
        "Screenshot API returned error"
      );
      return null;
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Validate screenshot quality: reject tiny images (likely blank/error pages)
    if (imageBuffer.length < 10_000) {
      logger.warn(
        { targetUrl, size: imageBuffer.length },
        "Screenshot too small, likely blank/error page"
      );
      return null;
    }

    // Upload to R2
    const slug = targetUrl
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]/gi, "-")
      .slice(0, 50);
    const key = `screenshots/${articleId}-${slug}-${nanoid(6)}.png`;
    const r2Url = await uploadToR2(key, imageBuffer, "image/png");

    // Save asset record
    saveAsset(
      articleId,
      "screenshot",
      r2Url,
      `Screenshot of ${targetUrl}`
    );

    return r2Url;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error(
      { error: message, articleId, targetUrl },
      "Screenshot capture failed"
    );
    return null;
  }
}

/**
 * Process screenshot placeholders in article HTML.
 * Replaces <!-- screenshot:https://example.com --> with actual <img> tags.
 */
export async function processScreenshots(
  articleId: string,
  html: string
): Promise<{ html: string; failed: string[] }> {
  const placeholder = /<!-- screenshot:(https?:\/\/[^\s]+) -->/g;
  const matches = [...html.matchAll(placeholder)];

  if (matches.length === 0) {
    return { html, failed: [] };
  }

  const failed: string[] = [];
  let result = html;

  for (const match of matches) {
    const url = match[1];
    const screenshotUrl = await captureScreenshot(articleId, url);

    if (screenshotUrl) {
      result = result.replace(
        match[0],
        `<img src="${screenshotUrl}" alt="Screenshot of ${url}" loading="lazy" />`
      );
    } else {
      failed.push(url);
      // Remove the placeholder comment on failure
      result = result.replace(match[0], "");
    }
  }

  return { html: result, failed };
}

// --- R2 helpers ---

async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  await r2.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return `${env.R2_PUBLIC_URL}/${key}`;
}

function saveAsset(
  articleId: string,
  type: string,
  url: string,
  altText: string
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO assets (id, article_id, type, url, alt_text) VALUES (?, ?, ?, ?, ?)"
  ).run(nanoid(), articleId, type, url, altText);
}
