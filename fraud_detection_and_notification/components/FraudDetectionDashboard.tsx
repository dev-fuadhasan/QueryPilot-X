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
} from "lucide-react";
import type { ChangeNotification } from "../types";
import { exportChangeNotificationsToCSV } from "../notification-service";

const SNAPSHOT_KEY = "qp_table_snapshot_v1";
const HISTORY_KEY = "qp_change_notifications_v1";

export default function FraudDetectionDashboard() {
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [newAlertNotice, setNewAlertNotice] = useState<string | null>(null);

  // Monitored tables
  const [monitoredTables, setMonitoredTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Change Notifications List
  const [notifications, setNotifications] = useState<ChangeNotification[]>([]);
  const [isLiveActive, setIsLiveActive] = useState(true);

  // Snapshot ref to compare between polling ticks
  const snapshotRef = useRef<Record<string, Record<string, unknown>[]>>({});

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

  // Load existing notifications from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChangeNotification[];
        if (Array.isArray(parsed)) {
          setNotifications(parsed);
        }
      }
      const storedSnapshot = localStorage.getItem(SNAPSHOT_KEY);
      if (storedSnapshot) {
        snapshotRef.current = JSON.parse(storedSnapshot);
      }
    } catch {
      // Ignored
    }
  }, []);

  // Save notifications to localStorage when updated
  const saveNotifications = useCallback((items: ChangeNotification[]) => {
    setNotifications(items);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 500)));
    } catch {
      // Ignored
    }
  }, []);

  // Core Snapshot & Diffing Engine
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

        const currentSnapshot: Record<string, Record<string, unknown>[]> =
          data.snapshot || {};
        const prevSnapshot = snapshotRef.current;

        const detectedChanges: ChangeNotification[] = [];
        const nowIso = new Date().toISOString();

        // 1. Compare current rows against previous snapshot
        for (const [tableName, currentRows] of Object.entries(currentSnapshot)) {
          const prevRows = prevSnapshot[tableName] || [];

          // Index previous rows by 'id' or first column
          const prevRowMap = new Map<string, Record<string, unknown>>();
          for (const r of prevRows) {
            const key = String(r.id ?? r.uuid ?? Object.values(r)[0] ?? "");
            if (key) prevRowMap.set(key, r);
          }

          // Check each current row
          for (const cur of currentRows) {
            const rowId = String(
              cur.id ?? cur.uuid ?? Object.values(cur)[0] ?? "unknown"
            );
            const prev = prevRowMap.get(rowId);

            if (prev) {
              // Row existed before: Check if ANY column value changed!
              for (const [colName, curVal] of Object.entries(cur)) {
                // Ignore automatic update timestamp columns from causing diff loops
                if (
                  colName.toLowerCase() === "updated_at" ||
                  colName.toLowerCase() === "updatedat"
                ) {
                  continue;
                }

                const oldVal = prev[colName];
                const strOld = oldVal === null || oldVal === undefined ? "" : String(oldVal);
                const strCur = curVal === null || curVal === undefined ? "" : String(curVal);

                if (strOld !== strCur) {
                  // A cell was changed in the database!
                  const changeId = `${tableName}-${rowId}-${colName}-${Date.now()}`;
                  detectedChanges.push({
                    id: changeId,
                    tableName,
                    recordId: rowId,
                    columnName: colName,
                    oldValue: oldVal ?? "NULL",
                    newValue: curVal ?? "NULL",
                    changedBy: "Database Editor / User",
                    timestamp: nowIso,
                    changeType: "VALUE_CHANGED",
                    reason: `Field "${colName}" changed from "${strOld}" to "${strCur}".`,
                    isRead: false,
                  });
                }
              }
            } else if (prevRows.length > 0) {
              // New row added after initial snapshot
              detectedChanges.push({
                id: `${tableName}-${rowId}-new-${Date.now()}`,
                tableName,
                recordId: rowId,
                columnName: "Entire Record",
                oldValue: "None (New)",
                newValue: JSON.stringify(cur),
                changedBy: "Database Insert",
                timestamp: nowIso,
                changeType: "RECORD_INSERTED",
                reason: `New record #${rowId} added to table "${tableName}".`,
                isRead: false,
              });
            }
          }
        }

        // 2. Also incorporate database audit log records (e.g. sales_audit_log or universal)
        const auditChanges = data.auditChanges || [];
        for (const ac of auditChanges) {
          detectedChanges.push({
            id: `audit-${ac.id}`,
            tableName: ac.tableName,
            recordId: ac.recordId,
            columnName: ac.columnName,
            oldValue: ac.oldValue,
            newValue: ac.newValue,
            changedBy: ac.changedBy || "Database User",
            timestamp: ac.changedAt || nowIso,
            changeType: ac.eventType || "UPDATE",
            reason: `${ac.columnName} updated from ${String(ac.oldValue)} to ${String(ac.newValue)}.`,
            isRead: false,
          });
        }

        // Update snapshot ref & localStorage
        snapshotRef.current = currentSnapshot;
        try {
          localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(currentSnapshot));
        } catch {
          // Ignored
        }

        // Prepend new changes if any were found
        if (detectedChanges.length > 0) {
          setNotifications((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const fresh = detectedChanges.filter((d) => !existingIds.has(d.id));

            if (fresh.length > 0) {
              setNewAlertNotice(
                `🔔 ${fresh.length} new change${fresh.length > 1 ? "s" : ""} detected in your data!`
              );
              setTimeout(() => setNewAlertNotice(null), 5000);
              const combined = [...fresh, ...prev];
              try {
                localStorage.setItem(
                  HISTORY_KEY,
                  JSON.stringify(combined.slice(0, 500))
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
    saveNotifications(updated);
  };

  // Mark all as read
  const markAllAsRead = () => {
    const updated = notifications.map((n) => ({ ...n, isRead: true }));
    saveNotifications(updated);
  };

  // Clear all history
  const clearHistory = () => {
    if (confirm("Are you sure you want to clear change notifications history?")) {
      saveNotifications([]);
    }
  };

  // Filtered notifications
  const filteredNotifications = useMemo(() => {
    return notifications.filter((item) => {
      if (selectedTable !== "ALL" && item.tableName !== selectedTable) {
        return false;
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
  }, [notifications, selectedTable, searchQuery]);

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

  return (
    <div className="qp-simple-root">
      {/* TOP HEADER */}
      <div className="qp-simple-header">
        <div>
          <div className="qp-live-tag">
            <span
              className={`qp-pulse-dot ${isLiveActive ? "online" : "offline"}`}
            />
            <span className="qp-live-text">
              {isLiveActive ? "LIVE AUTO-MONITORING ACTIVE" : "MONITORING PAUSED"}
            </span>
            <button
              type="button"
              className="qp-pause-btn"
              onClick={() => setIsLiveActive(!isLiveActive)}
            >
              {isLiveActive ? "Pause" : "Resume"}
            </button>
          </div>
          <h1>Data Change & Fraud Notifications</h1>
          <p>
            Whenever any small change or update happens in your database, it is
            immediately recorded below with exact date, time, and value changes.
          </p>
        </div>

        <div className="qp-simple-actions">
          <button
            type="button"
            className="qp-action-btn secondary"
            onClick={handleExportCSV}
            disabled={notifications.length === 0}
            title="Download full history as CSV"
          >
            <Download size={15} /> Export CSV
          </button>

          <button
            type="button"
            className="qp-action-btn primary"
            onClick={() => void checkForChanges(true)}
            disabled={checking}
          >
            <RefreshCw
              size={15}
              className={checking ? "qp-spinning" : undefined}
            />
            {checking ? "Checking..." : "Check Now"}
          </button>
        </div>
      </div>

      {/* NEW ALERT TOAST NOTICE */}
      {newAlertNotice && (
        <div className="qp-toast-notice">
          <Bell size={18} />
          <strong>{newAlertNotice}</strong>
        </div>
      )}

      {error && (
        <div className="qp-simple-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* METRICS SUMMARY */}
      <div className="qp-simple-summary">
        <div className="qp-summary-box">
          <span>Total Changes Detected</span>
          <strong>{notifications.length}</strong>
          <small>Recorded in your database</small>
        </div>

        <div className="qp-summary-box highlight">
          <span>Unread Notifications</span>
          <strong>{unreadCount}</strong>
          <small>Requiring review</small>
        </div>

        <div className="qp-summary-box">
          <span>Monitored Datasets (Tables)</span>
          <strong>{monitoredTables.length}</strong>
          <small>{monitoredTables.join(", ") || "Active tables"}</small>
        </div>
      </div>

      {/* CONTROLS & FILTER BAR */}
      <div className="qp-simple-toolbar">
        {/* DATASET FILTER */}
        <div className="qp-tool-item">
          <label>Filter by Dataset:</label>
          <select
            value={selectedTable}
            onChange={(e) => setSelectedTable(e.target.value)}
          >
            <option value="ALL">All Datasets ({monitoredTables.length} tables)</option>
            {monitoredTables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* SEARCH BAR */}
        <div className="qp-tool-item search-item">
          <Search size={15} />
          <input
            type="text"
            placeholder="Search by dataset, field, value, record ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* BULK ACTIONS */}
        <div className="qp-bulk-actions">
          {unreadCount > 0 && (
            <button
              type="button"
              className="qp-text-btn"
              onClick={markAllAsRead}
            >
              <CheckCheck size={15} /> Mark All as Read
            </button>
          )}

          {notifications.length > 0 && (
            <button
              type="button"
              className="qp-text-btn danger"
              onClick={clearHistory}
            >
              Clear History
            </button>
          )}
        </div>
      </div>

      {/* THE MAIN CHANGE NOTIFICATIONS FEED */}
      <div className="qp-feed-section">
        <div className="qp-feed-title">
          <Layers size={18} />
          <h2>Change & Modification Log</h2>
          <span className="qp-feed-count">
            {filteredNotifications.length} change
            {filteredNotifications.length === 1 ? "" : "s"}
          </span>
        </div>

        {filteredNotifications.length === 0 ? (
          <div className="qp-empty-box">
            <CheckCircle2 size={44} className="qp-empty-icon" />
            <h3>No Changes Recorded Yet</h3>
            <p>
              Live monitoring is active. Go to your database or Supabase and make
              any change to any row or value—it will immediately appear here with
              exact date, time, and value changes!
            </p>
          </div>
        ) : (
          <div className="qp-change-list">
            {filteredNotifications.map((item) => (
              <article
                key={item.id}
                className={`qp-change-card ${item.isRead ? "read" : "unread"}`}
                onClick={() => !item.isRead && markAsRead(item.id)}
              >
                {/* CARD HEADER */}
                <div className="qp-card-top">
                  <div className="qp-meta-left">
                    <span className="qp-date-pill">
                      <Calendar size={13} />
                      {formatDateTime(item.timestamp)}
                    </span>
                    <span className="qp-table-tag">
                      <Database size={13} />
                      {item.tableName}
                    </span>
                    <span className="qp-record-tag">
                      Record: <strong>#{item.recordId}</strong>
                    </span>
                  </div>

                  <div className="qp-meta-right">
                    {!item.isRead && (
                      <span className="qp-unread-badge">
                        <Sparkles size={11} /> NEW
                      </span>
                    )}
                    <button
                      type="button"
                      className="qp-card-read-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        markAsRead(item.id);
                      }}
                      title="Mark as read"
                    >
                      <CheckCircle2 size={16} />
                    </button>
                  </div>
                </div>

                {/* THE CORE BEFORE -> AFTER CHANGE DISPLAY */}
                <div className="qp-diff-display">
                  <div className="qp-diff-field-name">
                    <span>Field Changed:</span>
                    <strong>{item.columnName}</strong>
                  </div>

                  <div className="qp-diff-values">
                    <div className="qp-val-box old">
                      <small>Previous Value</small>
                      <span title={String(item.oldValue)}>
                        {String(item.oldValue)}
                      </span>
                    </div>

                    <ArrowRight size={18} className="qp-arrow-icon" />

                    <div className="qp-val-box new">
                      <small>New Value</small>
                      <span title={String(item.newValue)}>
                        {String(item.newValue)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* FOOTER DETAILS */}
                <div className="qp-card-footer">
                  <span className="qp-reason-text">
                    {item.reason || `Value in ${item.columnName} was modified.`}
                  </span>
                  <span className="qp-actor-text">
                    Editor: <strong>{item.changedBy || "Database User"}</strong>
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* COMPONENT STYLES */}
      <style jsx>{`
        .qp-simple-root {
          display: flex;
          flex-direction: column;
          gap: 20px;
          max-width: 1100px;
          margin: 0 auto;
          color: #191b20;
          font-family: inherit;
        }

        .qp-simple-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
          flex-wrap: wrap;
        }

        .qp-live-tag {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: #f1f4f8;
          padding: 5px 12px;
          border-radius: 20px;
          margin-bottom: 10px;
        }

        .qp-pulse-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
        }

        .qp-pulse-dot.online {
          background: #10b981;
          box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
        }

        .qp-pulse-dot.offline {
          background: #9ca3af;
        }

        .qp-live-text {
          font-size: 11px;
          font-weight: 750;
          letter-spacing: 0.8px;
          color: #374151;
        }

        .qp-pause-btn {
          background: transparent;
          border: 0;
          color: #6b7280;
          font-size: 11px;
          text-decoration: underline;
          cursor: pointer;
          padding: 0;
        }

        .qp-simple-header h1 {
          font-size: 28px;
          font-weight: 750;
          letter-spacing: -0.8px;
          margin: 0 0 6px;
        }

        .qp-simple-header p {
          color: #6b7280;
          font-size: 13px;
          margin: 0;
          max-width: 600px;
          line-height: 1.5;
        }

        .qp-simple-actions {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .qp-action-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 9px 15px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }

        .qp-action-btn.primary {
          background: #191b20;
          color: #fff;
          border: 1px solid #191b20;
        }

        .qp-action-btn.primary:hover:not(:disabled) {
          background: #32363f;
        }

        .qp-action-btn.secondary {
          background: #fff;
          color: #374151;
          border: 1px solid #d1d5db;
        }

        .qp-action-btn.secondary:hover:not(:disabled) {
          background: #f9fafb;
        }

        .qp-toast-notice {
          display: flex;
          align-items: center;
          gap: 10px;
          background: #ecfdf5;
          border: 1px solid #6ee7b7;
          color: #065f46;
          padding: 12px 16px;
          border-radius: 9px;
          font-size: 13px;
          animation: slideDown 0.3s ease-out;
        }

        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .qp-simple-error {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #fef2f2;
          border: 1px solid #fca5a5;
          color: #991b1b;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 12px;
        }

        .qp-simple-error button {
          background: transparent;
          border: 0;
          font-size: 18px;
          cursor: pointer;
          color: inherit;
        }

        .qp-simple-summary {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
        }

        .qp-summary-box {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 11px;
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .qp-summary-box.highlight {
          border-color: #fbbf24;
          background: #fffdf5;
        }

        .qp-summary-box span {
          font-size: 11px;
          font-weight: 700;
          color: #6b7280;
          letter-spacing: 0.3px;
        }

        .qp-summary-box strong {
          font-size: 26px;
          font-weight: 800;
          color: #111827;
          letter-spacing: -0.5px;
        }

        .qp-summary-box small {
          font-size: 11px;
          color: #9ca3af;
        }

        .qp-simple-toolbar {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 12px 16px;
        }

        .qp-tool-item {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .qp-tool-item label {
          font-size: 12px;
          font-weight: 650;
          color: #4b5563;
        }

        .qp-tool-item select {
          border: 1px solid #d1d5db;
          border-radius: 7px;
          padding: 6px 10px;
          font-size: 12px;
          background: #fff;
          color: #1f2937;
        }

        .qp-tool-item.search-item {
          display: flex;
          align-items: center;
          gap: 7px;
          border: 1px solid #d1d5db;
          border-radius: 7px;
          padding: 6px 10px;
          background: #fff;
          flex: 1;
          min-width: 220px;
        }

        .qp-tool-item.search-item input {
          border: 0;
          outline: 0;
          font-size: 12px;
          width: 100%;
        }

        .qp-bulk-actions {
          display: flex;
          gap: 8px;
          margin-left: auto;
        }

        .qp-text-btn {
          background: transparent;
          border: 0;
          color: #4b5563;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 6px;
        }

        .qp-text-btn:hover {
          color: #111827;
        }

        .qp-text-btn.danger {
          color: #dc2626;
        }

        .qp-feed-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .qp-feed-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .qp-feed-title h2 {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
        }

        .qp-feed-count {
          font-size: 11px;
          font-weight: 700;
          background: #f3f4f6;
          color: #4b5563;
          padding: 3px 8px;
          border-radius: 12px;
        }

        .qp-empty-box {
          text-align: center;
          padding: 50px 20px;
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          color: #6b7280;
        }

        .qp-empty-box h3 {
          margin: 12px 0 6px;
          font-size: 16px;
          color: #111827;
        }

        .qp-empty-box p {
          margin: 0;
          font-size: 13px;
          max-width: 500px;
          margin-inline: auto;
          line-height: 1.5;
        }

        .qp-change-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .qp-change-card {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 11px;
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          transition: all 0.15s ease;
          cursor: pointer;
        }

        .qp-change-card:hover {
          border-color: #cbd5e1;
        }

        .qp-change-card.unread {
          border-left: 4px solid #3b82f6;
          background: #fdfefe;
        }

        .qp-change-card.read {
          opacity: 0.85;
          background: #fff;
        }

        .qp-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }

        .qp-meta-left {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        .qp-date-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 700;
          background: #f3f4f6;
          color: #374151;
          padding: 3px 9px;
          border-radius: 6px;
        }

        .qp-table-tag {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 650;
          color: #1e40af;
          background: #eff6ff;
          padding: 3px 8px;
          border-radius: 6px;
        }

        .qp-record-tag {
          font-size: 11px;
          color: #6b7280;
        }

        .qp-record-tag strong {
          color: #111827;
        }

        .qp-meta-right {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .qp-unread-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
          font-weight: 800;
          color: #1d4ed8;
          background: #dbeafe;
          padding: 2px 7px;
          border-radius: 10px;
        }

        .qp-card-read-btn {
          background: transparent;
          border: 0;
          color: #9ca3af;
          cursor: pointer;
          padding: 2px;
          display: flex;
          align-items: center;
        }

        .qp-card-read-btn:hover {
          color: #10b981;
        }

        .qp-diff-display {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          background: #f8fafc;
          border: 1px solid #edf2f7;
          border-radius: 9px;
          padding: 12px 16px;
          flex-wrap: wrap;
        }

        .qp-diff-field-name {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .qp-diff-field-name span {
          font-size: 10px;
          font-weight: 700;
          color: #64748b;
          text-transform: uppercase;
        }

        .qp-diff-field-name strong {
          font-size: 14px;
          color: #0f172a;
        }

        .qp-diff-values {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
          justify-content: flex-end;
          min-width: 250px;
        }

        .qp-val-box {
          display: flex;
          flex-direction: column;
          gap: 2px;
          max-width: 220px;
        }

        .qp-val-box small {
          font-size: 10px;
          font-weight: 700;
          color: #94a3b8;
        }

        .qp-val-box span {
          font-family: monospace;
          font-size: 13px;
          word-break: break-all;
        }

        .qp-val-box.old span {
          color: #dc2626;
          text-decoration: line-through;
        }

        .qp-val-box.new span {
          color: #059669;
          font-weight: 750;
        }

        .qp-arrow-icon {
          color: #94a3b8;
          flex-shrink: 0;
        }

        .qp-card-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
          color: #6b7280;
          gap: 10px;
          flex-wrap: wrap;
        }

        .qp-actor-text strong {
          color: #374151;
        }

        .qp-spinning {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
