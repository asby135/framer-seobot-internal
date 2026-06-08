import { useState, useEffect, useRef, useCallback } from "react";
import { api, ApiError, type Article } from "../api/client";
import { ArticleDetail } from "./ArticleDetail";
import { isTranslating, subscribe, startTranslating, stopTranslating } from "../lib/translation-state";
import { humanStatus } from "../lib/format";

export function ArticleList() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genQueueDepth, setGenQueueDepth] = useState(0);
  const [translateQueueDepth, setTranslateQueueDepth] = useState(0);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [translateMessage, setTranslateMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceUpdate] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const translatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchTranslatingIdsRef = useRef<Set<string>>(new Set());

  // Re-render when translation state changes
  const triggerUpdate = useCallback(() => forceUpdate((n) => n + 1), []);

  useEffect(() => {
    loadArticles();
    checkGenerationStatus();
    checkTranslationStatus();
    const unsub = subscribe(triggerUpdate);
    return () => { stopPolling(); stopTranslatePolling(); unsub(); };
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
      const depth = status.queue.pending + status.queue.active;
      setGenQueueDepth(depth);
      if (depth > 0) {
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
        const depth = status.queue.pending + status.queue.active;
        setGenQueueDepth(depth);
        if (depth === 0) {
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

  async function checkTranslationStatus() {
    try {
      const status = await api.getTranslationStatus();
      const depth = status.queue.pending + status.queue.active;
      setTranslateQueueDepth(depth);
      if (depth > 0) startTranslatePolling();
    } catch {
      // ignore
    }
  }

  function startTranslatePolling() {
    stopTranslatePolling();
    translatePollRef.current = setInterval(async () => {
      try {
        const status = await api.getTranslationStatus();
        const depth = status.queue.pending + status.queue.active;
        setTranslateQueueDepth(depth);
        if (depth === 0) {
          // Clear all batch-translating badges and refresh
          for (const id of batchTranslatingIdsRef.current) {
            stopTranslating(id);
          }
          batchTranslatingIdsRef.current.clear();
          stopTranslatePolling();
          loadArticles();
        }
      } catch {
        // ignore
      }
    }, 5000);
  }

  function stopTranslatePolling() {
    if (translatePollRef.current) {
      clearInterval(translatePollRef.current);
      translatePollRef.current = null;
    }
  }

  function toggleBatch(id: string) {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handlePublishBatch() {
    if (batchSelected.size === 0) return;
    // Only draft/review articles are publishable. Pre-filter so we don't
    // bother the backend with already-published or generation_failed rows.
    const publishable = articles.filter(
      (a) => batchSelected.has(a.id) && (a.status === "draft" || a.status === "review")
    );
    if (publishable.length === 0) {
      setTranslateMessage("No selected articles are in draft / review.");
      return;
    }
    setTranslateMessage("");
    let ok = 0;
    let failed = 0;
    for (const a of publishable) {
      try {
        await api.publishArticle(a.id);
        ok++;
      } catch {
        failed++;
      }
    }
    setBatchSelected(new Set());
    setTranslateMessage(
      failed > 0
        ? `Published ${ok}, ${failed} failed.`
        : `Published ${ok} article${ok === 1 ? "" : "s"}.`
    );
    loadArticles();
  }

  async function handleDeleteBatch() {
    if (batchSelected.size === 0) return;
    if (!confirmDelete) {
      // First click — arm the confirm. Auto-disarm after 4s.
      setConfirmDelete(true);
      if (deleteResetRef.current) clearTimeout(deleteResetRef.current);
      deleteResetRef.current = setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    // Second click within the window — execute.
    if (deleteResetRef.current) {
      clearTimeout(deleteResetRef.current);
      deleteResetRef.current = null;
    }
    setConfirmDelete(false);
    const ids = Array.from(batchSelected);
    const n = ids.length;
    setTranslateMessage("");
    try {
      for (const id of ids) {
        await api.deleteArticle(id);
      }
      setBatchSelected(new Set());
      setTranslateMessage(`Deleted ${n} article${n === 1 ? "" : "s"}.`);
      loadArticles();
    } catch (e) {
      setTranslateMessage(
        e instanceof ApiError ? e.message : "Failed to delete some articles."
      );
      loadArticles(); // reload anyway — some may have deleted before the failure
    }
  }

  async function handleTranslateBatch() {
    if (batchSelected.size === 0) return;
    const ids = Array.from(batchSelected);
    setTranslateMessage("");
    try {
      const res = await api.translateBatch(ids, false);
      const queued = res.enqueued.length;
      // Mark all enqueued articles as translating until the queue drains
      for (const e of res.enqueued) {
        startTranslating(e.article_id);
        batchTranslatingIdsRef.current.add(e.article_id);
      }
      setTranslateMessage(`${queued} translation${queued === 1 ? "" : "s"} queued.`);
      setBatchSelected(new Set());
      startTranslatePolling();
    } catch (e) {
      setTranslateMessage(e instanceof ApiError ? e.message : "Batch translation failed.");
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
    return <div style={styles.center}><p style={styles.muted}>Loading articles…</p></div>;
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
          <span>
            {genQueueDepth > 1
              ? `Generating ${genQueueDepth} articles…`
              : "Generating article…"}
          </span>
        </div>
      )}

      {/* Translation queue banner */}
      {translateQueueDepth > 0 && (
        <div style={styles.translatingBanner}>
          <span style={styles.spinnerInline}>↻</span>
          <span>Translating {translateQueueDepth} article{translateQueueDepth === 1 ? "" : "s"}…</span>
        </div>
      )}

      {/* Batch translate result */}
      {translateMessage && (
        <div style={styles.translateMessage}>{translateMessage}</div>
      )}

      {articles.length === 0 && !generating ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No articles yet</p>
          <p style={styles.muted}>Approve topics and generate articles to see them here.</p>
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {articles.map((a) => {
              let flags: Record<string, unknown> = {};
              try { flags = a.flags ? JSON.parse(a.flags) : {}; } catch { /* malformed flags */ }
              const hasFlags = Object.keys(flags).length > 0;
              const translatingThis = isTranslating(a.id);
              const isBatchSelected = batchSelected.has(a.id);

              return (
                <div
                  key={a.id}
                  style={{
                    ...styles.row,
                    ...(isBatchSelected ? styles.rowSelected : {}),
                  }}
                >
                  <div
                    style={styles.checkbox}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBatch(a.id);
                    }}
                  >
                    {isBatchSelected ? "☑" : "☐"}
                  </div>
                  <div
                    style={styles.rowContent}
                    onClick={() => setSelectedId(a.id)}
                  >
                    <div style={styles.titleRow}>
                      {hasFlags && <span style={styles.flagIcon}>⚠</span>}
                      <span style={styles.title}>{a.title}</span>
                    </div>
                    <div style={styles.meta}>
                      <span style={{
                        ...styles.statusPill,
                        ...(statusColors[a.status] || {}),
                      }}>
                        {humanStatus(a.status)}
                      </span>
                      {translatingThis && (
                        <span style={styles.translatingPill}>
                          <span style={styles.pillSpinner}>↻</span> translating
                        </span>
                      )}
                      {Boolean(flags.thumbnail_missing) && (
                        <span style={styles.flag}>No thumbnail</span>
                      )}
                    </div>
                  </div>
                  <span
                    style={styles.chevron}
                    onClick={() => setSelectedId(a.id)}
                  >
                    ›
                  </span>
                </div>
              );
            })}
          </div>
          {batchSelected.size > 0 && (
            <div style={styles.footer}>
              <div style={styles.footerRow}>
                <button onClick={handlePublishBatch} style={styles.publishButton}>
                  ✓ Publish {batchSelected.size}
                </button>
                <button onClick={handleTranslateBatch} style={styles.batchButton}>
                  ↻ Translate {batchSelected.size}
                </button>
                <button
                  onClick={handleDeleteBatch}
                  style={confirmDelete ? styles.deleteConfirmButton : styles.deleteButton}
                >
                  {confirmDelete ? `Confirm — delete ${batchSelected.size}?` : `🗑 Delete ${batchSelected.size}`}
                </button>
              </div>
            </div>
          )}
        </>
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
  translatingBanner: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", background: "#1a3a5a", color: "#8bf", fontSize: 13, fontWeight: 500, flexShrink: 0 },
  translateMessage: { padding: "8px 16px", color: "#aaa", fontSize: 12, textAlign: "center" as const, background: "#1a1a1a", flexShrink: 0 },
  spinnerInline: { display: "inline-block", animation: "spin 1s linear infinite", fontSize: 16 },
  list: { flex: 1, overflow: "auto", minHeight: 0 },
  row: { display: "flex", alignItems: "flex-start", padding: "10px 16px", borderBottom: "1px solid #2a2a2a", gap: 8 },
  rowSelected: { background: "#2a2a2a" },
  checkbox: { color: "#888", fontSize: 14, marginTop: 1, flexShrink: 0, cursor: "pointer", padding: 2 },
  footer: { flexShrink: 0, borderTop: "1px solid #333", background: "#1a1a1a", padding: "10px 16px" },
  footerRow: { display: "flex", gap: 8 },
  publishButton: { flex: 1, padding: "10px 0", background: "#2a5a2a", color: "#8f8", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  batchButton: { flex: 1, padding: "10px 0", background: "#1a3a5a", color: "#8bf", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  deleteButton: { padding: "10px 14px", background: "#3a2020", color: "#f88", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, flexShrink: 0 },
  deleteConfirmButton: { padding: "10px 14px", background: "#7a2a2a", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, flexShrink: 0 },
  rowContent: { flex: 1, minWidth: 0, cursor: "pointer" },
  titleRow: { display: "flex", alignItems: "flex-start", gap: 6 },
  flagIcon: { color: "#fa0", fontSize: 12, flexShrink: 0, marginTop: 3 },
  title: { color: "#e0e0e0", fontWeight: 500, lineHeight: 1.35, overflowWrap: "anywhere" },
  meta: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
  statusPill: { fontSize: 11, padding: "1px 8px", borderRadius: 4, fontWeight: 500 },
  translatingPill: { fontSize: 11, padding: "1px 8px", borderRadius: 4, fontWeight: 500, background: "#1a3a5a", color: "#8bf", display: "inline-flex", alignItems: "center", gap: 4 },
  pillSpinner: { display: "inline-block", animation: "spin 1s linear infinite" },
  flag: { fontSize: 11, color: "#888" },
  chevron: { color: "#555", fontSize: 18, flexShrink: 0, cursor: "pointer" },
};
