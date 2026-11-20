"use client";

import { useEffect, useState, useMemo } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  Activity,
  RefreshCw,
  Download,
  Filter,
  Search,
  Database,
  Sliders,
  AlertTriangle,
  CheckCircle2,
  Copy,
  ChevronDown,
  Layers,
  ArrowRight,
  UserCheck,
  Zap,
} from "lucide-react";
import type {
  UniversalAlert,
  Severity,
  BusinessProfileType,
  TableProfile,
} from "../types";
import { BUSINESS_PROFILES } from "../business-profiles";
import {
  exportAlertsToCSV,
  exportAlertsToJSON,
} from "../notification-service";

type TabMode = "scanner" | "audit" | "setup";

export default function FraudDetectionDashboard() {
  const [activeTab, setActiveTab] = useState<TabMode>("scanner");
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Schema state
  const [tables, setTables] = useState<TableProfile[]>([]);
  const [selectedProfile, setSelectedProfile] =
    useState<BusinessProfileType>("ecommerce");
  const [selectedTable, setSelectedTable] = useState<string>("ALL");
  const [sensitivity, setSensitivity] = useState<"low" | "medium" | "high">(
    "medium"
  );
  const [hasAuditTable, setHasAuditTable] = useState(false);

  // Alerts & Notifications state
  const [alerts, setAlerts] = useState<UniversalAlert[]>([]);
  const [reviewedAlertIds, setReviewedAlertIds] = useState<Set<string>>(
    new Set()
  );
  const [severityFilter, setSeverityFilter] = useState<string>("ALL");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Audit Setup state
  const [setupTable, setSetupTable] = useState("");
  const [setupIdCol, setSetupIdCol] = useState("");
  const [setupColumns, setSetupColumns] = useState<string[]>([]);
  const [generatedSql, setGeneratedSql] = useState("");
  const [copied, setCopied] = useState(false);

  // Load database schema and auto-detect profile
  async function loadSchema() {
    try {
      const res = await fetch("/api/fraud-detection/schema", {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok && data.tables) {
        setTables(data.tables);
        if (data.suggestedProfile) {
          setSelectedProfile(data.suggestedProfile);
        }
        setHasAuditTable(Boolean(data.hasAuditTable));
        if (data.tables.length > 0 && !setupTable) {
          const first = data.tables[0];
          setSetupTable(first.name);
          setSetupIdCol(first.idColumn || first.columns[0]?.name || "id");
          setSetupColumns(
            first.columns.slice(1, 4).map((c: { name: string }) => c.name)
          );
        }
      }
    } catch {
      // Ignored
    }
  }

  // Run deep fraud scan
  async function runScan(profileOverride?: BusinessProfileType) {
    setScanning(true);
    setError("");
    setSuccessMessage("");

    try {
      const res = await fetch("/api/fraud-detection/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: profileOverride || selectedProfile,
          tableNames:
            selectedTable === "ALL" ? undefined : [selectedTable],
          sensitivity,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fraud scan failed.");

      setAlerts(data.alerts || []);
      setSuccessMessage(
        `Scan complete! Analyzed ${data.totalRecordsAnalyzed ?? 0} records across ${data.scannedTables?.length ?? 0} tables.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fraud scan failed.");
    } finally {
      setScanning(false);
    }
  }

  // Load audit records
  async function loadAuditRecords() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/fraud-detection/universal", {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok && data.alerts) {
        // Merge with existing alerts
        setAlerts((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const newAlerts: UniversalAlert[] = [];
          for (const a of data.alerts) {
            const mapped: UniversalAlert = {
              id: `audit-${a.id || Math.random().toString(36).slice(2, 7)}`,
              ruleCategory:
                a.eventType === "DELETE" ? "RECORD_DELETED" : "AUDIT_TAMPER",
              title:
                a.eventType === "DELETE"
                  ? `Record Deleted from ${a.tableName}`
                  : `Suspicious Change in ${a.tableName}.${a.columnName}`,
              severity: a.severity || "medium",
              tableName: a.tableName,
              recordId: a.recordId || a.saleId || "unknown",
              columnName: a.columnName,
              oldValue: a.oldValue,
              newValue: a.newValue,
              actor: a.changedBy,
              timestamp: a.changedAt || new Date().toISOString(),
              reason: a.reason || "Suspicious audit change detected.",
              recommendation:
                "Verify database audit logs with the author of this change.",
              eventType: a.eventType || "UPDATE",
            };
            if (!existingIds.has(mapped.id)) {
              newAlerts.push(mapped);
            }
          }
          return [...newAlerts, ...prev];
        });
      }
    } catch {
      // Ignored
    } finally {
      setLoading(false);
    }
  }

  // Generate Audit SQL
  async function generateSql() {
    if (!setupTable || !setupIdCol || setupColumns.length === 0) {
      setError("Select a table, ID column, and at least one monitored column.");
      return;
    }

    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/fraud-detection/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableName: setupTable,
          idColumn: setupIdCol,
          monitoredColumns: setupColumns,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate SQL.");

      setGeneratedSql(data.sql);
      setSuccessMessage("Trigger SQL generated! Copy and run it in Supabase.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate SQL.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSchema();
    void runScan();
  }, []);

  // Update setup columns when setup table changes
  function onSetupTableChange(name: string) {
    setSetupTable(name);
    const table = tables.find((t) => t.name === name);
    if (table) {
      setSetupIdCol(table.idColumn || table.columns[0]?.name || "id");
      setSetupColumns(
        table.columns
          .filter((c) => c.name !== (table.idColumn || "id"))
          .slice(0, 4)
          .map((c) => c.name)
      );
    }
  }

  // Filtered alerts
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      if (
        severityFilter !== "ALL" &&
        alert.severity.toLowerCase() !== severityFilter.toLowerCase()
      ) {
        return false;
      }
      if (
        categoryFilter !== "ALL" &&
        alert.ruleCategory !== categoryFilter
      ) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesText =
          alert.title.toLowerCase().includes(q) ||
          alert.tableName.toLowerCase().includes(q) ||
          alert.recordId.toLowerCase().includes(q) ||
          alert.reason.toLowerCase().includes(q) ||
          String(alert.actor || "").toLowerCase().includes(q);
        if (!matchesText) return false;
      }
      return true;
    });
  }, [alerts, severityFilter, categoryFilter, searchQuery]);

  // Counts
  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const highCount = alerts.filter((a) => a.severity === "high").length;
  const mediumCount = alerts.filter((a) => a.severity === "medium").length;
  const unreadCount = alerts.filter((a) => !reviewedAlertIds.has(a.id)).length;

  function toggleReview(id: string) {
    setReviewedAlertIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleExport(format: "csv" | "json") {
    const content =
      format === "csv" ? exportAlertsToCSV(alerts) : exportAlertsToJSON(alerts);
    const mime = format === "csv" ? "text/csv" : "application/json";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `querypilot-fraud-report-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyToClipboard(text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  const currentProfileInfo = BUSINESS_PROFILES[selectedProfile];

  return (
    <div className="qp-fraud-root">
      {/* HEADER BAR */}
      <div className="qp-fraud-header">
        <div>
          <div className="qp-badge-group">
            <span className="qp-eyebrow">FRAUD DETECTION & NOTIFICATIONS</span>
            <span className="qp-profile-badge">
              {currentProfileInfo?.name || "Universal Mode"}
            </span>
          </div>
          <h1>Universal Fraud Intelligence</h1>
          <p>
            Real-time anomaly monitoring, multi-vector fraud scanning, and
            security notifications for any business database.
          </p>
        </div>

        <div className="qp-header-actions">
          <button
            type="button"
            className="qp-btn qp-btn-secondary"
            onClick={() => handleExport("csv")}
            disabled={alerts.length === 0}
            title="Download CSV report"
          >
            <Download size={15} /> Export CSV
          </button>

          <button
            type="button"
            className="qp-btn qp-btn-primary"
            onClick={() => void runScan()}
            disabled={scanning}
          >
            <RefreshCw
              size={15}
              className={scanning ? "qp-spin" : undefined}
            />
            {scanning ? "Scanning Data..." : "Run Live Scan"}
          </button>
        </div>
      </div>

      {/* TABS */}
      <div className="qp-tabs">
        <button
          type="button"
          className={`qp-tab ${activeTab === "scanner" ? "active" : ""}`}
          onClick={() => setActiveTab("scanner")}
        >
          <Zap size={16} /> Live Scanner & Alerts
          {unreadCount > 0 && (
            <span className="qp-tab-count">{unreadCount}</span>
          )}
        </button>

        <button
          type="button"
          className={`qp-tab ${activeTab === "audit" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("audit");
            void loadAuditRecords();
          }}
        >
          <Activity size={16} /> Audit Changes & Tampering
        </button>

        <button
          type="button"
          className={`qp-tab ${activeTab === "setup" ? "active" : ""}`}
          onClick={() => setActiveTab("setup")}
        >
          <Sliders size={16} /> Universal Trigger Setup
        </button>
      </div>

      {/* FEEDBACK BANNERS */}
      {error && (
        <div className="qp-banner qp-banner-error">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">×</button>
        </div>
      )}

      {successMessage && (
        <div className="qp-banner qp-banner-success">
          <CheckCircle2 size={18} />
          <span>{successMessage}</span>
          <button onClick={() => setSuccessMessage("")} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* STATS OVERVIEW */}
      <div className="qp-stats-grid">
        <div className="qp-stat-card">
          <div className="qp-stat-top">
            <span>Total Alerts</span>
            <ShieldAlert size={18} className="qp-icon-warn" />
          </div>
          <strong>{alerts.length}</strong>
          <small>{unreadCount} unreviewed</small>
        </div>

        <div className="qp-stat-card">
          <div className="qp-stat-top">
            <span>Critical / High Risk</span>
            <AlertTriangle size={18} className="qp-icon-danger" />
          </div>
          <strong>{criticalCount + highCount}</strong>
          <small>{criticalCount} critical · {highCount} high</small>
        </div>

        <div className="qp-stat-card">
          <div className="qp-stat-top">
            <span>Medium / Low Risk</span>
            <Activity size={18} className="qp-icon-info" />
          </div>
          <strong>{mediumCount}</strong>
          <small>Potential anomalies</small>
        </div>

        <div className="qp-stat-card">
          <div className="qp-stat-top">
            <span>Audit Monitoring</span>
            <Database size={18} />
          </div>
          <strong className="qp-stat-status">
            {hasAuditTable ? "Active" : "Ready to Setup"}
          </strong>
          <small>
            {hasAuditTable
              ? "Trigger logging enabled"
              : "Read-only live scan"}
          </small>
        </div>
      </div>

      {/* TAB 1: LIVE SCANNER & ANOMALIES */}
      {activeTab === "scanner" && (
        <div className="qp-content-body">
          {/* PROFILE & SCAN CONTROLS */}
          <div className="qp-controls-card">
            <div className="qp-controls-header">
              <div className="qp-controls-title">
                <Sliders size={18} />
                <div>
                  <h3>Business Intelligence Profile</h3>
                  <p>
                    Select your business archetype for tailored fraud rules
                    and sensitivity.
                  </p>
                </div>
              </div>

              {/* PROFILE PILLS */}
              <div className="qp-profile-selector">
                {(
                  Object.keys(BUSINESS_PROFILES) as BusinessProfileType[]
                ).map((key) => {
                  const prof = BUSINESS_PROFILES[key];
                  const isActive = selectedProfile === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`qp-profile-btn ${isActive ? "active" : ""}`}
                      onClick={() => {
                        setSelectedProfile(key);
                        void runScan(key);
                      }}
                    >
                      {prof.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="qp-controls-row">
              {/* TABLE FILTER */}
              <div className="qp-control-group">
                <label>Filter Target Table</label>
                <div className="qp-select-wrapper">
                  <select
                    value={selectedTable}
                    onChange={(e) => setSelectedTable(e.target.value)}
                  >
                    <option value="ALL">All Available Tables</option>
                    {tables.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} ({t.columns.length} columns)
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="qp-select-arrow" />
                </div>
              </div>

              {/* SENSITIVITY */}
              <div className="qp-control-group">
                <label>Sensitivity Level</label>
                <div className="qp-select-wrapper">
                  <select
                    value={sensitivity}
                    onChange={(e) =>
                      setSensitivity(
                        e.target.value as "low" | "medium" | "high"
                      )
                    }
                  >
                    <option value="low">Low (Conservative Outliers)</option>
                    <option value="medium">Medium (Standard Detection)</option>
                    <option value="high">High (Strict Compliance)</option>
                  </select>
                  <ChevronDown size={14} className="qp-select-arrow" />
                </div>
              </div>

              {/* SCAN BUTTON */}
              <div className="qp-control-action">
                <button
                  type="button"
                  className="qp-btn qp-btn-primary"
                  onClick={() => void runScan()}
                  disabled={scanning}
                >
                  <RefreshCw
                    size={15}
                    className={scanning ? "qp-spin" : undefined}
                  />
                  {scanning ? "Scanning..." : "Apply & Scan"}
                </button>
              </div>
            </div>

            {currentProfileInfo && (
              <div className="qp-profile-hint">
                <strong>Active Rules: </strong>
                {currentProfileInfo.rules.join(" · ")}
              </div>
            )}
          </div>

          {/* SEARCH & FILTERS BAR */}
          <div className="qp-filter-bar">
            <div className="qp-search-box">
              <Search size={15} />
              <input
                type="text"
                placeholder="Search record, actor, or reason..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="qp-filter-pills">
              <span className="qp-filter-label">
                <Filter size={13} /> Severity:
              </span>
              {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((sev) => (
                <button
                  key={sev}
                  type="button"
                  className={`qp-pill-btn ${
                    severityFilter === sev ? "active" : ""
                  }`}
                  onClick={() => setSeverityFilter(sev)}
                >
                  {sev}
                </button>
              ))}
            </div>

            <div className="qp-filter-pills">
              <span className="qp-filter-label">Rule:</span>
              {[
                { label: "All", val: "ALL" },
                { label: "Outliers", val: "OUTLIER_AMOUNT" },
                { label: "Duplicates", val: "DUPLICATE_TRANSACTION" },
                { label: "Velocity", val: "VELOCITY_SPIKE" },
                { label: "Audit", val: "AUDIT_TAMPER" },
                { label: "Roles", val: "ROLE_ESCALATION" },
              ].map((item) => (
                <button
                  key={item.val}
                  type="button"
                  className={`qp-pill-btn ${
                    categoryFilter === item.val ? "active" : ""
                  }`}
                  onClick={() => setCategoryFilter(item.val)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* ALERTS FEED */}
          <div className="qp-alert-feed">
            {filteredAlerts.length === 0 ? (
              <div className="qp-empty-state">
                <ShieldCheck size={42} className="qp-icon-success" />
                <h3>No Suspicious Anomalies Detected</h3>
                <p>
                  No records matched the current criteria. Run a scan or
                  adjust sensitivity.
                </p>
              </div>
            ) : (
              filteredAlerts.map((alert) => {
                const isReviewed = reviewedAlertIds.has(alert.id);
                return (
                  <article
                    key={alert.id}
                    className={`qp-alert-card ${
                      isReviewed ? "reviewed" : ""
                    }`}
                  >
                    <div className="qp-alert-header">
                      <div className="qp-alert-badges">
                        <span
                          className={`qp-sev-badge ${alert.severity.toLowerCase()}`}
                        >
                          {alert.severity.toUpperCase()}
                        </span>
                        <span className="qp-cat-badge">
                          {alert.ruleCategory.replace(/_/g, " ")}
                        </span>
                        <span className="qp-table-badge">
                          Table: <strong>{alert.tableName}</strong>
                        </span>
                      </div>

                      <button
                        type="button"
                        className={`qp-review-btn ${
                          isReviewed ? "reviewed" : ""
                        }`}
                        onClick={() => toggleReview(alert.id)}
                      >
                        <UserCheck size={14} />
                        {isReviewed ? "Reviewed" : "Mark Reviewed"}
                      </button>
                    </div>

                    <h4 className="qp-alert-title">{alert.title}</h4>
                    <p className="qp-alert-reason">{alert.reason}</p>

                    {/* BEFORE / AFTER DIFF (if available) */}
                    {(alert.oldValue !== undefined ||
                      alert.newValue !== undefined) && (
                      <div className="qp-diff-box">
                        <div className="qp-diff-item">
                          <small>Prior Value</small>
                          <span>
                            {alert.oldValue === null ||
                            alert.oldValue === undefined
                              ? "—"
                              : String(alert.oldValue)}
                          </span>
                        </div>
                        <ArrowRight size={16} className="qp-diff-arrow" />
                        <div className="qp-diff-item highlight">
                          <small>Detected / New Value</small>
                          <span>
                            {alert.newValue === null ||
                            alert.newValue === undefined
                              ? "—"
                              : String(alert.newValue)}
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="qp-alert-meta-bar">
                      <span>
                        Record ID: <strong>{alert.recordId}</strong>
                      </span>
                      {alert.actor && (
                        <span>
                          Actor / User: <strong>{alert.actor}</strong>
                        </span>
                      )}
                      <span>
                        Detected:{" "}
                        {new Date(alert.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>

                    <div className="qp-recommendation-box">
                      <strong>Recommended Action: </strong>
                      <span>{alert.recommendation}</span>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 2: AUDIT ACTIVITY & TAMPERING */}
      {activeTab === "audit" && (
        <div className="qp-content-body">
          <div className="qp-section-title">
            <Activity size={20} />
            <div>
              <h3>Universal Audit Log Activity</h3>
              <p>
                Recorded database changes, suspicious field drops, and
                deletions across connected tables.
              </p>
            </div>
          </div>

          <div className="qp-alert-feed">
            {alerts.filter(
              (a) =>
                a.ruleCategory === "AUDIT_TAMPER" ||
                a.ruleCategory === "RECORD_DELETED"
            ).length === 0 ? (
              <div className="qp-empty-state">
                <Database size={40} />
                <h3>No Audit Tampering Detected</h3>
                <p>
                  No suspicious changes found in the connected audit table.
                  If you haven't enabled audit triggers yet, visit the
                  "Universal Trigger Setup" tab!
                </p>
              </div>
            ) : (
              alerts
                .filter(
                  (a) =>
                    a.ruleCategory === "AUDIT_TAMPER" ||
                    a.ruleCategory === "RECORD_DELETED"
                )
                .map((a) => (
                  <article key={a.id} className="qp-alert-card">
                    <div className="qp-alert-header">
                      <div className="qp-alert-badges">
                        <span
                          className={`qp-sev-badge ${a.severity.toLowerCase()}`}
                        >
                          {a.severity.toUpperCase()}
                        </span>
                        <span className="qp-cat-badge">
                          {a.eventType || "UPDATE"}
                        </span>
                        <span className="qp-table-badge">
                          Table: <strong>{a.tableName}</strong>
                        </span>
                      </div>
                    </div>

                    <h4 className="qp-alert-title">{a.title}</h4>
                    <p className="qp-alert-reason">{a.reason}</p>

                    <div className="qp-diff-box">
                      <div className="qp-diff-item">
                        <small>Old Value</small>
                        <span>
                          {a.oldValue === null || a.oldValue === undefined
                            ? "—"
                            : String(a.oldValue)}
                        </span>
                      </div>
                      <ArrowRight size={16} className="qp-diff-arrow" />
                      <div className="qp-diff-item highlight">
                        <small>New Value</small>
                        <span>
                          {a.newValue === null || a.newValue === undefined
                            ? "—"
                            : String(a.newValue)}
                        </span>
                      </div>
                    </div>

                    <div className="qp-alert-meta-bar">
                      <span>Record: {a.recordId}</span>
                      <span>User: {a.actor || "System/Postgres"}</span>
                      <span>Time: {a.timestamp}</span>
                    </div>
                  </article>
                ))
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TRIGGER SETUP (UNIVERSAL SQL GENERATOR) */}
      {activeTab === "setup" && (
        <div className="qp-content-body">
          <div className="qp-setup-card">
            <div className="qp-section-title">
              <Layers size={20} />
              <div>
                <h3>Universal Audit Trigger Generator</h3>
                <p>
                  Generate safe, battle-tested PostgreSQL triggers for any
                  table in your connected database.
                </p>
              </div>
            </div>

            <div className="qp-setup-form">
              <div className="qp-setup-row">
                {/* SELECT TABLE */}
                <div className="qp-setup-field">
                  <label>1. Select Table to Monitor</label>
                  <div className="qp-select-wrapper">
                    <select
                      value={setupTable}
                      onChange={(e) => onSetupTableChange(e.target.value)}
                    >
                      {tables.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="qp-select-arrow" />
                  </div>
                </div>

                {/* SELECT ID COLUMN */}
                <div className="qp-setup-field">
                  <label>2. Primary Key / Record Identifier</label>
                  <div className="qp-select-wrapper">
                    <select
                      value={setupIdCol}
                      onChange={(e) => setSetupIdCol(e.target.value)}
                    >
                      {tables
                        .find((t) => t.name === setupTable)
                        ?.columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name} ({c.dataType})
                          </option>
                        ))}
                    </select>
                    <ChevronDown size={14} className="qp-select-arrow" />
                  </div>
                </div>
              </div>

              {/* SELECT COLUMNS TO MONITOR */}
              <div className="qp-setup-field full-width">
                <label>3. Select Columns to Monitor for Tampering</label>
                <div className="qp-col-checkbox-grid">
                  {tables
                    .find((t) => t.name === setupTable)
                    ?.columns.filter((c) => c.name !== setupIdCol)
                    .map((col) => {
                      const isChecked = setupColumns.includes(col.name);
                      return (
                        <label
                          key={col.name}
                          className={`qp-col-pill ${
                            isChecked ? "checked" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSetupColumns([...setupColumns, col.name]);
                              } else {
                                setSetupColumns(
                                  setupColumns.filter((c) => c !== col.name)
                                );
                              }
                            }}
                          />
                          <span>{col.name}</span>
                          <small>({col.dataType})</small>
                        </label>
                      );
                    })}
                </div>
              </div>

              <button
                type="button"
                className="qp-btn qp-btn-primary"
                onClick={() => void generateSql()}
                disabled={loading}
              >
                {loading ? "Generating..." : "Generate Trigger SQL"}
              </button>
            </div>

            {/* GENERATED SQL DISPLAY */}
            {generatedSql && (
              <div className="qp-sql-output">
                <div className="qp-sql-header">
                  <span>Supabase SQL Editor Ready</span>
                  <button
                    type="button"
                    className="qp-btn qp-btn-secondary"
                    onClick={() => copyToClipboard(generatedSql)}
                  >
                    <Copy size={14} />
                    {copied ? "Copied!" : "Copy SQL"}
                  </button>
                </div>
                <pre className="qp-code-box">
                  <code>{generatedSql}</code>
                </pre>
                <div className="qp-setup-steps">
                  <h4>How to Apply in Supabase:</h4>
                  <ol>
                    <li>Click <strong>Copy SQL</strong> above.</li>
                    <li>
                      Open your <strong>Supabase Dashboard</strong> → Navigate to{" "}
                      <strong>SQL Editor</strong>.
                    </li>
                    <li>Paste the SQL script and click <strong>RUN</strong>.</li>
                    <li>
                      Done! QueryPilot-X will automatically capture real-time
                      changes for table <code>{setupTable}</code>.
                    </li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* COMPONENT SCOPED CSS STYLING */}
      <style jsx>{`
        .qp-fraud-root {
          display: flex;
          flex-direction: column;
          gap: 24px;
          max-width: 1200px;
          margin: 0 auto;
          color: #1a1c21;
          font-family: inherit;
        }

        .qp-fraud-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
          flex-wrap: wrap;
        }

        .qp-badge-group {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }

        .qp-eyebrow {
          font-size: 11px;
          font-weight: 750;
          letter-spacing: 1.5px;
          color: #8a9099;
        }

        .qp-profile-badge {
          background: #eff2f6;
          color: #2b303b;
          font-size: 11px;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 6px;
        }

        .qp-fraud-header h1 {
          font-size: 30px;
          font-weight: 700;
          letter-spacing: -1px;
          margin: 0 0 6px;
        }

        .qp-fraud-header p {
          color: #69707d;
          font-size: 13px;
          line-height: 1.6;
          margin: 0;
          max-width: 650px;
        }

        .qp-header-actions {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .qp-tabs {
          display: flex;
          gap: 8px;
          border-bottom: 1px solid #e5e8ec;
          padding-bottom: 2px;
        }

        .qp-tab {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: transparent;
          border: 0;
          border-bottom: 2px solid transparent;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 600;
          color: #717885;
          transition: all 0.15s ease;
        }

        .qp-tab:hover {
          color: #1a1c21;
        }

        .qp-tab.active {
          color: #1a1c21;
          border-bottom-color: #1a1c21;
        }

        .qp-tab-count {
          background: #e53935;
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 10px;
        }

        .qp-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
          gap: 14px;
        }

        .qp-stat-card {
          background: #fff;
          border: 1px solid #e9ebef;
          border-radius: 12px;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .qp-stat-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: #8c939e;
          font-size: 12px;
          font-weight: 600;
        }

        .qp-stat-card strong {
          font-size: 26px;
          letter-spacing: -0.6px;
          color: #1c1f24;
        }

        .qp-stat-card small {
          color: #8c939e;
          font-size: 11px;
        }

        .qp-stat-status {
          font-size: 18px !important;
          color: #198754 !important;
        }

        .qp-banner {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 9px;
          font-size: 13px;
        }

        .qp-banner button {
          margin-left: auto;
          background: transparent;
          border: 0;
          font-size: 18px;
          cursor: pointer;
          color: inherit;
        }

        .qp-banner-error {
          background: #fdf2f2;
          border: 1px solid #f8d7da;
          color: #b02a37;
        }

        .qp-banner-success {
          background: #f0fdf4;
          border: 1px solid #bbf7d0;
          color: #166534;
        }

        .qp-controls-card {
          background: #fff;
          border: 1px solid #e9ebef;
          border-radius: 12px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .qp-controls-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 16px;
        }

        .qp-controls-title {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }

        .qp-controls-title h3 {
          margin: 0 0 4px;
          font-size: 14px;
          font-weight: 700;
        }

        .qp-controls-title p {
          margin: 0;
          font-size: 12px;
          color: #79808d;
        }

        .qp-profile-selector {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .qp-profile-btn {
          border: 1px solid #dfe3e8;
          background: #fff;
          padding: 6px 11px;
          border-radius: 7px;
          font-size: 11px;
          font-weight: 600;
          color: #555d69;
          transition: all 0.15s;
        }

        .qp-profile-btn:hover {
          background: #f4f6f8;
        }

        .qp-profile-btn.active {
          background: #1a1c21;
          color: #fff;
          border-color: #1a1c21;
        }

        .qp-controls-row {
          display: flex;
          gap: 14px;
          align-items: flex-end;
          flex-wrap: wrap;
        }

        .qp-control-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
          flex: 1;
          min-width: 180px;
        }

        .qp-control-group label {
          font-size: 11px;
          font-weight: 700;
          color: #69707d;
        }

        .qp-select-wrapper {
          position: relative;
          display: flex;
          align-items: center;
        }

        .qp-select-wrapper select {
          width: 100%;
          border: 1px solid #dfe3e8;
          border-radius: 8px;
          padding: 9px 30px 9px 12px;
          font-size: 12px;
          background: #fff;
          color: #2b303b;
          appearance: none;
        }

        .qp-select-arrow {
          position: absolute;
          right: 10px;
          pointer-events: none;
          color: #717885;
        }

        .qp-profile-hint {
          font-size: 11px;
          color: #8c939e;
          background: #f9fafb;
          padding: 8px 12px;
          border-radius: 6px;
        }

        .qp-filter-bar {
          display: flex;
          gap: 14px;
          align-items: center;
          flex-wrap: wrap;
          padding: 10px 0;
        }

        .qp-search-box {
          display: flex;
          align-items: center;
          gap: 8px;
          border: 1px solid #dfe3e8;
          border-radius: 8px;
          padding: 8px 12px;
          background: #fff;
          width: 250px;
        }

        .qp-search-box input {
          border: 0;
          outline: 0;
          font-size: 12px;
          width: 100%;
          color: #1a1c21;
        }

        .qp-filter-pills {
          display: flex;
          gap: 5px;
          align-items: center;
        }

        .qp-filter-label {
          font-size: 11px;
          font-weight: 700;
          color: #717885;
          display: flex;
          align-items: center;
          gap: 4px;
          margin-right: 4px;
        }

        .qp-pill-btn {
          border: 1px solid #e1e5eb;
          background: #fff;
          font-size: 10px;
          font-weight: 600;
          padding: 5px 9px;
          border-radius: 6px;
          color: #555d69;
        }

        .qp-pill-btn.active {
          background: #2b303b;
          color: #fff;
          border-color: #2b303b;
        }

        .qp-alert-feed {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .qp-alert-card {
          background: #fff;
          border: 1px solid #e9ebef;
          border-radius: 12px;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: border-color 0.15s;
        }

        .qp-alert-card.reviewed {
          opacity: 0.65;
          background: #fafbfc;
        }

        .qp-alert-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .qp-alert-badges {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }

        .qp-sev-badge {
          font-size: 10px;
          font-weight: 800;
          padding: 3px 8px;
          border-radius: 6px;
          letter-spacing: 0.5px;
        }

        .qp-sev-badge.critical {
          background: #fde8e8;
          color: #c81e1e;
        }

        .qp-sev-badge.high {
          background: #feecdc;
          color: #b43403;
        }

        .qp-sev-badge.medium {
          background: #fef08a;
          color: #854d0e;
        }

        .qp-sev-badge.low {
          background: #e0f2fe;
          color: #0369a1;
        }

        .qp-cat-badge {
          background: #f1f3f5;
          color: #4b525d;
          font-size: 10px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 6px;
        }

        .qp-table-badge {
          font-size: 11px;
          color: #6c737f;
        }

        .qp-review-btn {
          border: 1px solid #dfe3e8;
          background: #fff;
          padding: 5px 9px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 5px;
          color: #4b525d;
        }

        .qp-review-btn.reviewed {
          background: #e6f4ea;
          color: #137333;
          border-color: #ceead6;
        }

        .qp-alert-title {
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.3px;
          margin: 0;
          color: #1c1f24;
        }

        .qp-alert-reason {
          font-size: 13px;
          line-height: 1.6;
          color: #4f5663;
          margin: 0;
        }

        .qp-diff-box {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #f8f9fa;
          border: 1px solid #edf0f2;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 12px;
        }

        .qp-diff-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .qp-diff-item small {
          font-size: 10px;
          color: #8a919d;
          font-weight: 600;
        }

        .qp-diff-item strong,
        .qp-diff-item span {
          font-family: monospace;
          color: #31363f;
        }

        .qp-diff-item.highlight span {
          color: #b42318;
          font-weight: 700;
        }

        .qp-diff-arrow {
          color: #9ba1ac;
        }

        .qp-alert-meta-bar {
          display: flex;
          gap: 16px;
          font-size: 11px;
          color: #8c939e;
          flex-wrap: wrap;
        }

        .qp-recommendation-box {
          background: #fbfbfc;
          border-left: 3px solid #1a1c21;
          padding: 8px 12px;
          font-size: 12px;
          color: #374151;
          line-height: 1.5;
        }

        .qp-empty-state {
          text-align: center;
          padding: 60px 20px;
          background: #fff;
          border: 1px solid #eaedf0;
          border-radius: 12px;
          color: #8a919d;
        }

        .qp-empty-state h3 {
          margin: 14px 0 6px;
          color: #1c1f24;
          font-size: 16px;
        }

        .qp-empty-state p {
          margin: 0;
          font-size: 13px;
        }

        .qp-setup-card {
          background: #fff;
          border: 1px solid #e9ebef;
          border-radius: 12px;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .qp-section-title {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }

        .qp-section-title h3 {
          margin: 0 0 4px;
          font-size: 16px;
          font-weight: 700;
        }

        .qp-section-title p {
          margin: 0;
          font-size: 13px;
          color: #717885;
        }

        .qp-setup-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .qp-setup-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
        }

        .qp-setup-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .qp-setup-field label {
          font-size: 12px;
          font-weight: 700;
          color: #4b525d;
        }

        .qp-col-checkbox-grid {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px 0;
        }

        .qp-col-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: #f8f9fb;
          border: 1px solid #dfe3e8;
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
        }

        .qp-col-pill.checked {
          background: #eff6ff;
          border-color: #93c5fd;
          color: #1e40af;
          font-weight: 600;
        }

        .qp-col-pill small {
          color: #8c939e;
          font-size: 9px;
        }

        .qp-sql-output {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-top: 10px;
        }

        .qp-sql-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          font-weight: 700;
          color: #4b525d;
        }

        .qp-code-box {
          background: #111827;
          color: #f3f4f6;
          padding: 16px;
          border-radius: 9px;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.5;
          max-height: 380px;
          overflow: auto;
        }

        .qp-setup-steps {
          background: #f9fafb;
          border: 1px solid #edf0f2;
          padding: 16px;
          border-radius: 9px;
          font-size: 13px;
        }

        .qp-setup-steps h4 {
          margin: 0 0 10px;
          font-size: 13px;
          font-weight: 700;
        }

        .qp-setup-steps ol {
          margin: 0;
          padding-left: 20px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .qp-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 9px 14px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }

        .qp-btn-primary {
          background: #1a1c21;
          color: #fff;
          border: 1px solid #1a1c21;
        }

        .qp-btn-primary:hover:not(:disabled) {
          background: #2e323b;
        }

        .qp-btn-secondary {
          background: #fff;
          color: #4b525d;
          border: 1px solid #dfe3e8;
        }

        .qp-btn-secondary:hover:not(:disabled) {
          background: #f8f9fb;
        }

        .qp-spin {
          animation: qp-spin-kf 1s linear infinite;
        }

        @keyframes qp-spin-kf {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
