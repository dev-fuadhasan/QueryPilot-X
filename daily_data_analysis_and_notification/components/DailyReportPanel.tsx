"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  FilePlus2,
  FileText
} from "lucide-react";
import type { ComparisonPreset } from "../metrics/types";
import type {
  PersistentDailySettings,
  PersistentReportSummary,
  ReportFrequency,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";
import {
  COMMON_TIMEZONES,
  COMPARISON_PRESET_OPTIONS,
  DAILY_FREQUENCY_OPTIONS,
  formatFileSize,
  formatShortTimestamp,
  isReportPdfDownloadable,
  resolveAutoReportDisplayState,
  validateScheduleFormInput
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

export type UnifiedPdfGenerateRequest = {
  comparisonPreset: ComparisonPreset;
  startDate?: string;
  endDate?: string;
};

type DailyReportPanelProps = {
  settings: PersistentDailySettings | null;
  selectedDataset: string;
  storageStatus: StorageCapabilityStatus | null;
  scheduleSummary: ScheduleRuntimeSummary | null;
  latestStoredReport?: PersistentReportSummary | null;
  earliestAvailableDate?: string | null;
  latestAvailableDate?: string | null;
  defaultComparisonPreset?: ComparisonPreset;
  loadingSettings: boolean;
  savingSchedule: boolean;
  generatingPdf?: boolean;
  pdfGenerateError?: string | null;
  pdfGenerateNotice?: string | null;
  downloadingReportId: string | null;
  saveFeedback: { type: "success" | "error"; text: string } | null;
  onSaveSchedule: (payload: {
    autoReportEnabled: boolean;
    frequency: ReportFrequency;
    scheduledTime: string;
    timezone: string;
  }) => Promise<void>;
  onGeneratePdf?: (payload: UnifiedPdfGenerateRequest) => Promise<void>;
  onDownloadPdf: (report: PersistentReportSummary) => Promise<void>;
};

export default function DailyReportPanel({
  settings,
  selectedDataset,
  storageStatus,
  scheduleSummary,
  latestStoredReport,
  defaultComparisonPreset = "previous_30_days",
  loadingSettings,
  savingSchedule,
  generatingPdf = false,
  pdfGenerateError = null,
  pdfGenerateNotice = null,
  downloadingReportId,
  saveFeedback,
  onSaveSchedule,
  onGeneratePdf,
  onDownloadPdf
}: DailyReportPanelProps) {
  const [frequency, setFrequency] = useState<ReportFrequency>(settings?.frequency || "daily");
  const [scheduledTime, setScheduledTime] = useState<string>(settings?.scheduledTime || "00:15");
  const [timezone, setTimezone] = useState<string>(settings?.timezone || "Asia/Dhaka");
  const [autoReportEnabled, setAutoReportEnabled] = useState<boolean>(settings?.autoReportEnabled ?? true);
  const [referencePreset, setReferencePreset] = useState<ComparisonPreset>(defaultComparisonPreset);
  const [manualStartDate, setManualStartDate] = useState<string>("");
  const [manualEndDate, setManualEndDate] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [manualDateError, setManualDateError] = useState<string | null>(null);

  const timeSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!settings) return;
    setFrequency(settings.frequency || "daily");
    setScheduledTime(settings.scheduledTime || "00:15");
    setTimezone(settings.timezone || "Asia/Dhaka");
    setAutoReportEnabled(settings.autoReportEnabled);
  }, [settings]);

  useEffect(() => {
    return () => {
      if (timeSaveTimerRef.current !== null) {
        window.clearTimeout(timeSaveTimerRef.current);
      }
    };
  }, []);

  const latestAuto = scheduleSummary?.latestAutomaticReport || null;
  const latestReport = latestStoredReport || latestAuto;
  const displayState = resolveAutoReportDisplayState({
    autoReportEnabled,
    saving: savingSchedule,
    storageStatus,
    scheduleSummary,
    latestReport: latestAuto
  });

  const badgeToneClass =
    displayState.tone === "positive"
      ? styles.badgePositive
      : displayState.tone === "info"
        ? styles.badgeInfo
        : displayState.tone === "warning"
          ? styles.badgeWarning
          : displayState.tone === "critical"
            ? styles.badgeCritical
            : styles.badgeNeutral;

  const cloudStorageReady = Boolean(storageStatus?.pdfProductionReady);
  const timezoneOptions = COMMON_TIMEZONES.includes(timezone)
    ? COMMON_TIMEZONES
    : [timezone, ...COMMON_TIMEZONES];

  function persistScheduleChange(next: {
    autoReportEnabled: boolean;
    frequency: ReportFrequency;
    scheduledTime: string;
    timezone: string;
  }) {
    const check = validateScheduleFormInput({
      frequency: next.frequency,
      scheduledTime: next.scheduledTime,
      timezone: next.timezone,
      selectedDataset: selectedDataset || settings?.selectedDataset || null,
      autoReportEnabled: next.autoReportEnabled
    });
    if (!check.valid) {
      setValidationError(check.error);
      return;
    }
    setValidationError(null);
    void onSaveSchedule(next);
  }

  function handleToggleAutoReport(checked: boolean) {
    setAutoReportEnabled(checked);
    persistScheduleChange({
      autoReportEnabled: checked,
      frequency,
      scheduledTime,
      timezone
    });
  }

  function handleSelectFrequency(nextFrequency: ReportFrequency) {
    setFrequency(nextFrequency);
    persistScheduleChange({
      autoReportEnabled,
      frequency: nextFrequency,
      scheduledTime,
      timezone
    });
  }

  function handleChangeTime(nextTime: string) {
    setScheduledTime(nextTime);
    setValidationError(null);
    if (timeSaveTimerRef.current !== null) {
      window.clearTimeout(timeSaveTimerRef.current);
    }
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(nextTime)) {
      timeSaveTimerRef.current = window.setTimeout(() => {
        persistScheduleChange({
          autoReportEnabled,
          frequency,
          scheduledTime: nextTime,
          timezone
        });
      }, 450);
    }
  }

  function handleChangeTimezone(nextTimezone: string) {
    setTimezone(nextTimezone);
    persistScheduleChange({
      autoReportEnabled,
      frequency,
      scheduledTime,
      timezone: nextTimezone
    });
  }

  async function handleGeneratePdfClick() {
    if (!onGeneratePdf || generatingPdf || !selectedDataset) return;
    const start = manualStartDate.trim();
    const end = manualEndDate.trim();

    if (start || end) {
      if (!start || !end) {
        setManualDateError("Select both a Start Date and an End Date.");
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        setManualDateError("Dates must use YYYY-MM-DD format.");
        return;
      }
      if (start > end) {
        setManualDateError("Start Date cannot be after End Date.");
        return;
      }
      setManualDateError(null);
      await onGeneratePdf({
        comparisonPreset: referencePreset,
        startDate: start,
        endDate: end
      });
      return;
    }

    setManualDateError(null);
    await onGeneratePdf({ comparisonPreset: referencePreset });
  }

  const hasManualDates = Boolean(manualStartDate.trim() || manualEndDate.trim());

  return (
    <section className={styles.twoCol} aria-label="Report Automation">
      {/* Left column: Unified Report Automation (Schedule + Reference Period & Manual Date PDF Generator) */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <CalendarClock size={17} /> Report Automation
            </h2>
          </div>
          <span className={`${styles.badge} ${badgeToneClass}`} role="status">
            {displayState.label}
          </span>
        </div>

        {loadingSettings ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={styles.skeletonLine} style={{ width: "60%" }} />
            <div className={styles.skeletonLine} style={{ width: "90%" }} />
            <div className={styles.skeletonLine} style={{ width: "75%" }} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className={styles.toggleRow}>
              <div className={styles.toggleLabel}>
                <strong>Automatic Report Generation</strong>
                <small>
                  {autoReportEnabled
                    ? cloudStorageReady
                      ? "Active — generates automatically at the scheduled time and stores PDFs in Cloud Storage."
                      : "Active — generates automatically at the scheduled time (temporary storage active; auto-switches to Cloud when configured)."
                    : "Paused — automatic scheduled PDF generation is currently turned off."}
                </small>
              </div>
              <input
                type="checkbox"
                className={styles.toggleCheckbox}
                aria-label="Enable automatic report generation"
                checked={autoReportEnabled}
                onChange={event => handleToggleAutoReport(event.target.checked)}
              />
            </div>

            <div className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Report Frequency</span>
              <div className={styles.segmentedGroup} role="radiogroup" aria-label="Report frequency">
                {DAILY_FREQUENCY_OPTIONS.map(option => {
                  const active = frequency === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`${styles.segmentedBtn} ${active ? styles.segmentedBtnActive : ""}`}
                      onClick={() => handleSelectFrequency(option.value)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={styles.formGrid}>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-schedule-time" className={styles.fieldLabel}>
                  Generation Time (24-Hour)
                </label>
                <input
                  id="qp-schedule-time"
                  type="time"
                  className={styles.textInput}
                  value={scheduledTime}
                  onChange={event => handleChangeTime(event.target.value)}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label htmlFor="qp-schedule-timezone" className={styles.fieldLabel}>
                  Timezone (Default: Asia/Dhaka)
                </label>
                <select
                  id="qp-schedule-timezone"
                  className={styles.selectInput}
                  value={timezone}
                  onChange={event => handleChangeTimezone(event.target.value)}
                >
                  {timezoneOptions.map(tz => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: "var(--muted, #657c8a)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Clock size={12} /> Timezone: <strong>{timezone}</strong>
                {scheduleSummary?.nextExecution && (
                  <>
                    {" · "}Next run: <strong>{scheduleSummary.nextExecution.nextNominalRunDate} {scheduleSummary.nextExecution.nextNominalRunTime}</strong>
                  </>
                )}
              </span>
              <span style={{ fontSize: 11 }}>
                {savingSchedule
                  ? "Saving schedule..."
                  : cloudStorageReady
                    ? "Cloud PDF Storage Active"
                    : "Temporary Local Storage"}
              </span>
            </div>

            {validationError && (
              <div className={styles.errorBanner} role="alert">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle size={15} /> {validationError}
                </span>
              </div>
            )}

            {saveFeedback && (
              <div
                className={saveFeedback.type === "success" ? styles.successBanner : styles.errorBanner}
                role={saveFeedback.type === "error" ? "alert" : "status"}
              >
                {saveFeedback.type === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                <span>{saveFeedback.text}</span>
              </div>
            )}

            {/* Integrated PDF Generation: Reference Period (Smart Comparison options) + Manual Date Selection */}
            {onGeneratePdf && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 14, borderTop: "1px solid #e6eeec" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#153243" }}>
                    Generate PDF Report
                  </span>
                  {hasManualDates && (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() => {
                        setManualStartDate("");
                        setManualEndDate("");
                        setManualDateError(null);
                      }}
                    >
                      Clear Manual Dates
                    </button>
                  )}
                </div>

                <div className={styles.formGrid}>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="qp-pdf-reference-period" className={styles.fieldLabel}>
                      Reference Period
                    </label>
                    <select
                      id="qp-pdf-reference-period"
                      className={styles.selectInput}
                      value={referencePreset}
                      disabled={generatingPdf}
                      onChange={event => {
                        const nextPreset = event.target.value as ComparisonPreset;
                        setReferencePreset(nextPreset);
                        if (nextPreset === "none" && hasManualDates) {
                          setManualStartDate("");
                          setManualEndDate("");
                          setManualDateError(null);
                        }
                      }}
                    >
                      {COMPARISON_PRESET_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={styles.fieldGroup}>
                    <span className={styles.fieldLabel}>Manual Date Range (Optional)</span>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <input
                        id="qp-pdf-manual-start"
                        type="date"
                        aria-label="Manual PDF start date"
                        className={styles.textInput}
                        value={manualStartDate}
                        disabled={generatingPdf}
                        onChange={event => {
                          setManualStartDate(event.target.value);
                          setManualDateError(null);
                        }}
                      />
                      <input
                        id="qp-pdf-manual-end"
                        type="date"
                        aria-label="Manual PDF end date"
                        className={styles.textInput}
                        value={manualEndDate}
                        disabled={generatingPdf}
                        onChange={event => {
                          setManualEndDate(event.target.value);
                          setManualDateError(null);
                        }}
                      />
                    </div>
                  </div>
                </div>

                {manualDateError && (
                  <div className={styles.errorBanner} role="alert">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <AlertCircle size={14} /> {manualDateError}
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11.5, color: "var(--muted, #657c8a)" }}>
                    {manualStartDate && manualEndDate
                      ? `Custom range selected: ${manualStartDate} to ${manualEndDate}`
                      : `Using Reference Period: ${COMPARISON_PRESET_OPTIONS.find(o => o.value === referencePreset)?.label || referencePreset}`}
                  </span>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={generatingPdf || !selectedDataset}
                    onClick={() => void handleGeneratePdfClick()}
                  >
                    <FilePlus2 size={14} />
                    {generatingPdf ? "Generating PDF..." : "Generate & Save PDF"}
                  </button>
                </div>

                {pdfGenerateError && (
                  <div className={styles.errorBanner} role="alert">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <AlertCircle size={14} /> {pdfGenerateError}
                    </span>
                  </div>
                )}

                {pdfGenerateNotice && (
                  <div className={styles.successBanner} role="status">
                    <CheckCircle2 size={14} />
                    <span>{pdfGenerateNotice}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right column: Latest Stored PDF Report */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h3 className={styles.cardTitle}>
              <FileText size={15} /> Latest Stored PDF Report
            </h3>
            <p className={styles.cardSub}>Most recent automatic or manual PDF saved in your archive.</p>
          </div>
        </div>

        {latestReport ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className={styles.kvList}>
              <div className={styles.kvRow}>
                <span>Reporting Period</span>
                <strong>{latestReport.periodStart} to {latestReport.periodEnd}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Report Type</span>
                <strong style={{ textTransform: "capitalize" }}>
                  {latestReport.generationType} · {latestReport.frequency}
                </strong>
              </div>
              <div className={styles.kvRow}>
                <span>Generated At</span>
                <strong>{formatShortTimestamp(latestReport.generatedAt, timezone)}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Domain &amp; Dataset</span>
                <strong>{latestReport.domainName} · {latestReport.datasetTable}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>PDF Status</span>
                <strong>
                  {latestReport.pdfStatus === "generated"
                    ? `Stored ${latestReport.pdfSizeBytes ? `(${formatFileSize(latestReport.pdfSizeBytes)})` : ""}`
                    : latestReport.pdfStatus === "failed"
                      ? "PDF storage failed"
                      : "Not generated yet"}
                </strong>
              </div>
            </div>

            {(latestReport.errorMessage || latestReport.pdfError) && (
              <div className={styles.errorBanner} role="alert">
                <span>{latestReport.errorMessage || latestReport.pdfError}</span>
              </div>
            )}

            {isReportPdfDownloadable(latestReport) ? (
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={downloadingReportId === latestReport.id}
                onClick={() => void onDownloadPdf(latestReport)}
              >
                <Download size={14} />
                {downloadingReportId === latestReport.id
                  ? "Preparing PDF..."
                  : "Download Latest PDF"}
              </button>
            ) : (
              <div className={styles.warnBanner} role="status">
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  PDF download is unavailable until a verified PDF artifact is stored for this report.
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <strong>No stored PDF report yet</strong>
            <p>
              Select a Reference Period or Manual Date Range in Report Automation and click &ldquo;Generate &amp; Save PDF&rdquo;, or wait for your scheduled automatic report.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
