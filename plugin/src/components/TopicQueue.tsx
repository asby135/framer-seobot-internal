import { useState, useEffect } from "react";
import { api, ApiError, type Topic } from "../api/client";

export function TopicQueue() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customQuery, setCustomQuery] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [approvedCount, setApprovedCount] = useState(0);

  useEffect(() => {
    loadTopics();
  }, [page]);

  async function loadTopics() {
    setLoading(true);
    setError("");
    try {
      // Load approved keywords (no articles yet) and pending keywords
      const [approved, pending] = await Promise.all([
        api.getTopics("approved", 1, true),
        api.getTopics("pending", page),
      ]);
      // Approved on top, then pending
      setTopics([...approved.topics, ...pending.topics]);
      setTotalPages(pending.pages);
      setTotal(pending.total);
      setApprovedCount(approved.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load topics");
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApprove() {
    try {
      for (const id of selected) {
        await api.approveTopic(id);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to approve topics");
    }
    setSelected(new Set());
    loadTopics();
  }

  async function handleReject() {
    try {
      for (const id of selected) {
        await api.rejectTopic(id);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to reject topics");
    }
    setSelected(new Set());
    loadTopics();
  }

  async function handleCustomSubmit() {
    if (!customQuery.trim()) return;
    try {
      await api.createCustomTopic(customQuery.trim());
      setCustomQuery("");
      setShowCustom(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add topic");
    }
    loadTopics();
  }

  if (loading) {
    return <div style={styles.center}><p style={styles.muted}>Loading topics...</p></div>;
  }

  if (error) {
    return (
      <div style={styles.center}>
        <p style={styles.error}>{error}</p>
        <button onClick={loadTopics} style={styles.retryButton}>Retry</button>
      </div>
    );
  }

  if (topics.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyTitle}>No topics yet</p>
        <p style={styles.muted}>Run research to discover keywords from Google Search Console.</p>
        <button onClick={() => setShowCustom(true)} style={styles.actionButton}>+ Add Custom Topic</button>
        {showCustom && (
          <div style={styles.customRow}>
            <input
              value={customQuery}
              onChange={(e) => setCustomQuery(e.target.value)}
              placeholder="Enter a keyword..."
              style={styles.customInput}
              onKeyDown={(e) => e.key === "Enter" && handleCustomSubmit()}
            />
            <button onClick={handleCustomSubmit} style={styles.smallButton}>Add</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Stats bar with pagination */}
      <div style={styles.statsBar}>
        <span>{approvedCount > 0 ? `${approvedCount} approved · ` : ""}{total} pending</span>
        {totalPages > 1 && (
          <span style={styles.pagination}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{ ...styles.pageButton, ...(page <= 1 ? styles.disabled : {}) }}
            >
              ‹
            </button>
            <span>{page}/{totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{ ...styles.pageButton, ...(page >= totalPages ? styles.disabled : {}) }}
            >
              ›
            </button>
          </span>
        )}
      </div>

      {/* Topic list — scrollable */}
      <div style={styles.list}>
        {topics.map((t) => (
          <div
            key={t.id}
            onClick={() => toggleSelect(t.id)}
            style={{
              ...styles.row,
              ...(selected.has(t.id) ? styles.rowSelected : {}),
            }}
          >
            <div style={styles.checkbox}>
              {selected.has(t.id) ? "☑" : "☐"}
            </div>
            <div style={styles.rowContent}>
              <div style={styles.query}>{t.query}</div>
              <div style={styles.meta}>
                {t.status === "approved" ? <span style={styles.approvedBadge}>APPROVED</span> : null}
                {t.opportunity_score?.toFixed(0)} pts · {t.impressions?.toLocaleString()} impressions
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer — pinned to bottom */}
      <div style={styles.footer}>
        <div style={styles.actions}>
          <button
            onClick={handleApprove}
            disabled={selected.size === 0}
            style={{
              ...styles.approveButton,
              ...(selected.size === 0 ? styles.disabled : {}),
            }}
          >
            ✓ Approve
          </button>
          <button
            onClick={handleReject}
            disabled={selected.size === 0}
            style={{
              ...styles.rejectButton,
              ...(selected.size === 0 ? styles.disabled : {}),
            }}
          >
            ✗ Reject
          </button>
          <button
            onClick={() => setShowCustom(!showCustom)}
            style={styles.customButton}
          >
            + Custom
          </button>
        </div>

        {showCustom && (
          <div style={styles.customRow}>
            <input
              value={customQuery}
              onChange={(e) => setCustomQuery(e.target.value)}
              placeholder="Enter a keyword..."
              style={styles.customInput}
              onKeyDown={(e) => e.key === "Enter" && handleCustomSubmit()}
              autoFocus
            />
            <button onClick={handleCustomSubmit} style={styles.smallButton}>Add</button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 },
  statsBar: { padding: "8px 16px", fontSize: 12, color: "#888", borderBottom: "1px solid #2a2a2a", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" },
  pagination: { display: "flex", alignItems: "center", gap: 6 },
  pageButton: { background: "none", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", padding: "2px 6px", fontSize: 12 },
  list: { flex: 1, overflow: "auto", minHeight: 0 },
  footer: { flexShrink: 0, borderTop: "1px solid #333", background: "#1a1a1a" },
  row: { display: "flex", alignItems: "flex-start", padding: "10px 16px", borderBottom: "1px solid #2a2a2a", cursor: "pointer", gap: 8 },
  rowSelected: { background: "#2a2a2a" },
  checkbox: { color: "#888", fontSize: 14, marginTop: 1, flexShrink: 0 },
  rowContent: { flex: 1, minWidth: 0 },
  query: { color: "#e0e0e0", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  meta: { color: "#888", fontSize: 12, marginTop: 2, display: "flex", alignItems: "center", gap: 6 },
  approvedBadge: { background: "#2a5a2a", color: "#8f8", fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3 },
  actions: { display: "flex", gap: 8, padding: "12px 16px" },
  approveButton: { flex: 1, padding: "8px 0", background: "#2a5a2a", color: "#8f8", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 },
  rejectButton: { flex: 1, padding: "8px 0", background: "#5a2a2a", color: "#f88", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 },
  customButton: { padding: "8px 12px", background: "#333", color: "#aaa", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  disabled: { opacity: 0.4, cursor: "not-allowed" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, gap: 8, height: "100%" },
  emptyTitle: { color: "#e0e0e0", fontWeight: 500, margin: 0 },
  muted: { color: "#888", margin: 0, textAlign: "center" as const },
  error: { color: "#f44", margin: "0 0 12px" },
  retryButton: { padding: "6px 16px", background: "#333", color: "#e0e0e0", border: "none", borderRadius: 6, cursor: "pointer" },
  actionButton: { padding: "8px 16px", background: "#333", color: "#e0e0e0", border: "none", borderRadius: 6, cursor: "pointer", marginTop: 8 },
  customRow: { display: "flex", gap: 8, padding: "8px 16px" },
  customInput: { flex: 1, background: "#2a2a2a", border: "1px solid #444", borderRadius: 6, padding: "6px 10px", color: "#fff", fontSize: 13, outline: "none" },
  smallButton: { padding: "6px 12px", background: "#444", color: "#e0e0e0", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};
