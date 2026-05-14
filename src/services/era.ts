import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * OhMyGEO ("Era") API client.
 *
 * Source of truth for AEO/GEO keyword discovery: returns the search queries
 * that AI providers (ChatGPT, Perplexity, Claude, etc.) generate when users
 * ask about a brand or its category.
 *
 * Replaces the previous Google Search Console source (gsc.ts) for the AEO pivot.
 * See ceo-plans/2026-05-08-era-ai-content-pivot.md.
 *
 * API contract (from https://new.era.shopping/api/v1/openapi.json, OpenAPI 3.1.0):
 *   Base URL:  https://new.era.shopping/api/v1
 *   Auth:      X-API-Key header
 *   Endpoints we use:
 *     GET /brands                            -> list brands accessible to the key
 *     GET /brands/{brand_id}/search-queries  -> the keyword list (paginated)
 *
 * SearchQueryItem shape (what Era returns per keyword):
 *   {
 *     id: uuid,
 *     query: string,                  // the keyword text — our `query` field
 *     count: int (>=1),               // observation count (more = more searched)
 *     cluster_path: string[],         // topic hierarchy, e.g. ["Products", "CRM"]
 *     providers: string[],            // which LLMs generated it
 *     sov: number | null,             // Share of Voice % — CRMChat's citation rate (0-100)
 *     competitors: number | null,     // avg competitor count in answers
 *     created_at: ISO date,
 *     updated_at: ISO date
 *   }
 *
 * Score formula (normalized to 0-100):
 *   - countScore  = (count / maxCount) * 100      // popularity within batch
 *   - sovScore    = 100 - (sov ?? 0)              // inverted SoV (low SoV = high opportunity)
 *   - opportunity = (countScore * 0.5) + (sovScore * 0.5)
 *
 * High score = "many people ask this AND we're rarely cited" = best target.
 * Low score = "few people ask this AND we already dominate" = skip.
 *
 * Locale: the API has NO locale parameter. Queries are returned as the LLMs
 * generated them (effectively English). Russian-audience sourcing needs a
 * separate source (see TODOS.md).
 */

const BASE_URL = "https://new.era.shopping/api/v1";

interface SearchQueryItem {
  id: string;
  query: string;
  count: number;
  cluster_path?: string[];
  providers?: string[];
  sov: number | null;
  competitors: number | null;
  created_at: string;
  updated_at: string;
}

interface SearchQueryListResponse {
  items: SearchQueryItem[];
  total: number;
  total_count_sum: number;
  total_clusters: number;
  limit: number;
  offset: number;
}

interface BrandListItem {
  id: string;
  name: string;
  domain?: string | null;
}

interface BrandListResponse {
  items: BrandListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Normalized keyword shape for the rest of the pipeline (parallels gsc.ts).
 */
export interface EraQuery {
  query: string;
  count: number;
  sov: number | null;
  category: string | null; // first segment of cluster_path
  opportunity_score: number; // 0-100, normalized
  raw: SearchQueryItem;
}

async function eraFetch<T>(path: string): Promise<T> {
  const apiKey = env.ERA_AI_API_KEY;
  if (!apiKey) {
    throw new Error("ERA_AI_API_KEY not configured");
  }

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(
      { status: res.status, body: body.slice(0, 500), path },
      "Era API request failed"
    );

    if (res.status === 401) {
      throw new Error("Era auth failed: invalid X-API-Key");
    }
    if (res.status === 403) {
      throw new Error("Era auth failed: key has no access to this resource");
    }
    if (res.status === 404) {
      throw new Error(`Era API not found: ${path}`);
    }
    if (res.status === 429) {
      throw new Error("Era rate limit exceeded. Try again later.");
    }
    throw new Error(`Era API error: ${res.status} - ${body.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

/**
 * List all brands accessible to the configured API key.
 *
 * Use this once during setup to discover your brand_id for ERA_AI_BRAND_ID env.
 */
export async function listBrands(): Promise<BrandListItem[]> {
  const data = await eraFetch<BrandListResponse>("/brands?limit=100");
  logger.info({ count: data.items.length }, "Era brands fetched");
  return data.items;
}

/**
 * Fetch search queries (AI-generated keywords) for the configured brand.
 *
 * Returns up to 1000 queries sorted by observation count (highest first).
 * Scores are normalized to 0-100 within the returned batch.
 */
export async function fetchEraQueries(): Promise<EraQuery[]> {
  const brandId = env.ERA_AI_BRAND_ID;
  if (!brandId) {
    throw new Error(
      "ERA_AI_BRAND_ID not configured. Run listBrands() to discover it."
    );
  }

  // limit is capped at 500 by the API (verified empirically 2026-05-11).
  // 500 is overwhelmingly enough — at peak we'll only need ~40 articles/quarter.
  const path = `/brands/${encodeURIComponent(brandId)}/search-queries?limit=500&sort_by=count&order=desc`;
  const data = await eraFetch<SearchQueryListResponse>(path);

  if (!data.items || data.items.length === 0) {
    logger.info("Era returned no search queries");
    return [];
  }

  // Min-max normalize count to 0-100 within this batch.
  // reduce (not Math.max spread) to avoid call-stack limits if the API
  // ever returns a batch larger than expected.
  const maxCount = Math.max(
    data.items.reduce((m, i) => (i.count > m ? i.count : m), 0),
    1
  );

  const queries: EraQuery[] = data.items.map((item) => {
    const countScore = (item.count / maxCount) * 100;
    const sovScore = 100 - (item.sov ?? 0);
    const opportunity_score = countScore * 0.5 + sovScore * 0.5;

    // Use LEAF of cluster_path (most specific) — e.g. "CRMChat Pricing"
    // is more useful than the root "Telegram CRM and Outreach"
    const clusterPath = item.cluster_path ?? [];
    const category =
      clusterPath.length > 0 ? clusterPath[clusterPath.length - 1] : null;

    return {
      query: item.query,
      count: item.count,
      sov: item.sov,
      category,
      opportunity_score: Math.round(opportunity_score * 100) / 100, // 2 decimals
      raw: item,
    };
  });

  logger.info(
    { count: queries.length, totalAvailable: data.total, maxCount },
    "Era search queries fetched"
  );

  return queries;
}
