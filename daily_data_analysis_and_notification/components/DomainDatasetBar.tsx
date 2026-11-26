"use client";

import { Database, RefreshCw, Sparkles, Table2 } from "lucide-react";
import type { BusinessDomainId, DatabaseProfile, DomainTableUnderstanding, TableProfile } from "../profiler/types";
import { getDomainUiMeta } from "./dashboard-helpers";
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
  availableTables,
  loadingProfile,
  loadingAnalysis,
  onDatasetChange,
  onRefreshAll
}: DomainDatasetBarProps) {
  const domainMeta = getDomainUiMeta(selectedDomain);
  const currentTable = availableTables.find(item => item.name === selectedDataset) || null;
  const visibleColumns = currentTable
    ? currentTable.columns.filter(col => !col.isSensitive && col.supported)
    : [];

  return (
    <section className={styles.selectorBar} aria-label="Dataset selection">
      <div className={styles.selectorRow} style={{ gridTemplateColumns: "minmax(240px, 1fr) auto" }}>
        <div className={styles.fieldGroup}>
          <label htmlFor="qp-dataset-select" className={styles.fieldLabel}>
            Select Dataset
          </label>
          <select
            id="qp-dataset-select"
            className={styles.selectInput}
            value={selectedDataset}
            disabled={loadingProfile || availableTables.length === 0}
            onChange={event => onDatasetChange(event.target.value)}
          >
            {availableTables.length === 0 ? (
              <option value="">{loadingProfile ? "Loading datasets..." : "No datasets found"}</option>
            ) : (
              availableTables.map(table => (
                <option key={table.name} value={table.name}>
                  {table.name} ({table.rowCount.toLocaleString()} rows · {table.columns.length} columns)
                </option>
              ))
            )}
          </select>
        </div>

        <button
          type="button"
          className={styles.secondaryBtn}
          disabled={loadingProfile || loadingAnalysis || !selectedDataset}
          onClick={onRefreshAll}
          aria-label="Refresh analysis for selected dataset"
        >
          <RefreshCw size={14} className={loadingProfile || loadingAnalysis ? "spinning" : ""} />
          Refresh
        </button>
      </div>

      <div className={styles.domainMetaStrip}>
        <div className={styles.metaPills}>
          <span className={`${styles.badge} ${styles.badgeInfo}`}>
            <Sparkles size={12} /> {domainMeta.name}
          </span>
          {currentTable && (
            <>
              <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                <Table2 size={11} />
                {currentTable.rowCount.toLocaleString()} rows · {visibleColumns.length} active columns
              </span>
              {currentTable.freshness.earliestDate && currentTable.freshness.latestDate && (
                <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                  <Database size={11} />
                  {currentTable.freshness.earliestDate.slice(0, 10)} to {currentTable.freshness.latestDate.slice(0, 10)}
                </span>
              )}
            </>
          )}
        </div>
        <span style={{ fontSize: 11, color: "var(--muted, #657c8a)" }}>
          All 7 tools analyze the selected dataset columns directly
        </span>
      </div>

      {visibleColumns.length > 0 && (
        <div className={styles.metaPills} aria-label="Active dataset columns">
          {visibleColumns.slice(0, 14).map(col => (
            <span key={col.name} className={`${styles.badge} ${styles.badgeNeutral}`} style={{ fontWeight: 500 }}>
              {col.name}
            </span>
          ))}
          {visibleColumns.length > 14 && (
            <span className={`${styles.badge} ${styles.badgeInfo}`}>
              +{visibleColumns.length - 14} more
            </span>
          )}
        </div>
      )}
    </section>
  );
}
