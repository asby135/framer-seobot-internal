import { useState, useEffect } from "react";
import { framer } from "framer-plugin";

interface Props {
  onBack: () => void;
}

export function Settings({ onBack }: Props) {
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const collection = await framer.getManagedCollection();
    const url = await collection.getPluginData("baseUrl");
    setBaseUrl(url || "");
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
  disconnectButton: { padding: "8px 16px", background: "#5a2a2a", color: "#f88", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};
