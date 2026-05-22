import { useState, useEffect } from "react";
import { framer } from "framer-plugin";

interface Props {
  onBack: () => void;
}

export function Settings({ onBack }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const collection = await framer.getManagedCollection();
    const url = await collection.getPluginData("baseUrl");
    const key = await collection.getPluginData("apiKey");
    setBaseUrl(url || "");
    setApiKey(key || "");
  }

  async function handleCopyKey() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — reveal so the user can select and copy manually
      setRevealed(true);
    }
  }

  async function handleDisconnect() {
    const collection = await framer.getManagedCollection();
    await collection.setPluginData("baseUrl", "");
    await collection.setPluginData("apiKey", "");
    // Force reload to show setup flow
    window.location.reload();
  }

  return (
    <div style={styles.container}>
      <button onClick={onBack} style={styles.backLink}>← Back</button>

      <h3 style={styles.title}>Settings</h3>

      <div style={styles.field}>
        <label style={styles.label}>Backend URL</label>
        <div style={styles.valueRow}>
          <span style={styles.value}>{baseUrl || "Not connected"}</span>
          <span style={styles.connected}>● Connected</span>
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>API Key</label>
        <div style={styles.keyValue}>
          {apiKey ? (revealed ? apiKey : "•".repeat(Math.min(apiKey.length, 36))) : "Not set"}
        </div>
        {apiKey && (
          <div style={styles.keyActions}>
            <button onClick={() => setRevealed((r) => !r)} style={styles.smallButton}>
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button onClick={handleCopyKey} style={styles.smallButton}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        )}
        <p style={styles.keyHint}>Used as the Bearer token for direct API calls (e.g. seeding topics via curl).</p>
      </div>

      <button onClick={handleDisconnect} style={styles.disconnectButton}>
        Disconnect
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, fontFamily: "Inter, system-ui, sans-serif", color: "#e0e0e0", background: "#1a1a1a", height: "100%" },
  backLink: { background: "none", border: "none", color: "#888", cursor: "pointer", padding: 0, fontSize: 13, marginBottom: 16, display: "block" },
  title: { color: "#fff", fontSize: 16, fontWeight: 600, margin: "0 0 24px" },
  field: { marginBottom: 24 },
  label: { fontSize: 12, fontWeight: 500, color: "#888", display: "block", marginBottom: 4 },
  valueRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  value: { color: "#ccc", fontSize: 13, wordBreak: "break-all" as const },
  connected: { color: "#8f8", fontSize: 12, flexShrink: 0, marginLeft: 8 },
  keyValue: { color: "#ccc", fontSize: 13, fontFamily: "monospace", wordBreak: "break-all" as const, background: "#2a2a2a", border: "1px solid #444", borderRadius: 6, padding: "8px 10px", minHeight: 18 },
  keyActions: { display: "flex", gap: 8, marginTop: 8 },
  smallButton: { padding: "6px 12px", background: "#333", color: "#e0e0e0", border: "1px solid #444", borderRadius: 6, cursor: "pointer", fontSize: 12 },
  keyHint: { color: "#888", fontSize: 11, margin: "8px 0 0", lineHeight: 1.4 },
  disconnectButton: { padding: "8px 16px", background: "#5a2a2a", color: "#f88", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};
