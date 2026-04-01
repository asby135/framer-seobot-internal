import { useState, useEffect } from "react";
import { api, ApiError, type Topic } from "../api/client";

export function GeneratePanel() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; status: string; message: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [topicsRes, statusRes] = await Promise.all([
        api.getTopics("approved", 1, true),
        api.getGenerationStatus(),
      ]);
      setTopics(topicsRes.topics);
      setRemaining(statusRes.remaining);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate(topicId: string) {
    setGeneratingId(topicId);
    setResult(null);

    try {
      const res = await api.triggerGeneration(topicId);
      setResult({ id: topicId, status: "success", message: `"${res.query}" queued. Check Articles tab.` });
      setRemaining(res.remaining);
      // Remove from list
      setTopics((prev) => prev.filter((t) => t.id !== topicId));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429) {
          setResult({ id: topicId, status: "error", message: "Rate limit reached. Try again later." });
        } else if (e.status === 409) {
          setResult({ id: topicId, status: "error", message: "Generation already in progress. Wait for it to finish." });
        } else {
          setResult({ id: topicId, status: "error", message: e.message });
        }
      } else {
        setResult({ id: topicId, status: "error", message: "Failed to start generation." });
      }
    } finally {
      setGeneratingId(null);
    }
  }

  if (loading) {
    return <div style={styles.center}><p style={styles.muted}>Loading...</p></div>;
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.muted}>
          {remaining !== null ? `${remaining} generations remaining this hour` : ""}
        </span>
      </div>

      {/* Result message */}
      {result && (
        <div style={result.status === "success" ? styles.successBanner : styles.errorBanner}>
          <p style={styles.bannerText}>{result.message}</p>
        </div>
      )}

      {/* Approved topics list */}
      {topics.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No approved topics</p>
          <p style={styles.muted}>Approve topics in the Topics tab first, then come back here to generate articles.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {topics.map((t) => (
            <div key={t.id} style={styles.row}>
              <div style={styles.rowContent}>
                <div style={styles.query}>{t.query}</div>
                <div style={styles.meta}>
                  {t.opportunity_score?.toFixed(0)} pts · {t.impressions?.toLocaleString()} impressions
                </div>
              </div>
              <button
                onClick={() => handleGenerate(t.id)}
                disabled={generatingId !== null || remaining === 0}
                style={{
                  ...styles.generateButton,
                  ...(generatingId !== null || remaining === 0 ? styles.disabled : {}),
                }}
              >
                {generatingId === t.id ? "..." : "Generate"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%" },
  center: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%" },
  header: { padding: "8px 16px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 },
  muted: { color: "#888", fontSize: 12, margin: 0, textAlign: "center" as const },
  successBanner: { padding: "8px 16px", background: "#1a3a1a", flexShrink: 0 },
  errorBanner: { padding: "8px 16px", background: "#3a1a1a", flexShrink: 0 },
  bannerText: { color: "#ccc", fontSize: 12, margin: 0, textAlign: "center" as const },
  list: { flex: 1, overflow: "auto", minHeight: 0 },
  row: { display: "flex", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #2a2a2a", gap: 8 },
  rowContent: { flex: 1, minWidth: 0 },
  query: { color: "#e0e0e0", fontWeight: 500, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  meta: { color: "#888", fontSize: 12, marginTop: 2 },
  generateButton: { padding: "6px 14px", background: "#2a5a2a", color: "#8f8", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 500, flexShrink: 0 },
  disabled: { opacity: 0.4, cursor: "not-allowed" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 32, gap: 8 },
  emptyTitle: { color: "#e0e0e0", fontWeight: 500, margin: 0 },
};
