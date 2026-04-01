export interface Topic {
  id: string;
  query: string;
  source: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  search_volume: number | null;
  opportunity_score: number;
  status: string;
  created_at: string;
}

export interface Article {
  id: string;
  keyword_id: string;
  title: string;
  slug: string;
  category: string;
  summary: string;
  content: string;
  status: string;
  flags: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  assets?: Asset[];
}

export interface Asset {
  id: string;
  article_id: string;
  type: string;
  url: string;
  alt_text: string | null;
}

export interface CMSField {
  id: string;
  name: string;
  type: string;
}

export interface CMSItem {
  id: string;
  fieldData: Record<string, string>;
}

class ApiClient {
  private baseUrl: string = "";
  private apiKey: string = "";

  configure(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(options.headers as Record<string, string>),
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        res.status,
        (body as { error?: string }).error || res.statusText
      );
    }

    return res.json() as Promise<T>;
  }

  // Public endpoints
  async getStatus() {
    return this.request<{
      status: string;
      last_research: string | null;
      last_sync: string | null;
      keywords: number;
      articles: number;
    }>("/api/status");
  }

  async setup(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const result = await this.request<{ api_key: string }>("/api/setup", {
      method: "POST",
      body: JSON.stringify({ secret }),
      headers: {}, // no auth header for setup
    });
    this.apiKey = result.api_key;
    return result;
  }

  // Research
  async runResearch() {
    return this.request<{ status: string; discovered: number; skipped: number }>(
      "/api/research",
      { method: "POST" }
    );
  }

  async rescoreKeywords() {
    return this.request<{ status: string; rescored: number }>(
      "/api/research/rescore",
      { method: "POST" }
    );
  }

  // Topics
  async getTopics(status: string = "pending", page: number = 1, excludeWithArticles: boolean = false) {
    const qs = `status=${status}&page=${page}${excludeWithArticles ? "&exclude_with_articles=1" : ""}`;
    return this.request<{ topics: Topic[]; total: number; page: number; pages: number }>(
      `/api/topics?${qs}`
    );
  }

  async approveTopic(id: string) {
    return this.request<{ success: boolean }>(`/api/topics/${id}/approve`, {
      method: "POST",
    });
  }

  async rejectTopic(id: string) {
    return this.request<{ success: boolean }>(`/api/topics/${id}/reject`, {
      method: "POST",
    });
  }

  async createCustomTopic(query: string) {
    return this.request<{ id: string; status: string }>("/api/topics/custom", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
  }

  // Articles
  async getArticles(status?: string) {
    const qs = status ? `?status=${status}` : "";
    return this.request<{ articles: Article[] }>(`/api/articles${qs}`);
  }

  async getArticle(id: string) {
    return this.request<Article & { assets: Asset[] }>(`/api/articles/${id}`);
  }

  async publishArticle(id: string) {
    return this.request<{ success: boolean }>(`/api/articles/${id}/publish`, {
      method: "POST",
    });
  }

  async deleteArticle(id: string) {
    return this.request<{ success: boolean }>(`/api/articles/${id}/delete`, {
      method: "POST",
    });
  }

  async translateArticle(id: string, force: boolean = false) {
    return this.request<{ translated: string[]; skipped: string[]; failed: string[] }>(
      `/api/articles/${id}/translate`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      }
    );
  }

  async translateAllArticles(force: boolean = false) {
    return this.request<{ status: string; articles: Array<{ id: string; translated: string[]; skipped: string[] }> }>(
      "/api/articles/translate-all",
      {
        method: "POST",
        body: JSON.stringify({ force }),
      }
    );
  }

  async regenerateArticle(id: string, instructions?: string) {
    return this.request<{ status: string; keyword_id: string; query: string }>(
      `/api/articles/${id}/regenerate`,
      {
        method: "POST",
        body: JSON.stringify({ instructions }),
      }
    );
  }

  // Generate
  async triggerGeneration() {
    return this.request<{
      status: string;
      keyword_id: string;
      query: string;
      remaining: number;
    }>("/api/generate", { method: "POST" });
  }

  async getGenerationStatus() {
    return this.request<{ remaining: number }>("/api/generate/status");
  }

  // Sync
  async getCollection() {
    return this.request<{ items: CMSItem[] }>("/api/sync/collection");
  }

  // Schema
  async getSchema() {
    return this.request<{ fields: CMSField[] }>("/api/schema");
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = new ApiClient();
