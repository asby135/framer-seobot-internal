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
 * Generate a DALL-E thumbnail and upload to R2.
 * Returns the public URL, or null on failure (partial failure model).
 */
export async function generateThumbnail(
  articleId: string,
  title: string,
  keyword: string
): Promise<string | null> {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Minimal, editorial-style blog header illustration for an article about "${keyword}". Style: flat vector art with a muted, sophisticated color palette (soft blues, warm grays, subtle accents). Show one simple, clear visual metaphor related to the topic — not a collage of icons. Think: a single object or scene, plenty of whitespace, like an illustration from a premium tech magazine. Absolutely NO text, NO words, NO letters, NO logos, NO busy compositions, NO floating icons, NO generic tech collages. Clean and understated.`,
      n: 1,
      size: "1792x1024", // Closest to 1200x630 aspect ratio
      quality: "standard",
    });

    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) {
      logger.error({ articleId }, "DALL-E returned no image URL");
      return null;
    }

    // Download the image
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

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
