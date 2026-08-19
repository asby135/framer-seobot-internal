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
  translatedLocales?: string[];
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
  fieldData: Record<string, unknown>;
}

class ApiClient {
  private baseUrl: string = "";
  private apiKey: string = "";

  private normalizeUrl(url: string): string {
    let normalized = url.replace(/\/$/, "");
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    return normalized;
  }

  configure(baseUrl: string, apiKey: string) {
    this.baseUrl = this.normalizeUrl(baseUrl);
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
    this.baseUrl = this.normalizeUrl(baseUrl);
    const result = await this.request<{ api_key: string }>("/api/setup", {
      method: "POST",
      // Claim a dedicated label so reconnecting the plugin cannot invalidate a
      // key held elsewhere (a terminal, a script). Each consumer owns its own.
      body: JSON.stringify({ secret, label: "plugin" }),
      headers: {}, // no auth header for setup
    });
    this.apiKey = result.api_key;
    return result;
  }

  // Research. gap=true runs competitor-gap mode: only topics where competitors
  // are cited in AI answers and CRMChat is not.
  async runResearch(gap: boolean = false) {
    return this.request<{
      status: string;
      mode: "era" | "era-gap";
      discovered: number;
      skipped: number;
    }>("/api/research", {
      method: "POST",
      body: JSON.stringify({ gap }),
    });
  }

  async seedTopics(audience: string, count: number = 10) {
    return this.request<{
      status: string;
      audience: string;
      seeded: number;
      skipped: number;
      topics: Array<{ query: string }>;
    }>("/api/research/seed", {
      method: "POST",
      body: JSON.stringify({ audience, count }),
    });
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
    return this.request<{
      status: string;
      article_id: string;
      queue: { pending: number; active: number; lastResult?: unknown };
    }>(`/api/articles/${id}/translate`, {
      method: "POST",
      body: JSON.stringify({ force }),
    });
  }

  async translateBatch(articleIds: string[], force: boolean = false) {
    return this.request<{
      status: string;
      enqueued: Array<{ article_id: string; title: string }>;
      queue: { pending: number; active: number; lastResult?: unknown };
    }>("/api/articles/translate-batch", {
      method: "POST",
      body: JSON.stringify({ article_ids: articleIds, force }),
    });
  }

  async translateAllArticles(force: boolean = false) {
    return this.request<{ status: string; count: number; message: string }>(
      "/api/articles/translate-all",
      {
        method: "POST",
        body: JSON.stringify({ force }),
      }
    );
  }

  async getTranslationStatus() {
    return this.request<{
      queue: { pending: number; active: number; lastResult?: unknown };
    }>("/api/articles/translate-status");
  }

  async updateArticle(id: string, fields: { title?: string; summary?: string; content?: string }) {
    return this.request<Article>(`/api/articles/${id}/update`, {
      method: "POST",
      body: JSON.stringify(fields),
    });
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
  async triggerGeneration(keywordId?: string) {
    return this.request<{
      status: string;
      keyword_id: string;
      query: string;
      remaining: number;
    }>("/api/generate", {
      method: "POST",
      body: keywordId ? JSON.stringify({ keyword_id: keywordId }) : undefined,
    });
  }

  async generateBatch(keywordIds: string[]) {
    return this.request<{
      status: string;
      enqueued: Array<{ keyword_id: string; query: string }>;
      skipped: Array<{ keyword_id: string; query: string; reason: string }>;
      remaining: number;
    }>("/api/generate/batch", {
      method: "POST",
      body: JSON.stringify({ keyword_ids: keywordIds }),
    });
  }

  async getGenerationStatus() {
    return this.request<{
      remaining: number;
      queue: { pending: number; active: number; lastResult?: unknown };
    }>("/api/generate/status");
  }

  // Sync
  async getCollection() {
    return this.request<{ items: CMSItem[]; locales?: string[] }>("/api/sync/collection");
  }

  // Schema
  async getSchema() {
    return this.request<{ fields: CMSField[] }>("/api/schema");
  }

  // Generator settings
  async getSettings() {
    return this.request<GeneratorSettings>("/api/settings");
  }

  async updateSettings(patch: Partial<GeneratorSettings>) {
    return this.request<{ success: boolean; updated: string[] }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }
}

export interface Niche {
  name: string;
  persona: string;
  subniches: string[];
  kb_hints: string[];
  probation: boolean;
}

export interface GeneratorSettings {
  niches: Niche[];
  minPerNight: number;
  maxPerNight: number;
  scheduleHour: number;
  poolThreshold: number;
  rotationCursor: number;
  lastRunDate: string | null;
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
