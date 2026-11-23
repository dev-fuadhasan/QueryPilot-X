"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Layers,
  RefreshCw,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { BusinessDomainId, DatabaseProfile, DomainTableUnderstanding, TableProfile } from "../profiler/types";
import { DOMAIN_UI_CATALOG, getAmbiguousColumnMatches, getDomainUiMeta } from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

type DomainDatasetBarProps = {
  selectedDomain: BusinessDomainId;
  selectedDataset: string;
  profile: DatabaseProfile | null;
  availableTables: TableProfile[];
  understanding: DomainTableUnderstanding | null;
  columnOverrides: Record<string, string>;
  loadingProfile: boolean;
  loadingAnalysis: boolean;
  onDomainChange: (domain: BusinessDomainId) => void;
  onDatasetChange: (tableName: string) => void;
  onOverrideChange: (role: string, columnName: string) => void;
  onClearOverrides: () => void;
  onApplyOverrides: () => void;
  onRefreshAll: () => void;
};

export default function DomainDatasetBar({
  selectedDomain,
  selectedDataset,
  profile,
  availableTables,
  understanding,
  columnOverrides,
  loadingProfile,
  loadingAnalysis,
  onDomainChange,
  onDatasetChange,
  onOverrideChange,
  onClearOverrides,
  onApplyOverrides,
  onRefreshAll
}: DomainDatasetBarProps) {
  const [schemaOpen, setSchemaOpen] = useState(false);

  const domainMeta = getDomainUiMeta(selectedDomain);
  const currentTable = availableTables.find(item => item.name === selectedDataset) || null;
  const ambiguousMatches = getAmbiguousColumnMatches(understanding);
  const assignedRoles = understanding ? Object.values(understanding.roleAssignments) : [];
  const missingRoles = understanding?.missingRequiredRoles || [];
  const availableMetricCount = understanding
    ? understanding.availableMetrics.filter(metric => metric.available).length
    : 0;
  const totalMetricCount = understanding ? understanding.availableMetrics.length : 0;
  const needsAttention = ambiguousMatches.length > 0 || missingRoles.length > 0;
  const overrideCount = Object.keys(columnOverrides).length;

  return (
    <section className={styles.selectorBar} aria-label="Business domain and dataset selection">
      <div className={styles.selectorRow}>
        <div className={styles.fieldGroup}>
          <label htmlFor="qp-domain-select" className={styles.fieldLabel}>
            Business Domain
          </label>
          <select
            id="qp-domain-select"
            className={styles.selectInput}
            value={selectedDomain}
            disabled={loadingProfile}
            onChange={event => onDomainChange(event.target.value as BusinessDomainId)}
          >
            {DOMAIN_UI_CATALOG.map(domain => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="qp-dataset-select" className={styles.fieldLabel}>
            Connected Table / View (Read-Only)
          </label>
          <select
            id="qp-dataset-select"
            className={styles.selectInput}
            value={selectedDataset}
            disabled={loadingProfile || availableTables.length === 0}
            onChange={event => onDatasetChange(event.target.value)}
          >
            {availableTables.length === 0 ? (
              <option value="">{loadingProfile ? "Profiling connected database..." : "No readable tables found"}</option>
            ) : (
              availableTables.map(table => (
                <option key={table.name} value={table.name}>
                  {table.name} ({table.tableType === "VIEW" ? "View" : "Table"} · {table.rowCount.toLocaleString()} rows)
                </option>
              ))
            )}
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => setSchemaOpen(prev => !prev)}
            aria-expanded={schemaOpen}
            aria-controls="qp-column-understanding-panel"
          >
            <Layers size={14} />
            Column Understanding
            {needsAttention && (
              <span className={`${styles.badge} ${styles.badgeWarning}`}>
                {ambiguousMatches.length + missingRoles.length}
              </span>
            )}
            {schemaOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          <button
            type="button"
            className={styles.secondaryBtn}
            disabled={loadingProfile || loadingAnalysis || !selectedDataset}
            onClick={onRefreshAll}
            aria-label="Refresh analysis from connected database"
          >
            <RefreshCw size={14} className={loadingProfile || loadingAnalysis ? "spinning" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className={styles.domainMetaStrip}>
        <div className={styles.metaPills}>
          <span className={`${styles.badge} ${styles.badgeInfo}`}>
            <Sparkles size={12} /> {domainMeta.shortName}
          </span>
          {currentTable && (
            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
              <Database size={11} />
              {currentTable.freshness.earliestDate && currentTable.freshness.latestDate
                ? `History: ${currentTable.freshness.earliestDate.slice(0, 10)} to ${currentTable.freshness.latestDate.slice(0, 10)}`
                : "No date range detected"}
            </span>
          )}
          {understanding && (
            <span className={`${styles.badge} ${understanding.readyForAnalysis ? styles.badgePositive : styles.badgeWarning}`}>
              {understanding.readyForAnalysis ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
              {availableMetricCount}/{totalMetricCount} domain metrics ready
            </span>
          )}
          {profile?.suggestedDomain && profile.suggestedDomain.domainId !== selectedDomain && (
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => onDomainChange(profile.suggestedDomain!.domainId)}
              title="Switch to the profiler's highest-confidence domain match"
            >
              Suggested domain: {profile.suggestedDomain.domainName} ({profile.suggestedDomain.confidence})
            </button>
          )}
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <ShieldCheck size={13} /> Read-only source access · {domainMeta.focusSummary}
        </span>
      </div>

      {needsAttention && !schemaOpen && (
        <div className={styles.warnBanner} role="status">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Automatic Column Understanding flagged items to review: </strong>
            {missingRoles.length > 0 && (
              <span>Missing required role(s): {missingRoles.join(", ")}. </span>
            )}
            {ambiguousMatches.length > 0 && (
              <span>Ambiguous column(s): {ambiguousMatches.map(m => m.columnName).join(", ")}. </span>
            )}
            <button
              type="button"
              className={styles.ghostBtn}
              style={{ padding: "2px 6px", textDecoration: "underline" }}
              onClick={() => setSchemaOpen(true)}
            >
              Review &amp; confirm
            </button>
          </div>
        </div>
      )}

      {schemaOpen && (
        <div id="qp-column-understanding-panel" className={styles.columnPanel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <strong style={{ fontSize: 12.5 }}>Automatic Column Understanding</strong>
              <p className={styles.cardSub}>
                Fields are inferred automatically from schema types, semantic aliases, and safe metadata aggregates. Manual confirmation is only needed for ambiguous or missing required roles.
              </p>
            </div>
            {overrideCount > 0 && (
              <button type="button" className={styles.ghostBtn} onClick={onClearOverrides}>
                Reset {overrideCount} override(s)
              </button>
            )}
          </div>

          {assignedRoles.length > 0 ? (
            <div className={styles.columnGrid}>
              {assignedRoles.map(assignment => (
                <div className={styles.columnChip} key={assignment.role}>
                  <div className={styles.columnChipHead}>
                    <strong>{assignment.role}</strong>
                    <span
                      className={`${styles.badge} ${
                        assignment.confidence === "high"
                          ? styles.badgePositive
                          : assignment.confidence === "medium"
                            ? styles.badgeInfo
                            : styles.badgeWarning
                      }`}
                    >
                      {assignment.confidence}
                    </span>
                  </div>
                  <small>
                    Column: <code>{columnOverrides[assignment.role] || assignment.columnName}</code> ({assignment.rawDataType})
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.cardSub}>No automatic semantic fields detected yet for this table and domain.</p>
          )}

          {(ambiguousMatches.length > 0 || missingRoles.length > 0) && currentTable && (
            <div className={styles.ambiguousBox}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 12, color: "#7d5312", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} /> Limited Confirmation Needed ({ambiguousMatches.length + missingRoles.length})
                </strong>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  style={{ padding: "6px 12px", fontSize: 11.5 }}
                  onClick={onApplyOverrides}
                  disabled={loadingAnalysis}
                >
                  Apply Confirmation &amp; Re-Analyze
                </button>
              </div>

              {missingRoles.map(role => (
                <div className={styles.ambiguousRow} key={`missing-${role}`}>
                  <div style={{ fontSize: 11.5 }}>
                    <strong>Missing required role: <code>{role}</code></strong>
                    <div style={{ color: "#7d5312", fontSize: 11 }}>Select the matching column if present in {currentTable.name}.</div>
                  </div>
                  <select
                    aria-label={`Assign column for required role ${role}`}
                    className={styles.selectInput}
                    value={columnOverrides[role] || ""}
                    onChange={event => onOverrideChange(role, event.target.value)}
                  >
                    <option value="">Not mapped (keep metric unavailable)</option>
                    {currentTable.columns.map(col => (
                      <option key={col.name} value={col.name}>
                        {col.name} ({col.rawDataType})
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              {ambiguousMatches.map(match => {
                const targetRole = match.suggestedRole || match.candidates[0]?.role || "";
                if (!targetRole) return null;
                return (
                  <div className={styles.ambiguousRow} key={`amb-${match.columnName}`}>
                    <div style={{ fontSize: 11.5 }}>
                      <strong>Uncertain column: <code>{match.columnName}</code></strong>
                      <div style={{ color: "#7d5312", fontSize: 11 }}>
                        Candidates: {match.candidates.slice(0, 3).map(c => `${c.role} (${c.confidence})`).join(", ")}
                      </div>
                    </div>
                    <select
                      aria-label={`Confirm column for ambiguous role ${targetRole}`}
                      className={styles.selectInput}
                      value={columnOverrides[targetRole] ?? (match.assignedRole ? match.columnName : "")}
                      onChange={event => onOverrideChange(targetRole, event.target.value)}
                    >
                      <option value="">Auto ({match.assignedRole ? match.columnName : "unassigned"})</option>
                      {currentTable.columns.map(col => (
                        <option key={col.name} value={col.name}>
                          {col.name} ({col.rawDataType})
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
