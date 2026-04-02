import { useState, useEffect, useRef } from "react";
import { api, ApiError, type Article, type Asset } from "../api/client";
import { isTranslating as checkTranslating, startTranslating, stopTranslating, subscribe } from "../lib/translation-state";

interface Props {
  articleId: string;
  onBack: () => void;
}

export function ArticleDetail({ articleId, onBack }: Props) {
  const [article, setArticle] = useState<(Article & { assets: Asset[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showEditPrompt, setShowEditPrompt] = useState(false);
  const [editInstructions, setEditInstructions] = useState("");
  const [translating, setTranslating] = useState(checkTranslating(articleId));
  const [translateResult, setTranslateResult] = useState("");
  const abortRef = useRef(false);

  useEffect(() => {
    loadArticle();
  }, [articleId]);

  async function loadArticle() {
    setLoading(true);
    try {
      const data = await api.getArticle(articleId);
      setArticle(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load article");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteArticle(articleId);
      onBack();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      await api.regenerateArticle(articleId, editInstructions.trim() || undefined);
      onBack();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to regenerate");
    } finally {
      setRegenerating(false);
    }
  }

  // Sync translating state when component mounts and subscribe to changes
  useEffect(() => {
    setTranslating(checkTranslating(articleId));
    abortRef.current = false;
    const unsub = subscribe(() => {
      setTranslating(checkTranslating(articleId));
    });
    return () => { abortRef.current = true; unsub(); };
  }, [articleId]);

  async function handleTranslate() {
    setTranslating(true);
    startTranslating(articleId);
    setTranslateResult("");
    try {
      const result = await api.translateArticle(articleId);
      if (!abortRef.current) {
        const parts: string[] = [];
        if (result.translated.length > 0) parts.push(`Translated: ${result.translated.join(", ")}`);
        if (result.skipped.length > 0) parts.push(`Already done: ${result.skipped.join(", ")}`);
        if (result.failed.length > 0) parts.push(`Failed: ${result.failed.join(", ")}`);
        setTranslateResult(parts.join(". ") || "No translations needed");
      }
    } catch (e) {
      if (!abortRef.current) {
        setTranslateResult(e instanceof ApiError ? e.message : "Translation failed");
      }
    } finally {
      stopTranslating(articleId);
      if (!abortRef.current) {
        setTranslating(false);
      }
    }
  }

  async function handlePublish() {
    setPublishing(true);
    try {
      await api.publishArticle(articleId);
      await loadArticle();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to publish");
    } finally {
      setPublishing(false);
    }
  }

  if (loading) {
    return <div style={styles.center}><p style={styles.muted}>Loading...</p></div>;
  }

  if (error || !article) {
    return (
      <div style={styles.center}>
        <p style={styles.error}>{error || "Article not found"}</p>
        <button onClick={onBack} style={styles.backLink}>← Back</button>
      </div>
    );
  }

  let flags: Record<string, unknown> = {};
  try { flags = article.flags ? JSON.parse(article.flags) : {}; } catch { /* malformed flags */ }
  const groundingFlags = (flags.ungrounded_claims || flags.grounding_flags) as string[] | undefined;
  const thumbnail = article.assets?.find((a) => a.type === "thumbnail");

  return (
    <div style={styles.container}>
      <button onClick={onBack} style={styles.backLink}>← Back to Articles</button>

      <h3 style={styles.title}>{article.title}</h3>

      <div style={styles.statusRow}>
        <span>Status: </span>
        <span style={styles.statusValue}>{article.status}</span>
      </div>

      {/* Thumbnail preview */}
      {thumbnail ? (
        <div style={styles.thumbnailWrapper}>
          <img src={thumbnail.url} alt={thumbnail.alt_text || ""} style={styles.thumbnail} />
        </div>
      ) : flags.thumbnail_missing ? (
        <div style={styles.missingThumb}>No thumbnail generated</div>
      ) : null}

      {/* Grounding flags */}
      {groundingFlags && groundingFlags.length > 0 && (
        <div style={styles.flagSection}>
          <p style={styles.flagTitle}>⚠ Grounding flags ({groundingFlags.length}):</p>
          {groundingFlags.map((flag, i) => (
            <p key={i} style={styles.flagItem}>- {flag}</p>
          ))}
        </div>
      )}

      {/* Summary */}
      {article.summary && (
        <div style={styles.section}>
          <p style={styles.sectionLabel}>Summary</p>
          <p style={styles.summaryText}>{article.summary}</p>
        </div>
      )}

      {/* Article content preview */}
      {article.content && (
        <div style={styles.section}>
          <p style={styles.sectionLabel}>Article Preview</p>
          <div
            style={styles.contentPreview}
            dangerouslySetInnerHTML={{ __html: article.content }}
          />
        </div>
      )}

      {/* Edit / Regenerate prompt */}
      {(article.status === "draft" || article.status === "review") && (
        <div style={styles.section}>
          <button
            onClick={() => setShowEditPrompt(!showEditPrompt)}
            style={styles.editToggle}
          >
            {showEditPrompt ? "Cancel Edit" : "✎ Edit & Regenerate"}
          </button>
          {showEditPrompt && (
            <div style={styles.editArea}>
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                placeholder="e.g. Fix the grounding flags above, remove the claim about 800M users, add more detail about CRMChat's pipeline feature..."
                style={styles.editTextarea}
                rows={4}
              />
              <button
                onClick={handleRegenerate}
                disabled={regenerating}
                style={{ ...styles.regenerateButton, ...(regenerating ? styles.disabled : {}) }}
              >
                {regenerating ? "Regenerating..." : "Regenerate Article"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Translation — only for articles with content */}
      {article.content && article.status !== "generation_failed" && <div style={styles.section}>
        <button
          onClick={handleTranslate}
          disabled={translating}
          style={{ ...styles.translateButton, ...(translating ? styles.disabled : {}) }}
        >
          {translating ? "Translating (RU, UA, FR)..." : "Translate to RU / UA / FR"}
        </button>
        {translateResult && (
          <p style={styles.translateResult}>{translateResult}</p>
        )}
      </div>}

      {/* Actions */}
      <div style={styles.actions}>
        {(article.status === "draft" || article.status === "review") && (
          <button
            onClick={handlePublish}
            disabled={publishing}
            style={{ ...styles.publishButton, ...(publishing ? styles.disabled : {}) }}
          >
            {publishing ? "Publishing..." : "Publish"}
          </button>
        )}
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{ ...styles.deleteButton, ...(deleting ? styles.disabled : {}) }}
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, overflow: "auto", height: "100%" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 },
  muted: { color: "#888" },
  error: { color: "#f44", margin: "0 0 12px" },
  backLink: { background: "none", border: "none", color: "#888", cursor: "pointer", padding: 0, fontSize: 13, textAlign: "left" as const, marginBottom: 12 },
  title: { color: "#fff", fontSize: 16, fontWeight: 600, margin: "0 0 8px" },
  statusRow: { color: "#888", fontSize: 13, marginBottom: 16 },
  statusValue: { fontWeight: 500, color: "#e0e0e0" },
  thumbnailWrapper: { marginBottom: 16, borderRadius: 6, overflow: "hidden" },
  thumbnail: { width: "100%", height: "auto", display: "block" },
  missingThumb: { padding: 16, background: "#2a2a2a", borderRadius: 6, color: "#888", textAlign: "center" as const, marginBottom: 16 },
  flagSection: { background: "#3a2a1a", borderRadius: 6, padding: 12, marginBottom: 16 },
  flagTitle: { color: "#fa0", fontWeight: 500, margin: "0 0 4px", fontSize: 13 },
  flagItem: { color: "#ddd", margin: "2px 0", fontSize: 12 },
  section: { marginBottom: 16 },
  sectionLabel: { color: "#888", fontSize: 12, fontWeight: 500, margin: "0 0 4px" },
  summaryText: { color: "#ccc", margin: 0, lineHeight: 1.5 },
  contentPreview: { background: "#222", borderRadius: 6, padding: "12px 16px", color: "#ccc", fontSize: 13, lineHeight: 1.6, maxHeight: 400, overflow: "auto" },
  translateButton: { width: "100%", padding: "8px 0", background: "#1a3a5a", color: "#8bf", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 },
  translateResult: { color: "#8bf", fontSize: 12, marginTop: 6, textAlign: "center" as const },
  editToggle: { background: "none", border: "1px solid #444", borderRadius: 6, color: "#aaa", cursor: "pointer", padding: "6px 12px", fontSize: 13, width: "100%" },
  editArea: { marginTop: 8, display: "flex", flexDirection: "column" as const, gap: 8 },
  editTextarea: { background: "#2a2a2a", border: "1px solid #444", borderRadius: 6, padding: "8px 10px", color: "#fff", fontSize: 13, resize: "vertical" as const, outline: "none", fontFamily: "inherit", lineHeight: 1.4 },
  regenerateButton: { padding: "8px 0", background: "#3a3a1a", color: "#fa0", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 },
  actions: { display: "flex", gap: 8, marginTop: 8 },
  publishButton: { flex: 1, padding: "10px 0", background: "#2a5a2a", color: "#8f8", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 },
  deleteButton: { flex: 1, padding: "10px 0", background: "#5a2a2a", color: "#f88", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 },
  disabled: { opacity: 0.4, cursor: "not-allowed" },
};
