import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Set env BEFORE importing era.ts so the module reads our test values.
process.env.ERA_AI_API_KEY = "omg_test_key";
process.env.ERA_AI_BRAND_ID = "test-brand-id";

const { fetchEraQueries, listBrands } = await import("./era.js");

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("listBrands", () => {
  it("returns the brand list on happy path", async () => {
    mockFetch(() =>
      jsonResponse({
        items: [
          { id: "abc", name: "CRMChat", domain: "crmchat.ai" },
          { id: "def", name: "OtherBrand", domain: null },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      })
    );

    const brands = await listBrands();
    expect(brands).toHaveLength(2);
    expect(brands[0]).toEqual({ id: "abc", name: "CRMChat", domain: "crmchat.ai" });
  });

  it("throws on 401 with auth error", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));
    await expect(listBrands()).rejects.toThrow("Era auth failed: invalid X-API-Key");
  });
});

describe("fetchEraQueries", () => {
  it("normalizes count + sov into opportunity_score (0-100)", async () => {
    mockFetch(() =>
      jsonResponse({
        items: [
          {
            id: "q1",
            query: "CRMChat pricing",
            count: 100, // will be maxCount → countScore=100
            sov: 10, // sovScore = 90
            cluster_path: ["Telegram CRM", "CRMChat Pricing"],
            providers: ["perplexity"],
            competitors: 5,
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          },
          {
            id: "q2",
            query: "Best Telegram CRM",
            count: 50, // countScore = 50
            sov: 20, // sovScore = 80
            cluster_path: ["Telegram CRM"],
            providers: ["perplexity"],
            competitors: 8,
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
        total: 2,
        total_count_sum: 150,
        total_clusters: 2,
        limit: 500,
        offset: 0,
      })
    );

    const queries = await fetchEraQueries();
    expect(queries).toHaveLength(2);

    // q1: count=100 (max), sov=10 → (100*0.5) + (90*0.5) = 95
    expect(queries[0].query).toBe("CRMChat pricing");
    expect(queries[0].opportunity_score).toBe(95);
    expect(queries[0].category).toBe("CRMChat Pricing"); // leaf of cluster_path

    // q2: count=50/100=50, sov=20 → (50*0.5) + (80*0.5) = 65
    expect(queries[1].opportunity_score).toBe(65);
    expect(queries[1].category).toBe("Telegram CRM");
  });

  it("treats sov=null as 0 (maximum opportunity)", async () => {
    mockFetch(() =>
      jsonResponse({
        items: [
          {
            id: "q1",
            query: "Test",
            count: 10,
            sov: null,
            cluster_path: [],
            providers: [],
            competitors: null,
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
        total: 1,
        total_count_sum: 10,
        total_clusters: 0,
        limit: 500,
        offset: 0,
      })
    );

    const queries = await fetchEraQueries();
    // sov=null → sovScore=100. count=10/10=100 → countScore=100. (100+100)/2=100.
    expect(queries[0].opportunity_score).toBe(100);
    expect(queries[0].category).toBeNull(); // empty cluster_path
  });

  it("returns empty array when Era has no queries", async () => {
    mockFetch(() =>
      jsonResponse({
        items: [],
        total: 0,
        total_count_sum: 0,
        total_clusters: 0,
        limit: 500,
        offset: 0,
      })
    );

    const queries = await fetchEraQueries();
    expect(queries).toEqual([]);
  });

  it("throws on 401", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));
    await expect(fetchEraQueries()).rejects.toThrow("Era auth failed: invalid X-API-Key");
  });

  it("throws on 403", async () => {
    mockFetch(() => textResponse("Forbidden", 403));
    await expect(fetchEraQueries()).rejects.toThrow("Era auth failed: key has no access");
  });

  it("throws on 429 with rate-limit message", async () => {
    mockFetch(() => textResponse("Too Many Requests", 429));
    await expect(fetchEraQueries()).rejects.toThrow("Era rate limit exceeded");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchEraQueries()).rejects.toThrow();
  });

  it("throws on 500 with status code preserved", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));
    await expect(fetchEraQueries()).rejects.toThrow(/500/);
  });
});
