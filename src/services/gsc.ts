import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

interface GSCQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GSCResponse {
  rows?: Array<{
    keys: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
}

// Google OAuth2 token cache
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const keyJson = JSON.parse(env.GSC_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);

  // Build JWT for service account auth
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: keyJson.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const { createSign } = await import("crypto");

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(keyJson.private_key, "base64url");

  const jwt = `${signatureInput}.${signature}`;

  // Exchange JWT for access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "GSC OAuth token exchange failed");
    throw new Error(`GSC auth failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  logger.info("GSC access token obtained");
  return data.access_token;
}

export async function fetchGSCQueries(days: number = 90): Promise<GSCQuery[]> {
  const token = await getAccessToken();
  const siteUrl = env.GSC_SITE_URL;

  if (!siteUrl) {
    throw new Error("GSC_SITE_URL not configured");
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const encodedSiteUrl = encodeURIComponent(siteUrl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      dimensions: ["query"],
      rowLimit: 1000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "GSC query failed");

    if (res.status === 429) {
      throw new Error("GSC rate limit exceeded. Try again later.");
    }
    throw new Error(`GSC API error: ${res.status}`);
  }

  const data = (await res.json()) as GSCResponse;

  if (!data.rows || data.rows.length === 0) {
    logger.info("GSC returned no queries");
    return [];
  }

  const queries: GSCQuery[] = data.rows.map((row) => ({
    query: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));

  logger.info({ count: queries.length }, "GSC queries fetched");
  return queries;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}
