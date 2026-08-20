import { useState, useEffect } from "react";
import { framer } from "framer-plugin";
import { api, type GeneratorSettings, type Niche } from "../api/client";

interface Props {
  onBack: () => void;
}

export function Settings({ onBack }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [gen, setGen] = useState<GeneratorSettings | null>(null);
  const [genStatus, setGenStatus] = useState("");
  const [openNiche, setOpenNiche] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    api.getSettings().then(setGen).catch(() => setGen(null));
  }, []);

  async function saveGenerator(patch: Partial<GeneratorSettings>) {
    setGenStatus("Saving…");
    try {
      await api.updateSettings(patch);
      setGen((g) => (g ? { ...g, ...patch } : g));
      setGenStatus("Saved ✓");
    } catch (e) {
      // The backend validates persona length and the nightly cap; surface its
      // message rather than a generic failure so the fix is obvious.
      setGenStatus(e instanceof Error ? e.message : "Save failed");
    }
    setTimeout(() => setGenStatus(""), 3000);
  }

  function updateNiche(index: number, patch: Partial<Niche>) {
    if (!gen) return;
    const niches = gen.niches.map((n, i) => (i === index ? { ...n, ...patch } : n));
    setGen({ ...gen, niches });
  }

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

      {gen && (
        <div style={styles.field}>
          <h4 style={styles.sectionTitle}>Generator</h4>

          <label style={styles.label}>Articles per night</label>
          <div style={styles.row}>
            <input
              type="number" min={1} max={20} value={gen.minPerNight}
              onChange={(e) => setGen({ ...gen, minPerNight: Number(e.target.value) })}
              style={styles.numberInput}
            />
            <span style={styles.rowSep}>to</span>
            <input
              type="number" min={1} max={20} value={gen.maxPerNight}
              onChange={(e) => setGen({ ...gen, maxPerNight: Number(e.target.value) })}
              style={styles.numberInput}
            />
            <button
              style={styles.smallButton}
              onClick={() => saveGenerator({ minPerNight: gen.minPerNight, maxPerNight: gen.maxPerNight })}
            >
              Save
            </button>
          </div>

          <label style={{ ...styles.label, marginTop: 16 }}>Digest hour (24h, local)</label>
          <div style={styles.row}>
            <input
              type="number" min={0} max={23} value={gen.scheduleHour}
              onChange={(e) => setGen({ ...gen, scheduleHour: Number(e.target.value) })}
              style={styles.numberInput}
            />
            <button style={styles.smallButton} onClick={() => saveGenerator({ scheduleHour: gen.scheduleHour })}>
              Save
            </button>
          </div>

          <label style={{ ...styles.label, marginTop: 16 }}>
            Niches ({gen.niches.filter((n) => !n.probation).length} active, {gen.niches.filter((n) => n.probation).length} on probation)
          </label>
          <p style={styles.keyHint}>
            Probationary niches are seeded but excluded from automatic selection until you approve
            their topics by hand. Clear probation once a niche is producing good output.
          </p>

          {gen.niches.map((n, i) => (
            <div key={n.name} style={styles.nicheRow}>
              <div style={styles.nicheHead}>
                <button
                  onClick={() => setOpenNiche(openNiche === n.name ? null : n.name)}
                  style={styles.nicheToggle}
                >
                  {openNiche === n.name ? "▾" : "▸"} {n.name}
                </button>
                <label style={styles.probationLabel}>
                  <input
                    type="checkbox"
                    checked={n.probation}
                    onChange={(e) => updateNiche(i, { probation: e.target.checked })}
                  />
                  probation
                </label>
              </div>
              {openNiche === n.name && (
                <>
              <textarea
                value={n.persona}
                onChange={(e) => updateNiche(i, { persona: e.target.value })}
                style={styles.personaInput}
                rows={2}
              />
              <input
                value={n.subniches.join(", ")}
                onChange={(e) =>
                  updateNiche(i, {
                    subniches: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                  })
                }
                style={styles.subnicheInput}
                placeholder="comma-separated subniches"
              />
                </>
              )}
            </div>
          ))}

          <button style={styles.saveButton} onClick={() => saveGenerator({ niches: gen.niches })}>
            Save niches
          </button>
          {genStatus && <p style={styles.keyHint}>{genStatus}</p>}
        </div>
      )}

    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, fontFamily: "Inter, system-ui, sans-serif", color: "#e0e0e0", background: "#1a1a1a", height: "100%", overflow: "auto", boxSizing: "border-box" as const },
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
  sectionTitle: { color: "#fff", fontSize: 14, fontWeight: 600, margin: "0 0 12px", paddingTop: 16, borderTop: "1px solid #333" },
  row: { display: "flex", alignItems: "center", gap: 8 },
  rowSep: { color: "#888", fontSize: 12 },
  numberInput: { width: 64, padding: "6px 8px", background: "#2a2a2a", color: "#e0e0e0", border: "1px solid #444", borderRadius: 6, fontSize: 13 },
  nicheRow: { background: "#222", border: "1px solid #333", borderRadius: 8, padding: 10, marginBottom: 8 },
  nicheHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  nicheName: { color: "#fff", fontSize: 13, fontWeight: 500 },
  nicheToggle: { background: "none", border: "none", color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", padding: 0, textAlign: "left" as const },
  probationLabel: { color: "#c99", fontSize: 11, display: "flex", alignItems: "center", gap: 4 },
  personaInput: { width: "100%", boxSizing: "border-box" as const, padding: "6px 8px", background: "#2a2a2a", color: "#ccc", border: "1px solid #444", borderRadius: 6, fontSize: 12, resize: "vertical" as const, fontFamily: "inherit" },
  subnicheInput: { width: "100%", boxSizing: "border-box" as const, marginTop: 6, padding: "6px 8px", background: "#2a2a2a", color: "#ccc", border: "1px solid #444", borderRadius: 6, fontSize: 12 },
  saveButton: { padding: "8px 16px", background: "#2a4a2a", color: "#8f8", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, marginTop: 4 },
};
