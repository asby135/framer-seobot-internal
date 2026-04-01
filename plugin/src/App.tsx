import { useState, useEffect } from "react";
import { framer } from "framer-plugin";
import { api } from "./api/client";
import { SetupFlow } from "./components/SetupFlow";
import { TopicQueue } from "./components/TopicQueue";
import { ArticleList } from "./components/ArticleList";
import { GeneratePanel } from "./components/GeneratePanel";
import { Settings } from "./components/Settings";

type Tab = "topics" | "articles" | "generate";

export function App() {
  const [isSetup, setIsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("topics");
  const [showSettings, setShowSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    checkSetup();
  }, []);

  async function checkSetup() {
    try {
      // Read stored config from plugin data
      const collection = await framer.getManagedCollection();
      const baseUrl = await collection.getPluginData("baseUrl");
      const apiKey = await collection.getPluginData("apiKey");

      if (baseUrl && apiKey) {
        api.configure(baseUrl, apiKey);
        // Verify connection
        await api.getStatus();
        setIsSetup(true);
      }
    } catch {
      // Not configured or backend unreachable
      setIsSetup(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleSetupComplete(baseUrl: string, apiKey: string) {
    const collection = await framer.getManagedCollection();
    await collection.setPluginData("baseUrl", baseUrl);
    await collection.setPluginData("apiKey", apiKey);
    api.configure(baseUrl, apiKey);
    setIsSetup(true);
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await api.rescoreKeywords();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      framer.notify(e instanceof Error ? e.message : "Re-score failed", { variant: "error" });
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.center}>
        <p style={styles.textSecondary}>Loading...</p>
      </div>
    );
  }

  if (!isSetup) {
    return <SetupFlow onComplete={handleSetupComplete} />;
  }

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />;
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>CRMChat SEO Engine</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              ...styles.gearButton,
              opacity: refreshing ? 0.4 : 1,
              animation: refreshing ? "spin 1s linear infinite" : "none",
            }}
            title="Re-score keywords"
          >
            ↻
          </button>
          <button
            onClick={() => setShowSettings(true)}
            style={styles.gearButton}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabBar}>
        {(["topics", "generate", "articles"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              ...styles.tab,
              ...(activeTab === tab ? styles.tabActive : {}),
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={styles.content}>
        {activeTab === "topics" && <TopicQueue key={refreshKey} />}
        {activeTab === "articles" && <ArticleList />}
        {activeTab === "generate" && <GeneratePanel />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#1a1a1a",
    color: "#e0e0e0",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 13,
  },
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    background: "#1a1a1a",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #333",
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: "#fff",
  },
  gearButton: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 16,
    padding: 4,
  },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid #333",
  },
  tab: {
    flex: 1,
    padding: "8px 0",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
  tabActive: {
    color: "#fff",
    borderBottomColor: "#fff",
  },
  content: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column" as const,
  },
  textSecondary: {
    color: "#888",
  },
};
