import { useState, useEffect } from "react";
import { api, ApiError } from "../api/client";

export function GeneratePanel() {
  const [generating, setGenerating] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<{
    status: string;
    query?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const data = await api.getGenerationStatus();
      setRemaining(data.remaining);
    } catch {
      // ignore
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setLastResult(null);

    try {
      const result = await api.triggerGeneration();
      setLastResult({ status: "queued", query: result.query });
      setRemaining(result.remaining);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429) {
          setLastResult({ status: "error", error: "Rate limit reached. Try again later." });
        } else if (e.status === 404) {
          setLastResult({ status: "error", error: "No approved topics to generate. Approve topics first." });
        } else {
          setLastResult({ status: "error", error: e.message });
        }
      } else {
        setLastResult({ status: "error", error: "Failed to start generation." });
      }
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        {remaining !== null && (
          <p style={styles.muted}>{remaining} generations remaining this hour</p>
        )}

        {generating ? (
          <div style={styles.generating}>
            <p style={styles.generatingText}>Generating...</p>
            <p style={styles.muted}>
              You can close this window. Generation continues in the background on your server.
            </p>
          </div>
        ) : lastResult ? (
          <div style={styles.result}>
            {lastResult.status === "queued" ? (
              <>
                <p style={styles.successText}>Generation started</p>
                <p style={styles.muted}>"{lastResult.query}" is being generated. Check the Articles tab for results.</p>
              </>
            ) : (
              <p style={styles.errorText}>{lastResult.error}</p>
            )}
          </div>
        ) : (
          <div style={styles.idle}>
            <p style={styles.idleText}>Generate articles from approved topics</p>
            <p style={styles.muted}>Each generation creates one article with thumbnail and screenshots.</p>
          </div>
        )}
      </div>

      <div style={styles.actions}>
        <button
          onClick={handleGenerate}
          disabled={generating || remaining === 0}
          style={{
            ...styles.generateButton,
            ...(generating || remaining === 0 ? styles.disabled : {}),
          }}
        >
          {generating ? "Generating..." : "Generate Article"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", padding: 16 },
  content: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" },
  muted: { color: "#888", fontSize: 12, margin: "4px 0", textAlign: "center" as const },
  generating: { textAlign: "center" as const },
  generatingText: { color: "#e0e0e0", fontWeight: 500, fontSize: 15 },
  result: { textAlign: "center" as const },
  successText: { color: "#8f8", fontWeight: 500, fontSize: 15 },
  errorText: { color: "#f88", fontSize: 13 },
  idle: { textAlign: "center" as const },
  idleText: { color: "#e0e0e0", fontWeight: 500, margin: "0 0 4px" },
  actions: { borderTop: "1px solid #333", paddingTop: 12 },
  generateButton: { width: "100%", padding: "10px 0", background: "#fff", color: "#000", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 },
  disabled: { opacity: 0.4, cursor: "not-allowed" },
};
