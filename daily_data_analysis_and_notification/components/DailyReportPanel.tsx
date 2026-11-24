"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Info,
  Save
} from "lucide-react";
import type {
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

type DailyReportPanelProps = {
  settings: PersistentDailySettings | null;
  selectedDataset: string;
  storageStatus: StorageCapabilityStatus | null;
  scheduleSummary: ScheduleRuntimeSummary | null;
  loadingSettings: boolean;
  savingSchedule: boolean;
  downloadingReportId: string | null;
  saveFeedback: { type: "success" | "error"; text: string } | null;
  onSaveSchedule: (payload: {
    autoReportEnabled: boolean;
    frequency: ReportFrequency;
    scheduledTime: string;
    timezone: string;
  }) => Promise<void>;
  onDownloadPdf: (report: PersistentReportSummary) => Promise<void>;
};

export default function DailyReportPanel({
  settings,
  selectedDataset,
  storageStatus,
  scheduleSummary,
  loadingSettings,
  savingSchedule,
  downloadingReportId,
  saveFeedback,
  onSaveSchedule,
  onDownloadPdf
}: DailyReportPanelProps) {
  const [frequency, setFrequency] = useState<ReportFrequency>(settings?.frequency || "daily");
  const [scheduledTime, setScheduledTime] = useState<string>(settings?.scheduledTime || "00:15");
  const [timezone, setTimezone] = useState<string>(settings?.timezone || "Asia/Dhaka");
  const [autoReportEnabled, setAutoReportEnabled] = useState<boolean>(settings?.autoReportEnabled ?? true);
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
              Configure recurring automatic report generation and private PDF archiving for the connected dataset.
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
                    ? "Enabled — runs on completed periods without keeping the browser open."
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

      {/* Right column: Actual Schedule Status + Latest Generated Automatic PDF */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitleGroup}>
              <h3 className={styles.cardTitle}>Scheduler Status &amp; Timing Precision</h3>
              <p className={styles.cardSub}>Live backend capability and next scheduled execution window.</p>
            </div>
          </div>

          <div className={styles.kvList}>
            <div className={styles.kvRow}>
              <span>Automatic Execution</span>
              <strong>{scheduleSummary?.active ? "Active in production" : autoReportEnabled ? "Saved (production inactive)" : "Paused"}</strong>
            </div>
            <div className={styles.kvRow}>
              <span>Next Nominal Run</span>
              <strong>
                {scheduleSummary?.nextExecution
                  ? `${scheduleSummary.nextExecution.nextNominalRunDate} at ${scheduleSummary.nextExecution.nextNominalRunTime} (${scheduleSummary.nextExecution.timezone})`
                  : "Paused"}
              </strong>
            </div>
            <div className={styles.kvRow}>
              <span>Next Covered Period</span>
              <strong>
                {scheduleSummary?.nextExecution
                  ? `${scheduleSummary.nextExecution.targetPeriod.periodStart} to ${scheduleSummary.nextExecution.targetPeriod.periodEnd}`
                  : "None"}
              </strong>
            </div>
            <div className={styles.kvRow}>
              <span>Trigger Engine</span>
              <strong>
                {scheduleSummary?.providerStatus.engine === "vercel_schedules"
                  ? "Vercel Schedules (Dynamic)"
                  : scheduleSummary?.providerStatus.engine === "vercel_hobby_daily_cron"
                    ? "Vercel Hobby Daily Cron (15 18 * * * UTC)"
                    : "Local Storage Only (Unconfigured in Prod)"}
              </strong>
            </div>
          </div>

          {scheduleSummary?.providerStatus.precisionNotice && (
            <div className={styles.warnBanner} style={{ marginTop: 12 }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <div>{scheduleSummary.providerStatus.precisionNotice}</div>
                {scheduleSummary.providerStatus.vercelSchedules.blocker && (
                  <div style={{ marginTop: 6, fontSize: 11 }}>
                    <strong>Vercel Schedules Beta:</strong> {scheduleSummary.providerStatus.vercelSchedules.blocker}{" "}
                    <a
                      href={scheduleSummary.providerStatus.vercelSchedules.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: 3 }}
                    >
                      Docs <ExternalLink size={10} />
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          {storageStatus && storageStatus.missingProductionConfig.length > 0 && (
            <div className={styles.warnBanner} style={{ marginTop: 10 }}>
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>Missing production configuration:</strong>{" "}
                <code>{storageStatus.missingProductionConfig.join(", ")}</code>
              </div>
            </div>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitleGroup}>
              <h3 className={styles.cardTitle}>
                <FileText size={15} /> Latest Automatic Report
              </h3>
              <p className={styles.cardSub}>Most recent scheduled report persisted by the backend.</p>
            </div>
          </div>

          {latestAuto ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className={styles.kvList}>
                <div className={styles.kvRow}>
                  <span>Reporting Period</span>
                  <strong>{latestAuto.periodStart} to {latestAuto.periodEnd}</strong>
                </div>
                <div className={styles.kvRow}>
                  <span>Frequency</span>
                  <strong style={{ textTransform: "capitalize" }}>{latestAuto.frequency}</strong>
                </div>
                <div className={styles.kvRow}>
                  <span>Generated At</span>
                  <strong>{formatShortTimestamp(latestAuto.generatedAt, timezone)}</strong>
                </div>
                <div className={styles.kvRow}>
                  <span>Domain &amp; Dataset</span>
                  <strong>{latestAuto.domainName} · {latestAuto.datasetTable}</strong>
                </div>
                <div className={styles.kvRow}>
                  <span>PDF Status</span>
                  <strong>
                    {latestAuto.pdfStatus === "generated"
                      ? `Ready ${latestAuto.pdfSizeBytes ? `(${formatFileSize(latestAuto.pdfSizeBytes)})` : ""}`
                      : latestAuto.pdfStatus === "failed"
                        ? "PDF generation failed"
                        : "Not generated yet"}
                  </strong>
                </div>
              </div>

              {(latestAuto.errorMessage || latestAuto.pdfError) && (
                <div className={styles.errorBanner} role="alert">
                  <span>{latestAuto.errorMessage || latestAuto.pdfError}</span>
                </div>
              )}

              {isReportPdfDownloadable(latestAuto) ? (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={downloadingReportId === latestAuto.id}
                  onClick={() => void onDownloadPdf(latestAuto)}
                >
                  <Download size={14} />
                  {downloadingReportId === latestAuto.id
                    ? "Preparing PDF..."
                    : "Download Latest Automatic PDF"}
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
              <strong>No automatic report generated yet</strong>
              <p>
                {displayState.detail}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
