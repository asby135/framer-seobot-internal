import { useState } from "react";
import { api, ApiError } from "../api/client";

interface Props {
  onComplete: (baseUrl: string, apiKey: string) => void;
}

export function SetupFlow({ onComplete }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    if (!baseUrl.trim() || !secret.trim()) {
      setError("Both fields are required");
      return;
    }

    setError("");
    setConnecting(true);

    try {
      const result = await api.setup(baseUrl.trim(), secret.trim());
      onComplete(baseUrl.trim(), result.api_key);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(
          e.status === 403
            ? "Invalid setup secret"
            : e.status === 500
              ? "Server not configured. Check SETUP_SECRET env var."
              : e.message
        );
      } else {
        setError("Could not reach backend. Check the URL.");
      }
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>CRMChat SEO Engine</h2>
      <p style={styles.subtitle}>
        Connect your backend to get started. You'll need the URL and setup
        secret from Railway.
      </p>

      <label style={styles.label}>Backend URL</label>
      <input
        type="url"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://your-app.railway.app"
        style={styles.input}
        disabled={connecting}
      />

      <label style={styles.label}>Setup Secret</label>
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="Your setup secret"
        style={styles.input}
        disabled={connecting}
        onKeyDown={(e) => e.key === "Enter" && handleConnect()}
      />

      {error && <p style={styles.error}>{error}</p>}

      <button
        onClick={handleConnect}
        disabled={connecting}
        style={{
          ...styles.button,
          ...(connecting ? styles.buttonDisabled : {}),
        }}
      >
        {connecting ? "Connecting..." : "Connect"}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    padding: "48px 24px 24px",
    background: "#1a1a1a",
    color: "#e0e0e0",
    height: "100%",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 13,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: "#fff",
    margin: "0 0 8px",
  },
  subtitle: {
    color: "#888",
    margin: "0 0 24px",
    lineHeight: 1.5,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "#aaa",
    marginBottom: 4,
  },
  input: {
    background: "#2a2a2a",
    border: "1px solid #444",
    borderRadius: 6,
    padding: "8px 12px",
    color: "#fff",
    fontSize: 13,
    marginBottom: 16,
    outline: "none",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  error: {
    color: "#f44",
    fontSize: 12,
    margin: "0 0 12px",
  },
  button: {
    background: "#fff",
    color: "#000",
    border: "none",
    borderRadius: 6,
    padding: "10px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
};
