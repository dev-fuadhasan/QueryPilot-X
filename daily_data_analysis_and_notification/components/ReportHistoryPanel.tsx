"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  GitCompare,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { BusinessDomainId } from "../profiler/types";
import type { ReportArchiveComparisonResult } from "../intelligence/types";
import type {
  PersistentReportRecord,
  PersistentReportStatusFilter,
  PersistentReportSummary,
  ReportFrequencyOrManual,
  ReportHistoryStorageState,
  StorageCapabilityStatus
} from "../storage/types";
import {
  canCompareArchivedReports,
  DEFAULT_REPORT_HISTORY_FILTERS,
  DOMAIN_UI_CATALOG,
  formatFileSize,
  formatShortTimestamp,
  formatSignedPercent,
  isReportPdfDownloadable,
  type ReportHistoryFilterState
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

export type ReportHistoryPagination = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  appliedStartDate: string | null;
  appliedEndDate: string | null;
};

type ReportHistoryPanelProps = {
  reports: PersistentReportSummary[];
  pagination: ReportHistoryPagination;
  filters: ReportHistoryFilterState;
  loading: boolean;
  storageState?: ReportHistoryStorageState;
  storageStatus?: StorageCapabilityStatus | null;
  error: string | null;
  warning: string | null;
  timezone: string;
  downloadingReportId: string | null;
  comparison: ReportArchiveComparisonResult | null;
  comparing: boolean;
  compareError: string | null;
  inspectedReport: PersistentReportRecord | null;
  loadingInspect: boolean;
  onFiltersChange: (next: ReportHistoryFilterState) => void;
  onRefresh: () => void;
  onInspectReport: (reportId: string) => Promise<void>;
  onCloseInspect: () => void;
  onCompareReports: (leftId: string, rightId: string) => Promise<void>;
  onClearComparison: () => void;
  onDownloadPdf: (report: PersistentReportSummary, compareWithId?: string) => Promise<void>;
};

export default function ReportHistoryPanel({
  reports,
  pagination,
  filters,
  loading,
  storageState = "ready",
  storageStatus = null,
  error,
  warning,
  timezone,
  downloadingReportId,
  comparison,
  comparing,
  compareError,
  inspectedReport,
  loadingInspect,
  onFiltersChange,
  onRefresh,
  onInspectReport,
  onCloseInspect,
  onCompareReports,
  onClearComparison,
  onDownloadPdf
}: ReportHistoryPanelProps) {
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");

  const comparableReports = useMemo(
    () => reports.filter(r => r.status === "generated"),
    [reports]
  );

  const selectedLeft = useMemo(
    () => comparableReports.find(r => r.id === leftId) || comparableReports[1] || null,
    [comparableReports, leftId]
  );
  const selectedRight = useMemo(
    () => comparableReports.find(r => r.id === rightId) || comparableReports[0] || null,
    [comparableReports, rightId]
  );

  const compareCheck = canCompareArchivedReports(selectedLeft, selectedRight);

  const comparisonChartData = useMemo(() => {
    if (!comparison || !comparison.compatible) return [];
    return comparison.metrics
      .filter(m => m.leftValue !== null && m.rightValue !== null && m.format !== "percentage" && m.format !== "ratio")
      .slice(0, 6)
      .map(m => ({
        name: m.name.length > 18 ? `${m.name.slice(0, 17)}…` : m.name,
        Baseline: Number(m.leftValue?.toFixed(2) ?? 0),
        Target: Number(m.rightValue?.toFixed(2) ?? 0)
      }));
  }, [comparison]);

  function updateFilter<K extends keyof ReportHistoryFilterState>(key: K, value: ReportHistoryFilterState[K]) {
    onFiltersChange({ ...filters, [key]: value, page: key === "page" ? (value as number) : 1 });
  }

  function handleSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    onFiltersChange({ ...filters, search: searchDraft.trim(), page: 1 });
  }

  function handleToggleComparePick(report: PersistentReportSummary) {
    if (report.status === "failed") return;
    if (leftId === report.id) {
      setLeftId("");
      return;
    }
    if (rightId === report.id) {
      setRightId("");
      return;
    }
    if (!leftId) setLeftId(report.id);
    else setRightId(report.id);
  }

  const rangeStartItem = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const rangeEndItem = Math.min(pagination.total, pagination.page * pagination.pageSize);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }} aria-label="Report History and Archived Comparison">
      {/* Filter & Search Card */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <Archive size={17} /> Report History
              <span className={`${styles.badge} ${styles.badgeInfo}`}>{pagination.total} persisted</span>
            </h2>
            <p className={styles.cardSub}>
              All Daily, Weekly, Monthly, and Manual reports persisted for your authenticated organisation. PDF downloads are strictly authorised and enabled only when a verified PDF exists.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => {
                setSearchDraft("");
                onFiltersChange(DEFAULT_REPORT_HISTORY_FILTERS);
              }}
            >
              Reset Filters
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw size={13} className={loading ? "spinning" : ""} /> Refresh
            </button>
          </div>
        </div>

        <form onSubmit={handleSearchSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className={styles.historyFilterBar}>
            <div className={styles.fieldGroup}>
              <label htmlFor="qp-hist-search" className={styles.fieldLabel}>Search Reports</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  id="qp-hist-search"
                  type="search"
                  className={styles.textInput}
                  placeholder="Summary, table, domain, date, or ID..."
                  value={searchDraft}
                  onChange={e => setSearchDraft(e.target.value)}
                />
                <button type="submit" className={styles.secondaryBtn} aria-label="Apply search">
                  <Search size={14} />
                </button>
              </div>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="qp-hist-freq" className={styles.fieldLabel}>Report Type</label>
              <select
                id="qp-hist-freq"
                className={styles.selectInput}
                value={filters.frequency}
                onChange={e => updateFilter("frequency", e.target.value as "" | ReportFrequencyOrManual)}
              >
                <option value="">All Types</option>
                <option value="daily">Daily (Automatic)</option>
                <option value="weekly">Weekly (Automatic)</option>
                <option value="monthly">Monthly (Automatic)</option>
                <option value="manual">Manual</option>
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="qp-hist-domain" className={styles.fieldLabel}>Business Domain</label>
              <select
                id="qp-hist-domain"
                className={styles.selectInput}
                value={filters.domainId}
                onChange={e => updateFilter("domainId", e.target.value as "" | BusinessDomainId)}
              >
                <option value="">All 7 Domains</option>
                {DOMAIN_UI_CATALOG.map(domain => (
                  <option key={domain.id} value={domain.id}>{domain.name}</option>
                ))}
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="qp-hist-status" className={styles.fieldLabel}>Status</label>
              <select
                id="qp-hist-status"
                className={styles.selectInput}
                value={filters.status}
                onChange={e => updateFilter("status", e.target.value as "" | PersistentReportStatusFilter)}
              >
                <option value="">All Statuses</option>
                <option value="generated">Generated</option>
                <option value="pending">Pending PDF</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="qp-hist-pagesize" className={styles.fieldLabel}>Per Page</label>
              <select
                id="qp-hist-pagesize"
                className={styles.selectInput}
                value={filters.pageSize}
                onChange={e => updateFilter("pageSize", Number(e.target.value))}
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>

          <div className={styles.historyDateRow}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className={styles.fieldGroup} style={{ width: 155 }}>
                <label htmlFor="qp-hist-from" className={styles.fieldLabel}>From Date</label>
                <input
                  id="qp-hist-from"
                  type="date"
                  className={styles.textInput}
                  value={filters.startDate}
                  onChange={e => updateFilter("startDate", e.target.value)}
                />
              </div>
              <div className={styles.fieldGroup} style={{ width: 155 }}>
                <label htmlFor="qp-hist-to" className={styles.fieldLabel}>To Date</label>
                <input
                  id="qp-hist-to"
                  type="date"
                  className={styles.textInput}
                  value={filters.endDate}
                  onChange={e => updateFilter("endDate", e.target.value)}
                />
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5, paddingBottom: 9, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={filters.includeAllDates}
                  onChange={e => updateFilter("includeAllDates", e.target.checked)}
                />
                Include older than 30 days
              </label>
            </div>

            {pagination.appliedStartDate && (
              <span style={{ fontSize: 11, color: "var(--muted, #657c8a)" }}>
                Window: {pagination.appliedStartDate} to {pagination.appliedEndDate || "today"}
              </span>
            )}
          </div>
        </form>

        {warning && (
          <div className={styles.warnBanner} style={{ marginTop: 12 }} role="status">
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{warning}</span>
          </div>
        )}

        {error && (
          <div className={styles.errorBanner} style={{ marginTop: 12 }} role="alert">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={15} /> {error}
            </span>
          </div>
        )}
      </div>

      {/* Report List Table */}
      <div className={styles.card}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={styles.skeletonLine} style={{ width: "50%" }} />
            <div className={styles.skeletonLine} style={{ width: "95%" }} />
            <div className={styles.skeletonLine} style={{ width: "88%" }} />
          </div>
        ) : reports.length > 0 ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Compare</th>
                    <th>Reporting Period</th>
                    <th>Type &amp; Frequency</th>
                    <th>Domain &amp; Dataset</th>
                    <th>Status</th>
                    <th>PDF Availability</th>
                    <th className={styles.numCell}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map(rep => {
                    const downloadable = isReportPdfDownloadable(rep);
                    const pickedAsLeft = selectedLeft?.id === rep.id && leftId === rep.id;
                    const pickedAsRight = selectedRight?.id === rep.id && rightId === rep.id;
                    return (
                      <tr key={rep.id}>
                        <td>
                          <button
                            type="button"
                            className={pickedAsLeft || pickedAsRight ? styles.primaryBtn : styles.ghostBtn}
                            style={{ padding: "4px 8px", fontSize: 10.5 }}
                            disabled={rep.status === "failed"}
                            onClick={() => handleToggleComparePick(rep)}
                            title="Select report for side-by-side comparison"
                          >
                            {pickedAsLeft ? "Baseline" : pickedAsRight ? "Target" : "Select"}
                          </button>
                        </td>
                        <td>
                          <strong>{rep.periodStart} to {rep.periodEnd}</strong>
                          <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)", display: "flex", alignItems: "center", gap: 4 }}>
                            <Clock size={10} /> {formatShortTimestamp(rep.generatedAt, timezone)}
                          </div>
                        </td>
                        <td>
                          <span className={`${styles.badge} ${rep.generationType === "automatic" ? styles.badgeInfo : styles.badgeNeutral}`}>
                            {rep.generationType} · {rep.frequency}
                          </span>
                        </td>
                        <td>
                          <strong>{rep.domainName}</strong>
                          <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>
                            <code>{rep.datasetTable}</code>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`${styles.badge} ${
                              rep.status === "failed"
                                ? styles.badgeCritical
                                : rep.pdfStatus === "not_generated"
                                  ? styles.badgeWarning
                                  : styles.badgePositive
                            }`}
                          >
                            {rep.status === "failed"
                              ? "Failed"
                              : rep.pdfStatus === "not_generated"
                                ? "Pending PDF"
                                : "Generated"}
                          </span>
                        </td>
                        <td>
                          {downloadable ? (
                            <span className={`${styles.badge} ${styles.badgePositive}`}>
                              <CheckCircle2 size={11} /> Ready {rep.pdfSizeBytes ? `(${formatFileSize(rep.pdfSizeBytes)})` : ""}
                            </span>
                          ) : rep.pdfStatus === "failed" ? (
                            <span className={`${styles.badge} ${styles.badgeWarning}`} title={rep.pdfError || "PDF storage failed"}>
                              PDF Failed
                            </span>
                          ) : (
                            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                              Unavailable
                            </span>
                          )}
                        </td>
                        <td className={styles.numCell}>
                          <div style={{ display: "inline-flex", gap: 6, justifyContent: "flex-end" }}>
                            <button
                              type="button"
                              className={styles.ghostBtn}
                              disabled={loadingInspect}
                              onClick={() => void onInspectReport(rep.id)}
                              title="Inspect persisted report details"
                            >
                              <Eye size={13} /> View
                            </button>
                            {downloadable ? (
                              <button
                                type="button"
                                className={styles.secondaryBtn}
                                disabled={downloadingReportId === rep.id}
                                onClick={() => void onDownloadPdf(rep)}
                              >
                                <Download size={13} />
                                {downloadingReportId === rep.id ? "..." : "PDF"}
                              </button>
                            ) : (
                              <span style={{ fontSize: 10.5, color: "var(--muted, #657c8a)", alignSelf: "center", padding: "0 4px" }}>
                                No PDF
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Bar */}
            <div className={styles.paginationBar}>
              <span>
                Showing <strong>{rangeStartItem}–{rangeEndItem}</strong> of <strong>{pagination.total}</strong> report(s) · Page <strong>{pagination.page}</strong> of <strong>{pagination.totalPages}</strong>
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={pagination.page <= 1 || loading}
                  onClick={() => updateFilter("page", pagination.page - 1)}
                >
                  <ChevronLeft size={14} /> Previous
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={pagination.page >= pagination.totalPages || loading}
                  onClick={() => updateFilter("page", pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        ) : storageState === "storage_unavailable" ? (
          <div className={styles.warnBanner} role="status" style={{ flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={16} />
              <strong>Persistent Report Storage Is Not Configured</strong>
            </div>
            <div>
              {error || warning || "Application-owned persistent report storage is unavailable in this environment (local SQLite is restricted to development mode)."}
            </div>
            {storageStatus && storageStatus.missingProductionConfig.length > 0 && (
              <div style={{ fontSize: 11 }}>
                <strong>Required production environment variables:</strong>{" "}
                <code>{storageStatus.missingProductionConfig.join(", ")}</code>
              </div>
            )}
          </div>
        ) : storageState === "error" ? (
          <div className={styles.errorBanner} role="alert" style={{ flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={16} />
              <strong>Failed to Retrieve Report History</strong>
            </div>
            <div>{error || "An unexpected storage or API error occurred while loading persisted reports."}</div>
            <button type="button" className={styles.secondaryBtn} onClick={onRefresh} style={{ alignSelf: "flex-start" }}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        ) : storageState === "empty_filtered" ? (
          <div className={styles.emptyBox}>
            <strong>No reports match your active filters</strong>
            <p>
              Persisted reports exist for your organisation, but none matched your current search term, date window, domain, or status filter.
            </p>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                setSearchDraft("");
                onFiltersChange(DEFAULT_REPORT_HISTORY_FILTERS);
              }}
            >
              Reset All Filters
            </button>
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <strong>No reports have been generated yet</strong>
            <p>
              Persistent report storage is ready, and no reports exist for your organisation yet. Generate one from <strong>Manual Report</strong> or configure <strong>Daily Report</strong> automation.
            </p>
          </div>
        )}

        {/* Inspected Report Detail Drawer */}
        {inspectedReport && (
          <div className={styles.detailBox} style={{ marginTop: 14 }} aria-label="Inspected report details">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <strong style={{ fontSize: 13 }}>
                Persisted Report Details · {inspectedReport.periodStart} to {inspectedReport.periodEnd}
              </strong>
              <button type="button" className={styles.ghostBtn} onClick={onCloseInspect} aria-label="Close report details">
                <X size={14} /> Close
              </button>
            </div>
            <div className={styles.kvList}>
              <div className={styles.kvRow}><span>Report ID</span><strong><code>{inspectedReport.id}</code></strong></div>
              <div className={styles.kvRow}><span>Domain &amp; Dataset</span><strong>{inspectedReport.domainName} · {inspectedReport.datasetTable}</strong></div>
              <div className={styles.kvRow}><span>Type / Frequency</span><strong>{inspectedReport.generationType} · {inspectedReport.frequency}</strong></div>
              <div className={styles.kvRow}><span>Comparison Window</span><strong>{inspectedReport.comparisonStart && inspectedReport.comparisonEnd ? `${inspectedReport.comparisonStart} to ${inspectedReport.comparisonEnd}` : "None"}</strong></div>
              <div className={styles.kvRow}><span>Generated At</span><strong>{formatShortTimestamp(inspectedReport.generatedAt, timezone)}</strong></div>
            </div>
            {inspectedReport.summaryText && (
              <div className={styles.infoBanner} style={{ fontSize: 11.5 }}>
                <span>{inspectedReport.summaryText}</span>
              </div>
            )}
            {(inspectedReport.errorMessage || inspectedReport.pdfError) && (
              <div className={styles.errorBanner} role="alert">
                <span>{inspectedReport.errorMessage || inspectedReport.pdfError}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Archived Report Comparison Studio */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h3 className={styles.cardTitle}>
              <GitCompare size={16} /> Archived Report Comparison
            </h3>
            <p className={styles.cardSub}>
              Compare any two persisted reports from your organisation side-by-side and export an authorised comparison PDF via Stage 5&apos;s dynamic PDF builder.
            </p>
          </div>
          {comparison && (
            <button type="button" className={styles.ghostBtn} onClick={onClearComparison}>
              Clear Result
            </button>
          )}
        </div>

        {comparableReports.length >= 2 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className={styles.formGrid}>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-cmp-left" className={styles.fieldLabel}>Baseline Report (Left)</label>
                <select
                  id="qp-cmp-left"
                  className={styles.selectInput}
                  value={selectedLeft?.id || ""}
                  onChange={e => setLeftId(e.target.value)}
                >
                  {comparableReports.map(rep => (
                    <option key={rep.id} value={rep.id}>
                      {rep.periodStart}..{rep.periodEnd} · {rep.domainName} ({rep.frequency})
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-cmp-right" className={styles.fieldLabel}>Target Report (Right)</label>
                <select
                  id="qp-cmp-right"
                  className={styles.selectInput}
                  value={selectedRight?.id || ""}
                  onChange={e => setRightId(e.target.value)}
                >
                  {comparableReports.map(rep => (
                    <option key={rep.id} value={rep.id}>
                      {rep.periodStart}..{rep.periodEnd} · {rep.domainName} ({rep.frequency})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {!compareCheck.allowed && compareCheck.reason && (
              <div className={styles.warnBanner}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{compareCheck.reason}</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={comparing || !compareCheck.allowed || !selectedLeft || !selectedRight}
                onClick={() => {
                  if (selectedLeft && selectedRight) {
                    void onCompareReports(selectedLeft.id, selectedRight.id);
                  }
                }}
              >
                <GitCompare size={14} />
                {comparing ? "Comparing Reports..." : "Compare Reports"}
              </button>

              {selectedLeft && selectedRight && compareCheck.allowed && (
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={downloadingReportId === selectedRight.id}
                  onClick={() => void onDownloadPdf(selectedRight, selectedLeft.id)}
                >
                  <Download size={14} />
                  {downloadingReportId === selectedRight.id ? "Generating PDF..." : "Download Comparison PDF"}
                </button>
              )}
            </div>

            {compareError && (
              <div className={styles.errorBanner} role="alert">
                <span>{compareError}</span>
              </div>
            )}

            {comparison && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className={styles.compareHeaderGrid}>
                  <div className={styles.compareSlot}>
                    <span className={styles.fieldLabel}>Baseline Report</span>
                    <strong>{comparison.leftReport.periodStart} to {comparison.leftReport.periodEnd}</strong>
                    <small style={{ color: "var(--muted, #657c8a)" }}>
                      {comparison.leftReport.domainName} · <code>{comparison.leftReport.tableName}</code>
                    </small>
                  </div>
                  <div className={styles.compareSlot}>
                    <span className={styles.fieldLabel}>Target Report</span>
                    <strong>{comparison.rightReport.periodStart} to {comparison.rightReport.periodEnd}</strong>
                    <small style={{ color: "var(--muted, #657c8a)" }}>
                      {comparison.rightReport.domainName} · <code>{comparison.rightReport.tableName}</code>
                    </small>
                  </div>
                </div>

                <div className={comparison.compatible ? styles.infoBanner : styles.warnBanner}>
                  {comparison.compatible ? <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />}
                  <div>
                    <strong>{comparison.compatible ? "Compatible Comparison" : "Reports Are Not Directly Comparable"}</strong>
                    <div style={{ marginTop: 3 }}>
                      {comparison.incompatibilityReason || comparison.summary}
                    </div>
                    {comparison.compatibilityWarnings.length > 0 && (
                      <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 11 }}>
                        {comparison.compatibilityWarnings.map((w, idx) => <li key={idx}>{w}</li>)}
                      </ul>
                    )}
                  </div>
                </div>

                {comparison.compatible && comparison.metrics.length > 0 && (
                  <>
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Metric</th>
                            <th className={styles.numCell}>Baseline</th>
                            <th className={styles.numCell}>Target</th>
                            <th className={styles.numCell}>Absolute Delta</th>
                            <th className={styles.numCell}>% Change</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comparison.metrics.map(m => (
                            <tr key={m.metricId}>
                              <td><strong>{m.name}</strong></td>
                              <td className={styles.numCell}>{m.formattedLeftValue ?? "Unavailable"}</td>
                              <td className={styles.numCell}>{m.formattedRightValue ?? "Unavailable"}</td>
                              <td className={styles.numCell}>
                                {m.absoluteDelta !== null
                                  ? `${m.absoluteDelta >= 0 ? "+" : ""}${m.absoluteDelta.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                  : "N/A"}
                              </td>
                              <td className={styles.numCell}>{formatSignedPercent(m.changePercent)}</td>
                              <td>
                                <span
                                  className={`${styles.badge} ${
                                    m.status === "compared"
                                      ? styles.badgePositive
                                      : m.status === "both_unavailable"
                                        ? styles.badgeNeutral
                                        : styles.badgeWarning
                                  }`}
                                >
                                  {m.status.replace(/_/g, " ")}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {comparisonChartData.length > 0 && (
                      <div className={styles.chartBox} aria-label="Archived report comparison bar chart">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={comparisonChartData} margin={{ top: 10, right: 16, left: 4, bottom: 6 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e4ecec" />
                            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#546472" }} />
                            <YAxis tick={{ fontSize: 11, fill: "#546472" }} />
                            <Tooltip />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            <Bar dataKey="Baseline" fill="#5B91A3" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="Target" fill="#2F4A63" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <strong>At least two generated reports are required to compare</strong>
            <p>Generate two reports (automatic or manual) in your organisation to unlock side-by-side KPI comparison and comparison PDF export.</p>
          </div>
        )}
      </div>
    </section>
  );
}
