import { useState, useEffect, useRef } from "react";
import { api, ApiError, type Article } from "../api/client";
import { ArticleDetail } from "./ArticleDetail";

export function ArticleList() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadArticles();
    checkGenerationStatus();
    return () => stopPolling();
  }, []);

  async function loadArticles() {
    setLoading(true);
    setError("");
    try {
      const { articles } = await api.getArticles();
      setArticles(articles);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load articles");
    } finally {
      setLoading(false);
    }
  }

  async function checkGenerationStatus() {
    try {
      const status = await api.getGenerationStatus();
      if (status.queue.active > 0 || status.queue.pending > 0) {
        setGenerating(true);
        startPolling();
      }
    } catch {
      // ignore
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await api.getGenerationStatus();
        if (status.queue.pending === 0 && status.queue.active === 0) {
          setGenerating(false);
          stopPolling();
          loadArticles(); // Refresh to show the new article
        }
      } catch {
        // ignore
      }
    }, 5000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  if (selectedId) {
    return (
      <ArticleDetail
        articleId={selectedId}
        onBack={() => {
          setSelectedId(null);
          loadArticles();
        }}
      />
    );
  }

  if (loading) {
    return <div style={styles.center}><p style={styles.muted}>Loading articles...</p></div>;
  }

  if (error) {
    return (
      <div style={styles.center}>
        <p style={styles.error}>{error}</p>
        <button onClick={loadArticles} style={styles.retryButton}>Retry</button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Generation in progress banner */}
      {generating && (
        <div style={styles.generatingBanner}>
          <span style={styles.spinnerInline}>↻</span>
          <span>Article is being generated...</span>
        </div>
      )}

      {articles.length === 0 && !generating ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No articles yet</p>
          <p style={styles.muted}>Approve topics and generate articles to see them here.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {articles.map((a) => {
            let flags: Record<string, unknown> = {};
            try { flags = a.flags ? JSON.parse(a.flags) : {}; } catch { /* malformed flags */ }
            const hasFlags = Object.keys(flags).length > 0;

            return (
              <div
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                style={styles.row}
              >
                <div style={styles.rowContent}>
                  <div style={styles.titleRow}>
                    {hasFlags && <span style={styles.flagIcon}>⚠</span>}
                    <span style={styles.title}>{a.title}</span>
                  </div>
                  <div style={styles.meta}>
                    <span style={{
                      ...styles.statusPill,
                      ...(statusColors[a.status] || {}),
                    }}>
                      {a.status}
                    </span>
                    {Boolean(flags.thumbnail_missing) && (
                      <span style={styles.flag}>No thumbnail</span>
                    )}
                  </div>
                </div>
                <span style={styles.chevron}>›</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const statusColors: Record<string, React.CSSProperties> = {
  draft: { background: "#333", color: "#aaa" },
  review: { background: "#5a4a2a", color: "#fa0" },
  published: { background: "#2a4a2a", color: "#8f8" },
  generation_failed: { background: "#5a2a2a", color: "#f88" },
  archived: { background: "#2a2a2a", color: "#666" },
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, gap: 8, height: "100%" },
  emptyTitle: { color: "#e0e0e0", fontWeight: 500, margin: 0 },
  muted: { color: "#888", margin: 0, textAlign: "center" as const },
  error: { color: "#f44", margin: "0 0 12px" },
  retryButton: { padding: "6px 16px", background: "#333", color: "#e0e0e0", border: "none", borderRadius: 6, cursor: "pointer" },
  generatingBanner: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", background: "#1a3a1a", color: "#8f8", fontSize: 13, fontWeight: 500, flexShrink: 0 },
  spinnerInline: { display: "inline-block", animation: "spin 1s linear infinite", fontSize: 16 },
  list: { flex: 1, overflow: "auto", minHeight: 0 },
  row: { display: "flex", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #2a2a2a", cursor: "pointer", gap: 8 },
  rowContent: { flex: 1, minWidth: 0 },
  titleRow: { display: "flex", alignItems: "center", gap: 6 },
  flagIcon: { color: "#fa0", fontSize: 12, flexShrink: 0 },
  title: { color: "#e0e0e0", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  meta: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
  statusPill: { fontSize: 11, padding: "1px 8px", borderRadius: 4, fontWeight: 500 },
  flag: { fontSize: 11, color: "#888" },
  chevron: { color: "#555", fontSize: 18, flexShrink: 0 },
};
