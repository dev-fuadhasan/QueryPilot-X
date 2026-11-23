"use client";

import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Play
} from "lucide-react";
import type { BusinessDomainId } from "../profiler/types";
import type { ManualQuickRange, PersistentReportRecord, PersistentReportSummary } from "../storage/types";
import {
  formatFileSize,
  formatShortTimestamp,
  getDomainUiMeta,
  MANUAL_QUICK_RANGE_OPTIONS,
  todayIsoInTimezone,
  validateManualRangeSelection
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

type ManualReportPanelProps = {
  selectedDomain: BusinessDomainId;
  selectedDataset: string;
  timezone: string;
  earliestAvailableDate: string | null;
  latestAvailableDate: string | null;
  generating: boolean;
  downloadingReportId: string | null;
  error: string | null;
  generatedReport: PersistentReportRecord | null;
  onGenerateManualReport: (input: {
    quickRange: ManualQuickRange;
    startDate?: string;
    endDate?: string;
  }) => Promise<void>;
  onDownloadPdf: (report: PersistentReportSummary | PersistentReportRecord) => Promise<void>;
};

export default function ManualReportPanel({
  selectedDomain,
  selectedDataset,
  timezone,
  earliestAvailableDate,
  latestAvailableDate,
  generating,
  downloadingReportId,
  error,
  generatedReport,
  onGenerateManualReport,
  onDownloadPdf
}: ManualReportPanelProps) {
  const [quickRange, setQuickRange] = useState<ManualQuickRange>("last_30_days");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const domainMeta = getDomainUiMeta(selectedDomain);
  const maxDate = todayIsoInTimezone(timezone);
  const liveValidation = validateManualRangeSelection({
    quickRange,
    startDate,
    endDate,
    timezone,
    earliestAvailableDate,
    latestAvailableDate
  });

  async function handleGenerate(event: React.FormEvent) {
    event.preventDefault();
    if (generating) return;
    if (!selectedDataset) {
      setValidationError("Select a connected table or view before generating a manual report.");
      return;
    }
    const check = validateManualRangeSelection({
      quickRange,
      startDate,
      endDate,
      timezone,
      earliestAvailableDate,
      latestAvailableDate
    });
    if (!check.valid) {
      setValidationError(check.error);
      return;
    }
    setValidationError(null);
    await onGenerateManualReport({
      quickRange,
      startDate: quickRange === "custom" ? startDate : undefined,
      endDate: quickRange === "custom" ? endDate : undefined
    });
  }

  return (
    <section className={styles.twoCol} aria-label="Manual Report Generation">
      {/* Left column: Quick range + custom date range form */}
      <form className={styles.card} onSubmit={handleGenerate} noValidate>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <FileSpreadsheet size={17} /> Manual Report Generation
            </h2>
            <p className={styles.cardSub}>
              Generate an on-demand report for any rolling window or custom date range. Independent of your Automatic Daily Report schedule.
            </p>
          </div>
          <span className={`${styles.badge} ${styles.badgeInfo}`}>
            {domainMeta.shortName}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Select Period</span>
            <div className={styles.quickRangeGrid} role="radiogroup" aria-label="Manual report quick range">
              {MANUAL_QUICK_RANGE_OPTIONS.map(option => {
                const active = quickRange === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`${styles.quickRangeCard} ${active ? styles.quickRangeCardActive : ""}`}
                    onClick={() => {
                      setQuickRange(option.value);
                      setValidationError(null);
                    }}
                  >
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </button>
                );
              })}
            </div>
          </div>

          {quickRange === "custom" && (
            <div className={styles.formGrid}>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-manual-start" className={styles.fieldLabel}>
                  Start Date
                </label>
                <input
                  id="qp-manual-start"
                  type="date"
                  className={styles.textInput}
                  value={startDate}
                  min={earliestAvailableDate?.slice(0, 10) || undefined}
                  max={endDate || maxDate}
                  onChange={event => {
                    setStartDate(event.target.value);
                    setValidationError(null);
                  }}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label htmlFor="qp-manual-end" className={styles.fieldLabel}>
                  End Date
                </label>
                <input
                  id="qp-manual-end"
                  type="date"
                  className={styles.textInput}
                  value={endDate}
                  min={startDate || earliestAvailableDate?.slice(0, 10) || undefined}
                  max={maxDate}
                  onChange={event => {
                    setEndDate(event.target.value);
                    setValidationError(null);
                  }}
                />
              </div>
            </div>
          )}

          <div className={styles.infoBanner}>
            <CalendarRange size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>Dataset coverage:</strong>{" "}
              {earliestAvailableDate && latestAvailableDate
                ? `${earliestAvailableDate.slice(0, 10)} to ${latestAvailableDate.slice(0, 10)} (${selectedDataset})`
                : selectedDataset
                  ? `Connected table ${selectedDataset} (date range resolved server-side)`
                  : "No table selected yet."}
            </div>
          </div>

          {liveValidation.warning && !validationError && (
            <div className={styles.warnBanner} role="status">
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{liveValidation.warning}</span>
            </div>
          )}

          {(validationError || error) && (
            <div className={styles.errorBanner} role="alert">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <AlertCircle size={15} /> {validationError || error}
              </span>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--muted, #657c8a)" }}>
              Persists to Report History &amp; renders via Stage 5 Dynamic PDF Builder.
            </span>
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={generating || !selectedDataset}
            >
              <Play size={14} />
              {generating ? "Generating Report & PDF..." : "Generate Report"}
            </button>
          </div>
        </div>
      </form>

      {/* Right column: Generated Manual Report Result */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h3 className={styles.cardTitle}>
              <FileText size={15} /> Generated Manual Report
            </h3>
            <p className={styles.cardSub}>Persisted summary and authorised PDF download for your manual run.</p>
          </div>
          {generatedReport && (
            <span
              className={`${styles.badge} ${
                generatedReport.pdfStatus === "generated"
                  ? styles.badgePositive
                  : generatedReport.pdfStatus === "failed"
                    ? styles.badgeWarning
                    : styles.badgeInfo
              }`}
            >
              {generatedReport.pdfStatus === "generated"
                ? "PDF Ready"
                : generatedReport.pdfStatus === "failed"
                  ? "PDF Failed"
                  : "Saved"}
            </span>
          )}
        </div>

        {generating ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={styles.skeletonLine} style={{ width: "55%" }} />
            <div className={styles.skeletonLine} style={{ width: "92%" }} />
            <div className={styles.skeletonLine} style={{ width: "80%" }} />
            <div className={styles.skeletonLine} style={{ width: "40%", height: 34, marginTop: 6 }} />
          </div>
        ) : generatedReport ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className={styles.successBanner}>
              <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
              <span>Report generated and stored in Report History.</span>
            </div>

            <div className={styles.kvList}>
              <div className={styles.kvRow}>
                <span>Business Domain</span>
                <strong>{generatedReport.domainName}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Dataset Table</span>
                <strong>{generatedReport.datasetTable}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Reporting Period</span>
                <strong>{generatedReport.periodStart} to {generatedReport.periodEnd}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Generated At</span>
                <strong>{formatShortTimestamp(generatedReport.generatedAt, timezone)}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>PDF Artifact</span>
                <strong>
                  {generatedReport.pdfStatus === "generated"
                    ? `Validated PDF ${generatedReport.pdfSizeBytes ? `(${formatFileSize(generatedReport.pdfSizeBytes)})` : ""}`
                    : generatedReport.pdfStatus === "failed"
                      ? "Storage failed"
                      : "Pending"}
                </strong>
              </div>
            </div>

            {generatedReport.summaryText && (
              <div className={styles.infoBanner} style={{ fontSize: 11.5 }}>
                <span>{generatedReport.summaryText}</span>
              </div>
            )}

            {generatedReport.pdfError && (
              <div className={styles.warnBanner} role="status">
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  <strong>PDF Storage Note:</strong> {generatedReport.pdfError} You can still generate an authorised on-demand PDF download below.
                </span>
              </div>
            )}

            <button
              type="button"
              className={styles.primaryBtn}
              disabled={downloadingReportId === generatedReport.id}
              onClick={() => void onDownloadPdf(generatedReport)}
            >
              <Download size={14} />
              {downloadingReportId === generatedReport.id ? "Preparing PDF..." : "Download PDF"}
            </button>
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <strong>No manual report generated in this session</strong>
            <p>
              Choose a quick range (7, 30, 90, 365 days, or All Available History) or a custom date window, then click <strong>Generate Report</strong>.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
