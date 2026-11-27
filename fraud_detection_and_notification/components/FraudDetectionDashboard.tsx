"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import {
  Bell,
  RefreshCw,
  Download,
  Search,
  Database,
  ArrowRight,
  CheckCheck,
  CheckCircle2,
  Calendar,
  Layers,
  Sparkles,
  ShieldCheck,
  Clock,
  Filter,
  AlertTriangle,
  ShieldAlert,
  Cloud,
  UploadCloud,
  Flame,
  Mail,
  Play,
  Pause
} from "lucide-react";
import type { ChangeNotification, BusinessProfileType } from "../types";
import { exportChangeNotificationsToCSV } from "../notification-service";
import { evaluateChangeRisk, type RiskSeverity } from "../risk-engine";
import { BUSINESS_PROFILES, detectBestProfile } from "../business-profiles";
import IncidentForensicModal from "./IncidentForensicModal";
import CloudArchivesModal from "./CloudArchivesModal";
import SimulationStudioModal from "./SimulationStudioModal";

const SNAPSHOT_KEY = "qp_table_snapshot_v2";
const HISTORY_KEY = "qp_change_notifications_v2";
const SEEN_HASHES_KEY = "qp_seen_hashes_v2";

/**
 * Generates a stable, deterministic change hash for any value transition.
 * Guaranteed to produce the exact same ID for the same change, preventing duplicates across polling ticks.
 */
function computeStableChangeHash(
  tableName: string,
  recordId: string,
  columnName: string,
  oldVal: unknown,
  newVal: unknown
): string {
  const strOld = oldVal === null || oldVal === undefined ? "NULL" : String(oldVal);
  const strNew = newVal === null || newVal === undefined ? "NULL" : String(newVal);
  const sig = `${tableName}:${recordId}:${columnName}:${strOld}->${strNew}`;

  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    hash = ((hash << 5) - hash) + sig.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Resolves the primary key for a row deterministically using backend schema discovery or standard fallbacks.
 */
function resolveRowId(row: Record<string, unknown>, pkColumn?: string): string {
  if (pkColumn && row[pkColumn] !== undefined && row[pkColumn] !== null) {
    return String(row[pkColumn]);
  }
  if (row.id !== undefined && row.id !== null) return String(row.id);
  if (row.uuid !== undefined && row.uuid !== null) return String(row.uuid);

  const candidateKey = Object.keys(row).find((k) => {
    const lk = k.toLowerCase();
    return lk.endsWith("_id") || lk === "code" || lk === "key" || lk === "slug";
  });
  if (candidateKey && row[candidateKey] !== undefined && row[candidateKey] !== null) {
    return String(row[candidateKey]);
  }

  // Fallback to first non-empty property
  return String(Object.values(row)[0] ?? "unknown");
}

export default function FraudDetectionDashboard() {
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [newAlertNotice, setNewAlertNotice] = useState<string | null>(null);

  // Monitored tables and primary keys discovered
  const [monitoredTables, setMonitoredTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>("ALL");
  const [selectedSeverity, setSelectedSeverity] = useState<string>("ALL");
  const [selectedProfile, setSelectedProfile] = useState<BusinessProfileType>("universal");
  const [detectionSensitivity, setDetectionSensitivity] = useState<"low" | "medium" | "high">("medium");
  const [searchQuery, setSearchQuery] = useState("");
  const [primaryKeyMap, setPrimaryKeyMap] = useState<Record<string, string>>({});
  const [activeForensicIncident, setActiveForensicIncident] = useState<ChangeNotification | null>(null);

  // Supabase Cloud Storage States
  const [showCloudArchives, setShowCloudArchives] = useState(false);
  const [archivingToCloud, setArchivingToCloud] = useState(false);
  const [cloudArchiveNotice, setCloudArchiveNotice] = useState<string | null>(null);

  // Live Incident Simulation Studio State
  const [showSimulationStudio, setShowSimulationStudio] = useState(false);

  // Automated Email Alert State
  const [emailSettings, setEmailSettings] = useState<{
    recipientEmail: string;
    fraudAlertsEnabled: boolean;
    minSeverity: string;
  } | null>(null);
  const dispatchedEmailKeysRef = useRef<Set<string>>(new Set());

  // Change Notifications List
  const [notifications, setNotifications] = useState<ChangeNotification[]>([]);
  const [isLiveActive, setIsLiveActive] = useState(true);

  // Ref caches to eliminate closure race conditions
  const snapshotRef = useRef<Record<string, Record<string, unknown>[]>>({});
  const seenHashesRef = useRef<Set<string>>(new Set());

  // Helper to format Date & Time clearly
  const formatDateTime = useCallback((isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    } catch {
      return isoString;
    }
  }, []);

  // Load existing notifications and seen hashes from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChangeNotification[];
        if (Array.isArray(parsed)) {
          const enriched = parsed.map((item) => {
            if (!item.riskAssessment) {
              const assessment = evaluateChangeRisk(
                item.tableName,
                item.columnName,
                item.oldValue,
                item.newValue,
                item.timestamp
              );
              return {
                ...item,
                riskScore: assessment.score,
                riskSeverity: assessment.severity,
                riskAssessment: assessment,
              };
            }
            return item;
          });
          setNotifications(enriched);
          enriched.forEach((item) => {
            if (item.id) seenHashesRef.current.add(item.id);
          });
        }
      }

      const storedHashes = localStorage.getItem(SEEN_HASHES_KEY);
      if (storedHashes) {
        const parsedHashes = JSON.parse(storedHashes);
        if (Array.isArray(parsedHashes)) {
          parsedHashes.forEach((h) => seenHashesRef.current.add(h));
        }
      }

      const storedSnapshot = localStorage.getItem(SNAPSHOT_KEY);
      if (storedSnapshot) {
        snapshotRef.current = JSON.parse(storedSnapshot);
      }

      // Load active email notification preferences
      fetch("/api/notifications/email", { cache: "no-store" })
        .then((res) => res.json())
        .then((data) => {
          if (data?.settings?.recipientEmail) {
            setEmailSettings(data.settings);
          }
        })
        .catch(() => {});
    } catch {
      // Ignored
    }
  }, []);

  // Save notifications & seen hashes safely
  const persistNotifications = useCallback((items: ChangeNotification[]) => {
    setNotifications(items);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 500)));
      localStorage.setItem(
        SEEN_HASHES_KEY,
        JSON.stringify(Array.from(seenHashesRef.current).slice(-1000))
      );
    } catch {
      // Ignored
    }
  }, []);

  // Core Snapshot & Idempotent Diffing Engine
  const checkForChanges = useCallback(
    async (isManual = false) => {
      if (isManual) setChecking(true);
      setError("");

      try {
        const res = await fetch("/api/fraud-detection/snapshot", {
          cache: "no-store",
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Could not read database changes.");
        }

        const newTables: string[] = data.tables || [];
        setMonitoredTables(newTables);
        if (newTables.length > 0 && selectedProfile === "universal") {
          const auto = detectBestProfile(newTables);
          if (auto !== "universal") {
            setSelectedProfile(auto);
          }
        }

        const pks: Record<string, string> = data.primaryKeys || {};
        setPrimaryKeyMap(pks);

        const auditCoveredList: string[] = data.auditCoveredFields || [];
        const auditCoveredSet = new Set<string>(auditCoveredList);

        const currentSnapshot: Record<string, Record<string, unknown>[]> =
          data.snapshot || {};
        const prevSnapshot = snapshotRef.current;

        const detectedChanges: ChangeNotification[] = [];
        const nowIso = new Date().toISOString();

        // 1. Process Audit Log Entries First (from triggers) with stable IDs
        const auditChanges = data.auditChanges || [];
        for (const ac of auditChanges) {
          const stableAuditId = ac.id || `audit_${ac.tableName}_${ac.recordId}_${ac.columnName}_${ac.changeHash}`;
          
          if (!seenHashesRef.current.has(stableAuditId)) {
            seenHashesRef.current.add(stableAuditId);
            const risk = evaluateChangeRisk(
              ac.tableName,
              ac.columnName,
              ac.oldValue,
              ac.newValue,
              ac.changedAt || nowIso,
              selectedProfile,
              detectionSensitivity
            );
            detectedChanges.push({
              id: stableAuditId,
              tableName: ac.tableName,
              recordId: ac.recordId,
              columnName: ac.columnName,
              oldValue: ac.oldValue ?? "NULL",
              newValue: ac.newValue ?? "NULL",
              changedBy: ac.changedBy || "Database Editor",
              timestamp: ac.changedAt || nowIso,
              changeType: ac.eventType || "UPDATE",
              reason: `Audited update on "${ac.columnName}": "${String(ac.oldValue)}" → "${String(ac.newValue)}".`,
              isRead: false,
              riskScore: risk.score,
              riskSeverity: risk.severity,
              riskAssessment: risk,
            });
          }
        }

        // 2. Snapshot Diffing with Primary Key Resolution & Deduplication
        const hasPreviousBaseline = Object.keys(prevSnapshot).length > 0;

        for (const [tableName, currentRows] of Object.entries(currentSnapshot)) {
          const prevRows = prevSnapshot[tableName] || [];
          const pkCol = pks[tableName];

          // Index previous rows by actual Primary Key
          const prevRowMap = new Map<string, Record<string, unknown>>();
          for (const r of prevRows) {
            const key = resolveRowId(r, pkCol);
            if (key) prevRowMap.set(key, r);
          }

          // Compare current rows against previous snapshot
          for (const cur of currentRows) {
            const rowId = resolveRowId(cur, pkCol);
            const prev = prevRowMap.get(rowId);

            if (prev) {
              // Existing row: check for genuine cell modifications
              for (const [colName, curVal] of Object.entries(cur)) {
                // Ignore transient timestamp columns that update on every save
                const colLower = colName.toLowerCase();
                if (
                  colLower === "updated_at" ||
                  colLower === "updatedat" ||
                  colLower === "modified_at" ||
                  colLower === "last_seen"
                ) {
                  continue;
                }

                // If audit log trigger already captured this table:row:column, skip duplicate
                if (auditCoveredSet.has(`${tableName}:${rowId}:${colName}`)) {
                  continue;
                }

                const oldVal = prev[colName];
                const strOld = oldVal === null || oldVal === undefined ? "" : String(oldVal);
                const strCur = curVal === null || curVal === undefined ? "" : String(curVal);

                if (strOld !== strCur) {
                  // Genuinely modified cell! Compute stable hash without Date.now()
                  const changeHash = computeStableChangeHash(tableName, rowId, colName, strOld, strCur);
                  const changeId = `diff_${tableName}_${rowId}_${colName}_${changeHash}`;

                  if (!seenHashesRef.current.has(changeId)) {
                    seenHashesRef.current.add(changeId);
                    const risk = evaluateChangeRisk(
                      tableName,
                      colName,
                      oldVal,
                      curVal,
                      nowIso,
                      selectedProfile,
                      detectionSensitivity
                    );
                    detectedChanges.push({
                      id: changeId,
                      tableName,
                      recordId: rowId,
                      columnName: colName,
                      oldValue: oldVal ?? "NULL",
                      newValue: curVal ?? "NULL",
                      changedBy: "Database Editor",
                      timestamp: nowIso,
                      changeType: "UPDATE",
                      reason: `Field "${colName}" changed from "${strOld}" to "${strCur}".`,
                      isRead: false,
                      riskScore: risk.score,
                      riskSeverity: risk.severity,
                      riskAssessment: risk,
                    });
                  }
                }
              }
            } else if (hasPreviousBaseline && prevRows.length > 0) {
              // New row added after initial baseline was established
              const insertHash = computeStableChangeHash(tableName, rowId, "insert", "", JSON.stringify(cur));
              const insertId = `insert_${tableName}_${rowId}_${insertHash}`;

              if (!seenHashesRef.current.has(insertId)) {
                seenHashesRef.current.add(insertId);
                const risk = evaluateChangeRisk(
                  tableName,
                  "Record Insert",
                  null,
                  cur,
                  nowIso,
                  selectedProfile,
                  detectionSensitivity
                );
                detectedChanges.push({
                  id: insertId,
                  tableName,
                  recordId: rowId,
                  columnName: "New Record",
                  oldValue: "None (New)",
                  newValue: JSON.stringify(cur),
                  changedBy: "Database Insert",
                  timestamp: nowIso,
                  changeType: "INSERT",
                  reason: `New record #${rowId} was inserted into "${tableName}".`,
                  isRead: false,
                  riskScore: risk.score,
                  riskSeverity: risk.severity,
                  riskAssessment: risk,
                });
              }
            }
          }
        }

        // Update baseline snapshot ref and localStorage
        snapshotRef.current = currentSnapshot;
        try {
          localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(currentSnapshot));
        } catch {
          // Ignored
        }

        // Prepend new changes if any fresh ones were found
        if (detectedChanges.length > 0) {
          setNotifications((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const fresh = detectedChanges.filter((d) => !existingIds.has(d.id));

            if (fresh.length > 0) {
              setNewAlertNotice(
                `🔔 ${fresh.length} new verified change${fresh.length > 1 ? "s" : ""} recorded in your database.`
              );
              setTimeout(() => setNewAlertNotice(null), 5000);

              // Automated Resend Email Alert Dispatch for high-risk mutations
              if (emailSettings?.fraudAlertsEnabled && emailSettings.recipientEmail) {
                const highRiskIncidents = fresh.filter((d) => {
                  const sev = d.riskSeverity || d.riskAssessment?.severity || "LOW";
                  const meetsThreshold =
                    emailSettings.minSeverity === "CRITICAL"
                      ? sev === "CRITICAL"
                      : sev === "CRITICAL" || sev === "HIGH";
                  return meetsThreshold && !dispatchedEmailKeysRef.current.has(d.id);
                });

                for (const inc of highRiskIncidents) {
                  dispatchedEmailKeysRef.current.add(inc.id);
                  void fetch("/api/notifications/email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "fraud-alert",
                      incident: inc,
                      recipientEmail: emailSettings.recipientEmail,
                    }),
                  }).catch(() => {});
                }
              }

              const combined = [...fresh, ...prev];
              try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(combined.slice(0, 500)));
                localStorage.setItem(
                  SEEN_HASHES_KEY,
                  JSON.stringify(Array.from(seenHashesRef.current).slice(-1000))
                );
              } catch {
                // Ignored
              }
              return combined;
            }
            return prev;
          });
        }
      } catch (err) {
        if (isManual) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not sync database changes."
          );
        }
      } finally {
        if (isManual) setChecking(false);
        setLoading(false);
      }
    },
    []
  );

  // Initial check on mount
  useEffect(() => {
    setLoading(true);
    void checkForChanges(true);
  }, [checkForChanges]);

  // Real-time live polling (checks every 5 seconds)
  useEffect(() => {
    if (!isLiveActive) return;

    const timer = setInterval(() => {
      void checkForChanges(false);
    }, 5000);

    return () => clearInterval(timer);
  }, [isLiveActive, checkForChanges]);

  // Mark single notification as read
  const markAsRead = (id: string) => {
    const updated = notifications.map((n) =>
      n.id === id ? { ...n, isRead: true } : n
    );
    persistNotifications(updated);
  };

  // Mark all as read
  const markAllAsRead = () => {
    const updated = notifications.map((n) => ({ ...n, isRead: true }));
    persistNotifications(updated);
  };

  // Clear all history
  const clearHistory = () => {
    if (confirm("Are you sure you want to clear change notifications history?")) {
      seenHashesRef.current.clear();
      persistNotifications([]);
      try {
        localStorage.removeItem(HISTORY_KEY);
        localStorage.removeItem(SEEN_HASHES_KEY);
      } catch {
        // Ignored
      }
    }
  };

  // Filtered notifications
  const filteredNotifications = useMemo(() => {
    return notifications.filter((item) => {
      if (selectedTable !== "ALL" && item.tableName !== selectedTable) {
        return false;
      }
      if (selectedSeverity !== "ALL") {
        const itemSev = item.riskSeverity || item.riskAssessment?.severity || "LOW";
        if (itemSev !== selectedSeverity) {
          return false;
        }
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matches =
          item.tableName.toLowerCase().includes(q) ||
          item.recordId.toLowerCase().includes(q) ||
          item.columnName.toLowerCase().includes(q) ||
          String(item.oldValue).toLowerCase().includes(q) ||
          String(item.newValue).toLowerCase().includes(q) ||
          String(item.reason || "").toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [notifications, selectedTable, selectedSeverity, searchQuery]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  // Export to CSV
  const handleExportCSV = () => {
    if (notifications.length === 0) return;
    const csv = exportChangeNotificationsToCSV(notifications);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `querypilot-data-changes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Archive to Supabase Cloud Storage
  const handleArchiveToCloud = async () => {
    if (notifications.length === 0) {
      alert("No notifications available to archive.");
      return;
    }
    setArchivingToCloud(true);
    try {
      const now = new Date();
      const reportPayload = {
        reportId: `fraud_audit_${Date.now()}`,
        generatedAt: now.toISOString(),
        totalRecordedEvents: notifications.length,
        monitoredDatasets: monitoredTables,
        severityBreakdown: {
          critical: notifications.filter(
            (n) => (n.riskSeverity || n.riskAssessment?.severity) === "CRITICAL"
          ).length,
          high: notifications.filter(
            (n) => (n.riskSeverity || n.riskAssessment?.severity) === "HIGH"
          ).length,
          medium: notifications.filter(
            (n) => (n.riskSeverity || n.riskAssessment?.severity) === "MEDIUM"
          ).length,
          low: notifications.filter(
            (n) => (n.riskSeverity || n.riskAssessment?.severity) === "LOW"
          ).length,
        },
        incidents: notifications,
      };

      const fileContent = JSON.stringify(reportPayload, null, 2);
      const filename = `fraud_audit_report_${now.toISOString().replace(/[:.]/g, "-")}.json`;
      const blob = new Blob([fileContent], { type: "application/json" });

      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("category", "reports");

      const res = await fetch("/api/storage/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.success) {
        setCloudArchiveNotice(
          `☁️ Report archived to Supabase Storage: ${data.file?.filename || filename}`
        );
        setTimeout(() => setCloudArchiveNotice(null), 6000);
      } else {
        alert(data.error || "Failed to archive report to Supabase Storage.");
      }
    } catch {
      alert("Error uploading report to cloud storage.");
    } finally {
      setArchivingToCloud(false);
    }
  };

  // Inject Simulated Incident from Simulation Studio
  const handleInjectSimulatedIncident = (incident: ChangeNotification) => {
    seenHashesRef.current.add(incident.id);
    setNotifications((prev) => {
      const combined = [incident, ...prev];
      persistNotifications(combined);
      return combined;
    });

    if (emailSettings?.fraudAlertsEnabled && emailSettings.recipientEmail) {
      dispatchedEmailKeysRef.current.add(incident.id);
      void fetch("/api/notifications/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fraud-alert",
          incident,
          recipientEmail: emailSettings.recipientEmail,
        }),
      }).catch(() => {});

      setNewAlertNotice(
        `🚨 Incident Injected & Email Alert Dispatched to ${emailSettings.recipientEmail} (${incident.riskSeverity})`
      );
    } else {
      setNewAlertNotice(
        `🚨 Incident Injected: ${incident.columnName} (${incident.riskSeverity})`
      );
    }
    setTimeout(() => setNewAlertNotice(null), 6000);
  };

  return (
    <div className="datasets-panel">
      {/* SECTION HEADER (MATCHING MAIN) */}
      <div className="section-eyebrow">
        SECURITY & REAL-TIME AUDIT MONITORING
      </div>

      <div className="section-heading">
        <div>
          <h1>Fraud Detection & Live Change Log</h1>
          <p>
            Real-time change monitoring, automated anomaly detection, and tamper-resistant audit logs for all connected datasets.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          {/* EMAIL ALERT CHANNEL BADGE */}
          {emailSettings?.recipientEmail && (
            <div
              className="connection-status"
              style={{
                background: "#eff6ff",
                borderColor: "#bfdbfe",
                color: "#1d4ed8",
                fontWeight: 600,
                fontSize: "11px",
              }}
              title={`Automated alert dispatch configured for ${emailSettings.recipientEmail}`}
            >
              <Mail size={12} style={{ color: "#2563eb" }} />
              <span>Alerts: {emailSettings.recipientEmail}</span>
            </div>
          )}

          {/* LIVE STATUS PILL */}
          <div
            className="connection-status"
            style={{
              cursor: "pointer",
              background: isLiveActive ? "#f0fdf4" : "#fef2f2",
              borderColor: isLiveActive ? "#bbf7d0" : "#fecaca",
            }}
            onClick={() => setIsLiveActive(!isLiveActive)}
            title="Click to toggle auto-monitoring"
          >
            <i style={{ background: isLiveActive ? "#22c55e" : "#ef4444" }} />
            <span style={{ fontWeight: 600, color: isLiveActive ? "#15803d" : "#991b1b" }}>
              {isLiveActive ? "Live (5s)" : "Paused"}
            </span>
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={handleExportCSV}
            disabled={notifications.length === 0}
            title="Download full change log as CSV"
          >
            <Download size={14} /> Export CSV
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={handleArchiveToCloud}
            disabled={archivingToCloud || notifications.length === 0}
            title="Archive tamper-evident audit report to private Supabase Storage"
          >
            <UploadCloud size={14} className={archivingToCloud ? "spinning" : undefined} />
            {archivingToCloud ? "Archiving..." : "Archive to Cloud"}
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={() => setShowCloudArchives(true)}
            title="Browse reports archived in Supabase Storage"
          >
            <Cloud size={14} style={{ color: "#2563eb" }} /> Cloud Archives
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={() => setShowSimulationStudio(true)}
            style={{ color: "#e11d48", borderColor: "#fecdd3", background: "#fff1f2" }}
            title="Launch Live Incident & Attack Simulation Studio for demonstration"
          >
            <Flame size={14} style={{ color: "#e11d48" }} /> Simulate Incident
          </button>

          <button
            type="button"
            className="primary"
            style={{ minHeight: "38px", padding: "8px 16px" }}
            onClick={() => void checkForChanges(true)}
            disabled={checking}
          >
            <RefreshCw
              size={14}
              className={checking ? "spinning" : undefined}
            />
            {checking ? "Checking..." : "Check Now"}
          </button>
        </div>
      </div>

      {/* NEW ALERT TOAST NOTICE */}
      {newAlertNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e40af",
            padding: "12px 18px",
            borderRadius: "10px",
            marginBottom: "20px",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <Bell size={16} />
          <span>{newAlertNotice}</span>
        </div>
      )}

      {/* CLOUD ARCHIVE SUCCESS NOTICE */}
      {cloudArchiveNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "12px 18px",
            borderRadius: "10px",
            marginBottom: "20px",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <Cloud size={16} />
          <span>{cloudArchiveNotice}</span>
        </div>
      )}

      {error && (
        <div className="error" style={{ position: "relative", transform: "none", left: 0, margin: "0 0 20px", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* METRIC STAT CARDS (MATCHING MAIN .stat-grid) */}
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="stat-card">
          <Layers size={20} />
          <span>Total Changes Recorded</span>
          <strong>{notifications.length}</strong>
          <small style={{ color: "#9aa1ac", fontSize: "10px" }}>
            Deduplicated real-time events
          </small>
        </div>

        <div className="stat-card" style={{ borderColor: unreadCount > 0 ? "#f59e0b" : "#eaedf0" }}>
          <Bell size={20} style={{ color: unreadCount > 0 ? "#d97706" : "#79828d" }} />
          <span>Unread Notifications</span>
          <strong style={{ color: unreadCount > 0 ? "#b45309" : "#25282d" }}>
            {unreadCount}
          </strong>
          <div className="stat-connected" style={{ color: unreadCount > 0 ? "#b45309" : "#20895c" }}>
            {unreadCount > 0 ? "Requires review" : "All reviewed"}
          </div>
        </div>

        <div className="stat-card">
          <Database size={20} />
          <span>Monitored Datasets</span>
          <strong>{monitoredTables.length}</strong>
          <div className="stat-connected">
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
            {monitoredTables.slice(0, 3).join(", ") || "Active tables"}
            {monitoredTables.length > 3 ? ` +${monitoredTables.length - 3}` : ""}
          </div>
        </div>
      </div>

      {/* FILTER & TOOLBAR (MATCHING MAIN) */}
      <div
        className="table-header"
        style={{
          background: "#fff",
          border: "1px solid #eaedf0",
          borderRadius: "12px",
          padding: "12px 18px",
          marginBottom: "20px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", flex: 1 }}>
          {/* DATASET SELECTOR */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <Filter size={14} style={{ color: "#79828d" }} />
            <select
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.target.value)}
              style={{
                border: "1px solid #e1e5e9",
                borderRadius: "8px",
                padding: "7px 10px",
                fontSize: "12px",
                background: "#fff",
                color: "#25282d",
              }}
            >
              <option value="ALL">All Datasets ({monitoredTables.length})</option>
              {monitoredTables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* BUSINESS PROFILE SELECTOR */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <Sparkles size={14} style={{ color: "#2563eb" }} />
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value as BusinessProfileType)}
              style={{
                border: "1px solid #bfdbfe",
                borderRadius: "8px",
                padding: "7px 10px",
                fontSize: "12px",
                background: "#eff6ff",
                color: "#1d4ed8",
                fontWeight: 600,
              }}
              title="Select industry profile to adjust domain-specific detection heuristics"
            >
              <option value="universal">🌐 Universal Model</option>
              <option value="ecommerce">🛒 E-Commerce & Retail</option>
              <option value="fintech">💳 Fintech & Banking</option>
              <option value="saas">⚡ SaaS & Subscriptions</option>
              <option value="social_platform">👥 Social / Community</option>
            </select>
          </div>

          {/* SENSITIVITY SELECTOR */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Tuning:</span>
            <select
              value={detectionSensitivity}
              onChange={(e) => setDetectionSensitivity(e.target.value as "low" | "medium" | "high")}
              style={{
                border: "1px solid #e1e5e9",
                borderRadius: "8px",
                padding: "7px 10px",
                fontSize: "12px",
                background: "#fff",
                color: "#25282d",
              }}
              title="Adjust anomaly detection threshold"
            >
              <option value="medium">⚖️ Balanced</option>
              <option value="high">⚡ Aggressive</option>
              <option value="low">🛡️ Strict</option>
            </select>
          </div>

          {/* SEVERITY SELECTOR */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <ShieldCheck size={14} style={{ color: "#79828d" }} />
            <select
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value)}
              style={{
                border: "1px solid #e1e5e9",
                borderRadius: "8px",
                padding: "7px 10px",
                fontSize: "12px",
                background: "#fff",
                color: "#25282d",
              }}
            >
              <option value="ALL">All Severities</option>
              <option value="CRITICAL">🔴 Critical Risk</option>
              <option value="HIGH">🟠 High Risk</option>
              <option value="MEDIUM">🟡 Medium Risk</option>
              <option value="LOW">🟢 Low Risk</option>
            </select>
          </div>

          {/* SEARCH BAR */}
          <div className="search-field" style={{ maxWidth: "260px", flex: 1 }}>
            <Search size={14} />
            <input
              type="text"
              placeholder="Search table, record, field..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* BULK ACTIONS */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {unreadCount > 0 && (
            <button
              type="button"
              className="small-button"
              onClick={markAllAsRead}
              title="Mark all notifications as read"
            >
              <CheckCheck size={14} /> Mark all read
            </button>
          )}

          {notifications.length > 0 && (
            <button
              type="button"
              className="small-button"
              style={{ color: "#dc2626" }}
              onClick={clearHistory}
            >
              Clear log
            </button>
          )}
        </div>
      </div>

      {/* THE MAIN CHANGE LOG FEED */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Clock size={16} style={{ color: "#79828d" }} />
            <h2 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "#191b20" }}>
              Change & Modification Log
            </h2>
            <span style={{ fontSize: "11px", color: "#64748b", background: "#f1f5f9", padding: "2px 8px", borderRadius: "10px", fontWeight: 600 }}>
              {filteredNotifications.length} event{filteredNotifications.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {loading && notifications.length === 0 ? (
          <div style={{ textAlign: "center", padding: "50px 20px", background: "#fff", border: "1px solid #eaedf0", borderRadius: "12px", color: "#8b9099" }}>
            <RefreshCw size={24} className="spinning" style={{ margin: "0 auto 12px", display: "block" }} />
            <p style={{ margin: 0, fontSize: "13px" }}>Connecting to live database and reading snapshot baseline...</p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px", background: "#fff", border: "1px solid #eaedf0", borderRadius: "13px" }}>
            <div className="connected-icon" style={{ margin: "0 auto 14px", width: "52px", height: "52px", color: "#239b6b" }}>
              <ShieldCheck size={28} />
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", color: "#191b20", fontWeight: 700 }}>
              No Data Changes Detected
            </h3>
            <p style={{ margin: "0 auto", maxWidth: "460px", color: "#8b9099", fontSize: "12px", lineHeight: 1.6 }}>
              Live auto-monitoring is active. Any row modification, column change, or insert in your database will be captured here in real-time with deduplicated accuracy.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
            {filteredNotifications.map((item) => (
              <article
                key={item.id}
                onClick={() => !item.isRead && markAsRead(item.id)}
                style={{
                  background: "#fff",
                  border: "1px solid #eaedf0",
                  borderLeft: item.isRead ? "1px solid #eaedf0" : "4px solid #3b82f6",
                  borderRadius: "11px",
                  padding: "16px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  cursor: item.isRead ? "default" : "pointer",
                  transition: "all 0.15s ease",
                  boxShadow: item.isRead ? "none" : "0 1px 3px rgba(0,0,0,0.03)",
                }}
              >
                {/* CARD HEADER */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        fontSize: "11px",
                        color: "#475569",
                        background: "#f1f5f9",
                        padding: "3px 8px",
                        borderRadius: "6px",
                        fontWeight: 600,
                      }}
                    >
                      <Calendar size={12} />
                      {formatDateTime(item.timestamp)}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        fontSize: "11px",
                        color: "#1e40af",
                        background: "#eff6ff",
                        padding: "3px 8px",
                        borderRadius: "6px",
                        fontWeight: 700,
                      }}
                    >
                      <Database size={12} />
                      {item.tableName}
                    </span>

                    <span style={{ fontSize: "11px", color: "#64748b" }}>
                      Record: <strong style={{ color: "#0f172a" }}>#{item.recordId}</strong>
                    </span>

                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: item.changeType === "INSERT" ? "#ecfdf5" : item.changeType === "DELETE" ? "#fef2f2" : "#f0f9ff",
                        color: item.changeType === "INSERT" ? "#047857" : item.changeType === "DELETE" ? "#b91c1c" : "#0369a1",
                      }}
                    >
                      {item.changeType}
                    </span>

                    {/* RISK SEVERITY BADGE */}
                    {(() => {
                      const sev = (item.riskSeverity || item.riskAssessment?.severity || "LOW") as RiskSeverity;
                      const score = item.riskScore ?? item.riskAssessment?.score ?? 15;
                      const sevConfig = {
                        CRITICAL: { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
                        HIGH: { bg: "#fff7ed", color: "#ea580c", border: "#fed7aa" },
                        MEDIUM: { bg: "#fefce8", color: "#ca8a04", border: "#fef08a" },
                        LOW: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
                      }[sev] || { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" };
                      return (
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 800,
                            padding: "2px 7px",
                            borderRadius: "4px",
                            background: sevConfig.bg,
                            color: sevConfig.color,
                            border: `1px solid ${sevConfig.border}`,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: sevConfig.color }} />
                          {sev} ({score})
                        </span>
                      );
                    })()}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveForensicIncident(item);
                      }}
                      className="small-button"
                      style={{
                        padding: "3px 8px",
                        fontSize: "11px",
                        fontWeight: 600,
                        background: "#f8fafc",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        color: "#334155",
                      }}
                      title="Open forensic analysis"
                    >
                      <ShieldAlert size={12} style={{ color: "#dc2626" }} /> Forensic
                    </button>

                    {!item.isRead && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "3px",
                          fontSize: "10px",
                          fontWeight: 800,
                          color: "#1d4ed8",
                          background: "#dbeafe",
                          padding: "2px 7px",
                          borderRadius: "10px",
                        }}
                      >
                        <Sparkles size={10} /> NEW
                      </span>
                    )}

                    {!item.isRead && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          markAsRead(item.id);
                        }}
                        style={{
                          background: "transparent",
                          border: 0,
                          color: "#94a3b8",
                          cursor: "pointer",
                          padding: "2px",
                          display: "flex",
                          alignItems: "center",
                        }}
                        title="Mark as read"
                      >
                        <CheckCircle2 size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {/* THE CORE DIFF BOX (PREVIOUS -> NEW) */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                    background: "#f8fafc",
                    border: "1px solid #f1f5f9",
                    borderRadius: "9px",
                    padding: "12px 16px",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontSize: "10px", color: "#64748b", textTransform: "uppercase", fontWeight: 700 }}>
                      Field Modified
                    </span>
                    <strong style={{ fontSize: "13px", color: "#0f172a" }}>
                      {item.columnName}
                    </strong>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxWidth: "240px" }}>
                      <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700 }}>
                        PREVIOUS VALUE
                      </span>
                      <span
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontSize: "12px",
                          color: "#dc2626",
                          textDecoration: "line-through",
                          wordBreak: "break-all",
                        }}
                      >
                        {String(item.oldValue)}
                      </span>
                    </div>

                    <ArrowRight size={16} style={{ color: "#94a3b8", flexShrink: 0 }} />

                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxWidth: "240px" }}>
                      <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700 }}>
                        UPDATED VALUE
                      </span>
                      <span
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontSize: "12px",
                          color: "#059669",
                          fontWeight: 700,
                          wordBreak: "break-all",
                        }}
                      >
                        {String(item.newValue)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* FOOTER */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#64748b" }}>
                  <span>{item.reason || `Field "${item.columnName}" was modified.`}</span>
                  <span>
                    Source: <strong style={{ color: "#334155" }}>{item.changedBy || "Database Editor"}</strong>
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* FORENSIC INVESTIGATION MODAL */}
      <IncidentForensicModal
        incident={activeForensicIncident}
        onClose={() => setActiveForensicIncident(null)}
      />

      {/* SUPABASE CLOUD ARCHIVES MODAL */}
      <CloudArchivesModal
        isOpen={showCloudArchives}
        onClose={() => setShowCloudArchives(false)}
      />

      {/* LIVE ATTACK & INCIDENT SIMULATION STUDIO */}
      <SimulationStudioModal
        isOpen={showSimulationStudio}
        onClose={() => setShowSimulationStudio(false)}
        onInjectIncident={handleInjectSimulatedIncident}
      />
    </div>
  );
}
