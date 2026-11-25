"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Cloud,
  Download,
  FilePlus2,
  FileText,
  Info,
  Save
} from "lucide-react";
import type {
  ManualQuickRange,
  PersistentDailySettings,
  PersistentReportSummary,
  ReportFrequency,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";
import {
  COMMON_TIMEZONES,
  DAILY_FREQUENCY_OPTIONS,
  formatFileSize,
  formatShortTimestamp,
  getFrequencyOption,
  isReportPdfDownloadable,
  resolveAutoReportDisplayState,
  validateScheduleFormInput
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

const QUICK_EXPORT_RANGES: Array<{ value: Exclude<ManualQuickRange, "custom">; label: string }> = [
  { value: "last_7_days", label: "Last 7 Days" },
  { value: "last_30_days", label: "Last 30 Days" },
  { value: "last_90_days", label: "Last 90 Days" },
  { value: "last_365_days", label: "Last 365 Days" },
  { value: "all_history", label: "All Available History" }
];

type DailyReportPanelProps = {
  settings: PersistentDailySettings | null;
  selectedDataset: string;
  storageStatus: StorageCapabilityStatus | null;
  scheduleSummary: ScheduleRuntimeSummary | null;
  latestStoredReport?: PersistentReportSummary | null;
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
  onGenerateQuickPdf?: (quickRange: Exclude<ManualQuickRange, "custom">) => Promise<void>;
  onDownloadPdf: (report: PersistentReportSummary) => Promise<void>;
};

export default function DailyReportPanel({
  settings,
  selectedDataset,
  storageStatus,
  scheduleSummary,
  latestStoredReport,
  loadingSettings,
  savingSchedule,
  generatingPdf = false,
  pdfGenerateError = null,
  pdfGenerateNotice = null,
  downloadingReportId,
  saveFeedback,
  onSaveSchedule,
  onGenerateQuickPdf,
  onDownloadPdf
}: DailyReportPanelProps) {
  const [frequency, setFrequency] = useState<ReportFrequency>(settings?.frequency || "daily");
  const [scheduledTime, setScheduledTime] = useState<string>(settings?.scheduledTime || "00:15");
  const [timezone, setTimezone] = useState<string>(settings?.timezone || "Asia/Dhaka");
  const [autoReportEnabled, setAutoReportEnabled] = useState<boolean>(settings?.autoReportEnabled ?? true);
  const [quickRange, setQuickRange] = useState<Exclude<ManualQuickRange, "custom">>("last_30_days");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setFrequency(settings.frequency || "daily");
    setScheduledTime(settings.scheduledTime || "00:15");
    setTimezone(settings.timezone || "Asia/Dhaka");
    setAutoReportEnabled(settings.autoReportEnabled);
  }, [settings]);

  const freqOption = getFrequencyOption(frequency);
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

  const cloudStorageReady = Boolean(storageStatus?.pdfProductionReady && storageStatus?.databaseProductionReady);
  const storageBadgeLabel = storageStatus?.pdfProductionReady
    ? "Cloud PDF Storage Active"
    : storageStatus?.pdfBackend === "local_private_fs"
      ? "Local Dev Storage"
      : "Storage Not Configured";

  const timezoneOptions = COMMON_TIMEZONES.includes(timezone)
    ? COMMON_TIMEZONES
    : [timezone, ...COMMON_TIMEZONES];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const check = validateScheduleFormInput({
      frequency,
      scheduledTime,
      timezone,
      selectedDataset: selectedDataset || settings?.selectedDataset || null,
      autoReportEnabled
    });
    if (!check.valid) {
      setValidationError(check.error);
      return;
    }
    setValidationError(null);
    await onSaveSchedule({
      autoReportEnabled,
      frequency,
      scheduledTime,
      timezone
    });
  }

  return (
    <section className={styles.twoCol} aria-label="Automatic Daily Report configuration">
      {/* Left column: Schedule controls */}
      <form className={styles.card} onSubmit={handleSubmit} noValidate>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <CalendarClock size={17} /> Daily Report Automation
            </h2>
            <p className={styles.cardSub}>
              Configure recurring automatic report generation and private cloud PDF archiving for the connected dataset.
            </p>
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
                    ? "Enabled — runs on completed periods and stores PDFs in private cloud storage."
                    : "Paused — disabling cancels future scheduled execution until re-enabled."}
                </small>
              </div>
              <input
                type="checkbox"
                className={styles.toggleCheckbox}
                aria-label="Enable automatic report generation"
                checked={autoReportEnabled}
                onChange={event => setAutoReportEnabled(event.target.checked)}
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
                      onClick={() => {
                        setFrequency(option.value);
                        setValidationError(null);
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={styles.infoBanner}>
              <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>{freqOption.explanation}</strong>
                <div style={{ marginTop: 3, fontSize: 11.5 }}>{freqOption.incompleteNote}</div>
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
                  onChange={event => {
                    setScheduledTime(event.target.value);
                    setValidationError(null);
                  }}
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
                  onChange={event => setTimezone(event.target.value)}
                >
                  {timezoneOptions.map(tz => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
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

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--muted, #657c8a)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Clock size={12} /> Configured timezone: <strong>{timezone}</strong>
              </span>
              <button
                type="submit"
                className={styles.primaryBtn}
                disabled={savingSchedule || loadingSettings}
              >
                <Save size={14} />
                {savingSchedule ? "Saving Schedule..." : "Save Schedule"}
              </button>
            </div>
          </div>
        )}
      </form>

      {/* Right column: Cloud PDF Storage & Instant Export + Latest Stored PDF */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitleGroup}>
              <h3 className={styles.cardTitle}>
                <Cloud size={15} /> Cloud PDF Archive &amp; Export
              </h3>
              <p className={styles.cardSub}>
                Generated PDFs are stored privately in shared cloud storage and synced across every device.
              </p>
            </div>
            <span className={`${styles.badge} ${cloudStorageReady ? styles.badgePositive : styles.badgeInfo}`}>
              {storageBadgeLabel}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className={styles.kvList}>
              <div className={styles.kvRow}>
                <span>PDF Cloud Bucket</span>
                <strong>{storageStatus?.pdfProductionReady ? "Supabase Private Storage (Synced)" : "Local Dev Storage"}</strong>
              </div>
              <div className={styles.kvRow}>
                <span>Report History Database</span>
                <strong>{storageStatus?.databaseProductionReady ? "Cloud PostgreSQL (Cross-Device)" : "Local SQLite (Dev)"}</strong>
              </div>
              {scheduleSummary?.nextExecution && (
                <div className={styles.kvRow}>
                  <span>Next Scheduled Run</span>
                  <strong>
                    {scheduleSummary.nextExecution.nextNominalRunDate} at {scheduleSummary.nextExecution.nextNominalRunTime}
                  </strong>
                </div>
              )}
            </div>

            {onGenerateQuickPdf && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: "1px solid #edf3f2" }}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="qp-quick-pdf-range" className={styles.fieldLabel}>
                    Generate &amp; Store PDF Now
                  </label>
                  <select
                    id="qp-quick-pdf-range"
                    className={styles.selectInput}
                    value={quickRange}
                    disabled={generatingPdf}
                    onChange={event => setQuickRange(event.target.value as Exclude<ManualQuickRange, "custom">)}
                  >
                    {QUICK_EXPORT_RANGES.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={generatingPdf || !selectedDataset}
                  onClick={() => void onGenerateQuickPdf(quickRange)}
                >
                  <FilePlus2 size={14} />
                  {generatingPdf ? "Generating & Storing PDF..." : "Generate & Save PDF to Cloud"}
                </button>
              </div>
            )}

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
        </div>

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
                Click &ldquo;Generate &amp; Save PDF to Cloud&rdquo; above or enable Daily Report Automation to persist PDFs across all devices.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
