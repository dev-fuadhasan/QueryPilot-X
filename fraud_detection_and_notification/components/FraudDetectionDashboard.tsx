"use client";

import { useCallback, useEffect, useState } from "react";
import type { FraudAlert } from "../fraudDetection";

export default function FraudDetectionDashboard() {
  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/fraud-detection", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load fraud alerts.");
      setAlerts(data.alerts || []);
    } catch (err) {
      setAlerts([]);
      setError(err instanceof Error ? err.message : "Could not load fraud alerts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAlerts(); }, [loadAlerts]);

  return (
    <section>
      <div className="section-heading">
        <div>
          <h1>Fraud detection</h1>
          <p>Suspicious amount changes recorded in the connected sales audit log.</p>
        </div>
        <button type="button" className="small-button" disabled={loading} onClick={() => void loadAlerts()}>
          {loading ? "Checking..." : "Refresh"}
        </button>
      </div>
      {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
      {!error && !loading && alerts.length === 0 && <p>No suspicious changes found in the latest 1,000 audit records.</p>}
      {!error && !loading && alerts.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          <p>{alerts.length} suspicious change{alerts.length === 1 ? "" : "s"} detected (amount decreases of at least 50%).</p>
          {alerts.map(alert => (
            <article className="stat-card" key={alert.id}>
              <strong style={{ fontSize: 16 }}>{alert.severity === "high" ? "High" : "Medium"} severity · Sale {alert.recordId}</strong>
              <p>{alert.reason}</p>
              <span>{alert.tableName} · {alert.changedBy || "Unknown editor"} · {alert.changedAt}</span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
