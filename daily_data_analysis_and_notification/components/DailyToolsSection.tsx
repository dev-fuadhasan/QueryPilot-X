"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CheckCheck,
  CheckCircle2,
  Download,
  GitCompare,
  HeartPulse,
  Info,
  Lightbulb,
  Minus,
  SearchCheck,
  Settings2,
  Sparkles
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
import type {
  ActionableRecommendation,
  BriefFinding,
  FindingInvestigationResult,
  FindingInvestigationStatus,
  ReportArchiveComparisonResult,
  UnifiedDailyAnalysisResult
} from "../intelligence/types";
import type { ComparisonPreset } from "../metrics/types";
import type { AlertRules, AlertSeverity, DailyReportAlert } from "../notifications";
import type { PersistentReportSummary } from "../storage/types";
import {
  COMPARISON_PRESET_OPTIONS,
  filterDomainAlerts,
  formatShortTimestamp,
  formatSignedPercent,
  getDomainUiMeta,
  isReportPdfDownloadable,
  type AlertFilterMode
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

type DailyToolsSectionProps = {
  intelligence: UnifiedDailyAnalysisResult | null;
  loadingIntelligence: boolean;
  intelligenceError: string | null;
  comparisonPreset: ComparisonPreset;
  onComparisonPresetChange: (preset: ComparisonPreset) => void;
  alerts: DailyReportAlert[];
  alertRules: AlertRules;
  savingAlertRules: boolean;
  onToggleAlertRead: (alertId: string) => void;
  onMarkAllAlertsRead: () => void;
  onSaveAlertRules: (rules: AlertRules) => Promise<void>;
  archivedReports: PersistentReportSummary[];
  loadingArchive: boolean;
  archiveComparison: ReportArchiveComparisonResult | null;
  comparingArchive: boolean;
  archiveCompareError: string | null;
  downloadingReportId: string | null;
  timezone: string;
  onCompareArchivedReports: (leftId: string, rightId: string) => Promise<void>;
  onDownloadReportPdf: (report: PersistentReportSummary, compareWithId?: string) => Promise<void>;
  onOpenReportHistory?: () => void;
  onOpenHistoricalDashboard?: () => void;
};

function findingBorderClass(category: BriefFinding["category"]): string {
  if (category === "positive") return styles.findingPositive;
  if (category === "negative") return styles.findingNegative;
  if (category === "unusual") return styles.findingUnusual;
  if (category === "domain_event") return styles.findingEvent;
  return styles.findingGap;
}

function severityBadgeClass(severity: AlertSeverity): string {
  if (severity === "critical") return styles.badgeCritical;
  if (severity === "warning") return styles.badgeWarning;
  if (severity === "positive") return styles.badgePositive;
  return styles.badgeInfo;
}

function priorityBadgeClass(priority: ActionableRecommendation["priority"]): string {
  if (priority === "critical") return styles.badgeCritical;
  if (priority === "high") return styles.badgeWarning;
  if (priority === "medium") return styles.badgeInfo;
  return styles.badgeNeutral;
}

function healthStatusBadgeClass(status: string): string {
  if (status === "healthy") return styles.badgePositive;
  if (status === "warning") return styles.badgeWarning;
  if (status === "critical") return styles.badgeCritical;
  return styles.badgeInfo;
}

function investigationStatusBadgeClass(status: FindingInvestigationStatus): string {
  if (status === "completed") return styles.badgePositive;
  if (status === "partially_completed") return styles.badgeInfo;
  if (status === "insufficient_data") return styles.badgeWarning;
  return styles.badgeNeutral;
}

function formatInvestigationStatusLabel(status: FindingInvestigationStatus): string {
  if (status === "completed") return "Completed";
  if (status === "partially_completed") return "Partially Completed";
  if (status === "insufficient_data") return "Insufficient Data";
  return "Unsupported";
}

function renderFindingInvestigationPanel(investigation: FindingInvestigationResult) {
  return (
    <div className={styles.investigationBox}>
      <div className={styles.investigationHeader}>
        <span className={styles.investigationHeading}>
          <SearchCheck size={13} /> Automatic Investigation
        </span>
        <span className={`${styles.badge} ${investigationStatusBadgeClass(investigation.status)}`}>
          {formatInvestigationStatusLabel(investigation.status)}
        </span>
      </div>

      <p className={styles.investigationSummary}>{investigation.summary}</p>

      {(investigation.largestChangeDate || investigation.mostRelevantSegment || investigation.duplicateDetails || investigation.missingDataDetails) && (
        <div className={styles.investigationHighlights}>
          {investigation.largestChangeDate && (
            <span className={styles.investigationChip}>
              <strong>Key Date:</strong> {investigation.largestChangeDate}
            </span>
          )}
          {investigation.mostRelevantSegment && (
            <span className={styles.investigationChip}>
              <strong>Top Segment:</strong> {investigation.mostRelevantSegment.dimensionLabel} &ldquo;{investigation.mostRelevantSegment.groupLabel}&rdquo;
              {investigation.mostRelevantSegment.formattedCurrentValue ? ` (${investigation.mostRelevantSegment.formattedCurrentValue})` : ""}
            </span>
          )}
          {investigation.duplicateDetails && (
            <span className={styles.investigationChip}>
              <strong>Duplicate Rows:</strong> {investigation.duplicateDetails.duplicateRowCount}
            </span>
          )}
          {investigation.missingDataDetails && (
            <span className={styles.investigationChip}>
              <strong>Unavailable Metrics:</strong> {investigation.missingDataDetails.unavailableMetrics.length}
            </span>
          )}
        </div>
      )}

      <details className={styles.investigationDetails}>
        <summary className={styles.investigationDetailsToggle}>
          Automatic Investigation Details
        </summary>
        <div className={styles.investigationDetailsBody}>
          {/* 1. Daily Trend */}
          {investigation.dailyTrend && investigation.dailyTrend.points.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Daily Trend</strong>
              <p className={styles.investigationText}>{investigation.dailyTrend.summary}</p>
              <div className={styles.investigationMetaRow}>
                {investigation.dailyTrend.largestDeteriorationDate && (
                  <span><strong>Largest Decline Date:</strong> {investigation.dailyTrend.largestDeteriorationDate}</span>
                )}
                {investigation.dailyTrend.largestImprovementDate && (
                  <span><strong>Largest Improvement Date:</strong> {investigation.dailyTrend.largestImprovementDate}</span>
                )}
                {investigation.dailyTrend.largestDayOverDayChange && (
                  <span>
                    <strong>Largest Day-over-Day Shift:</strong> {investigation.dailyTrend.largestDayOverDayChange.date} (
                    {investigation.dailyTrend.largestDayOverDayChange.changePercent !== null
                      ? formatSignedPercent(investigation.dailyTrend.largestDayOverDayChange.changePercent)
                      : investigation.dailyTrend.largestDayOverDayChange.delta})
                  </span>
                )}
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className={styles.numCell}>Value</th>
                      <th className={styles.numCell}>DoD Change</th>
                      <th className={styles.numCell}>Records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {investigation.dailyTrend.points.slice(0, 14).map(point => (
                      <tr key={point.date}>
                        <td>
                          {point.date}
                          {point.anomaly && (
                            <span className={`${styles.badge} ${point.anomaly === "drop" ? styles.badgeCritical : styles.badgePositive}`} style={{ marginLeft: 6 }}>
                              {point.anomaly}
                            </span>
                          )}
                        </td>
                        <td className={styles.numCell}>{point.formattedValue ?? "N/A"}</td>
                        <td className={styles.numCell}>
                          {point.dayOverDayChangePercent !== null ? formatSignedPercent(point.dayOverDayChangePercent) : "—"}
                        </td>
                        <td className={styles.numCell}>{point.recordCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 2. Segment Breakdown */}
          {investigation.dimensionBreakdowns.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Segment Breakdown</strong>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {investigation.dimensionBreakdowns.slice(0, 3).map(dim => (
                  <div key={dim.dimensionId}>
                    <div className={styles.investigationSubTitle}>
                      {dim.dimensionLabel} <span>({dim.sourceColumn})</span>
                    </div>
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Segment</th>
                            <th className={styles.numCell}>Current</th>
                            <th className={styles.numCell}>Reference</th>
                            <th className={styles.numCell}>Change</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dim.segments.slice(0, 5).map(seg => (
                            <tr key={`${dim.dimensionId}-${seg.groupLabel}`}>
                              <td><strong>{seg.groupLabel}</strong></td>
                              <td className={styles.numCell}>{seg.formattedCurrentValue ?? "N/A"}</td>
                              <td className={styles.numCell}>{seg.formattedReferenceValue ?? "No baseline"}</td>
                              <td className={styles.numCell}>
                                {seg.changePercent !== null ? formatSignedPercent(seg.changePercent) : "—"}
                              </td>
                              <td>
                                <span
                                  className={`${styles.badge} ${
                                    seg.direction === "improved"
                                      ? styles.badgePositive
                                      : seg.direction === "deteriorated"
                                        ? styles.badgeCritical
                                        : styles.badgeNeutral
                                  }`}
                                >
                                  {seg.direction}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3. Related Metric Drivers */}
          {investigation.relatedMetricDrivers.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Related Metric Drivers</strong>
              <ul className={styles.investigationList}>
                {investigation.relatedMetricDrivers.map(driver => (
                  <li key={driver.metricId}>{driver.note}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 4. Duplicate Data Investigation Details */}
          {investigation.duplicateDetails && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Duplicate &amp; Key Granularity Analysis</strong>
              <p className={styles.investigationText}>{investigation.duplicateDetails.assessmentNote}</p>
              {investigation.duplicateDetails.candidateCompositeKeys.length > 0 && (
                <p className={styles.investigationText}>
                  <strong>Candidate composite keys:</strong>{" "}
                  {investigation.duplicateDetails.candidateCompositeKeys.map(keys => keys.join(" + ")).join(" · ")}
                </p>
              )}
              {investigation.duplicateDetails.topRepeatedGroups.length > 0 && (
                <ul className={styles.investigationList}>
                  {investigation.duplicateDetails.topRepeatedGroups.map((grp, idx) => (
                    <li key={idx}>
                      <strong>{grp.keyLabel}</strong>: {grp.count} row(s)
                      {grp.distinctContextCount !== null ? ` across ${grp.distinctContextCount} distinct transaction context(s)` : ""} (
                      {grp.assessment === "likely_legitimate_transactions" ? "likely legitimate transactions" : "possible duplicate records"})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 5. Missing Data / Schema Gap Details */}
          {investigation.missingDataDetails && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Missing Data &amp; Schema Gaps</strong>
              {investigation.missingDataDetails.missingRequiredRoles.length > 0 && (
                <p className={styles.investigationText}>
                  <strong>Missing roles:</strong> {investigation.missingDataDetails.missingRequiredRoles.join(", ")}
                </p>
              )}
              {investigation.missingDataDetails.highNullColumns.length > 0 && (
                <ul className={styles.investigationList}>
                  {investigation.missingDataDetails.highNullColumns.map(col => (
                    <li key={col.columnName}>
                      <strong>{col.columnName}</strong>: {col.nullPercent}% null values ({col.nullCount} row(s))
                    </li>
                  ))}
                </ul>
              )}
              {investigation.missingDataDetails.unavailableMetrics.length > 0 && (
                <ul className={styles.investigationList}>
                  {investigation.missingDataDetails.unavailableMetrics.slice(0, 6).map(um => (
                    <li key={um.metricId}>
                      <strong>{um.name}</strong>: {um.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 6. Key Evidence */}
          {investigation.supportingEvidence.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Key Evidence</strong>
              <ul className={styles.investigationList}>
                {investigation.supportingEvidence.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 7. Data Limitations */}
          {investigation.dataLimitations.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Data Limitations</strong>
              <ul className={styles.investigationList}>
                {investigation.dataLimitations.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 8. Suggested Actions */}
          {investigation.suggestedNextSteps.length > 0 && (
            <div className={styles.investigationSection}>
              <strong className={styles.investigationSectionTitle}>Suggested Actions</strong>
              <ul className={styles.investigationList}>
                {investigation.suggestedNextSteps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function formatDayDuration(dayCount: number): string {
  return `${dayCount} ${dayCount === 1 ? "Day" : "Days"}`;
}

function CardLoadingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className={styles.skeletonLine} style={{ width: "42%" }} />
      <div className={styles.skeletonLine} style={{ width: "92%" }} />
      <div className={styles.skeletonLine} style={{ width: "78%" }} />
    </div>
  );
}

export default function DailyToolsSection({
  intelligence,
  loadingIntelligence,
  intelligenceError,
  comparisonPreset,
  onComparisonPresetChange,
  alerts,
  alertRules,
  savingAlertRules,
  onToggleAlertRead,
  onMarkAllAlertsRead,
  onSaveAlertRules,
  archivedReports,
  loadingArchive,
  archiveComparison,
  comparingArchive,
  archiveCompareError,
  downloadingReportId,
  timezone,
  onCompareArchivedReports,
  onDownloadReportPdf
}: DailyToolsSectionProps) {
  const [alertFilter, setAlertFilter] = useState<AlertFilterMode>("all");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [draftRules, setDraftRules] = useState<AlertRules>(alertRules);
  const [leftArchiveId, setLeftArchiveId] = useState<string>("");
  const [rightArchiveId, setRightArchiveId] = useState<string>("");

  const unreadCount = useMemo(() => alerts.filter(a => !a.isRead).length, [alerts]);
  const filteredAlerts = useMemo(() => filterDomainAlerts(alerts, alertFilter), [alerts, alertFilter]);

  const brief = intelligence?.tools.intelligenceBrief || null;
  const smartComparison = intelligence?.tools.smartComparison || null;
  const rootCause = intelligence?.tools.rootCause || null;
  const recommendations = intelligence?.tools.recommendations || [];
  const dataHealth = intelligence?.tools.dataHealth || null;

  // Never display standalone "possible_explanation" duplicate cards; Possible Explanations
  // are integrated directly inside their corresponding Confirmed Finding.
  const confirmedFindings = useMemo(() => {
    if (!brief) return [];
    const confirmedMetricIds = new Set(
      brief.findings
        .filter(f => f.certainty === "confirmed" && f.metricId)
        .map(f => f.metricId as string)
    );
    return brief.findings.filter(f => {
      if (f.certainty === "possible_explanation") {
        return false;
      }
      if (f.metricId && confirmedMetricIds.has(f.metricId)) {
        return true;
      }
      return true;
    });
  }, [brief]);

  const safeComparisonNote = useMemo(() => {
    if (!smartComparison?.weekdayNote) return null;
    if (/calendar caution/i.test(smartComparison.weekdayNote)) return null;
    return smartComparison.weekdayNote;
  }, [smartComparison]);

  const domainMeta = intelligence ? getDomainUiMeta(intelligence.domainId) : null;

  // Prepare numeric chart rows for Smart Day Comparison (only metrics with valid numbers)
  const comparisonChartData = useMemo(() => {
    if (!smartComparison) return [];
    return smartComparison.metrics
      .filter(m => m.currentValue !== null && m.comparisonValue !== null && m.format !== "percentage" && m.format !== "ratio")
      .slice(0, 6)
      .map(m => ({
        name: m.name.length > 18 ? `${m.name.slice(0, 17)}…` : m.name,
        Current: Number(m.currentValue?.toFixed(2) ?? 0),
        Reference: Number(m.comparisonValue?.toFixed(2) ?? 0)
      }));
  }, [smartComparison]);

  const selectedLeftReport = archivedReports.find(r => r.id === leftArchiveId) || archivedReports[1] || null;
  const selectedRightReport = archivedReports.find(r => r.id === rightArchiveId) || archivedReports[0] || null;

  return (
    <section className={styles.toolsSection} aria-label="Seven Daily Analysis Tools">
      {/* Section Header */}
      <div className={styles.toolsIntroCard}>
        <div className={styles.cardHeader} style={{ marginBottom: 0 }}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <Activity size={17} /> Daily Analysis Tools
              {domainMeta && <span className={`${styles.badge} ${styles.badgeInfo}`}>{domainMeta.name}</span>}
            </h2>
            <p className={styles.cardSub}>
              Live business intelligence tools computed directly from the connected read-only database.
            </p>
          </div>
          {intelligence && intelligence.partialFailures.length > 0 && (
            <span className={`${styles.badge} ${styles.badgeWarning}`}>
              {intelligence.partialFailures.length} tool warning(s)
            </span>
          )}
        </div>

        {intelligenceError && (
          <div className={styles.errorBanner} style={{ marginTop: 12 }} role="alert">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={15} /> {intelligenceError}
            </span>
          </div>
        )}
      </div>

      {/* All 7 Tools rendered directly as individual cards: Smart Comparison first, Findings second */}
      <div className={styles.toolsCardsStack}>
        {/* 1. SMART COMPARISON */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Smart Comparison">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><GitCompare size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Smart Comparison</h3>
                <p className={styles.cardSub}>Side-by-side metric comparison against a selectable reference period with visual deltas.</p>
              </div>
            </div>
            {smartComparison && (
              <div className={styles.metaPills}>
                <span className={`${styles.badge} ${styles.badgePositive}`}>Improved: {smartComparison.summary.improvedCount}</span>
                <span className={`${styles.badge} ${styles.badgeCritical}`}>Declined: {smartComparison.summary.declinedCount}</span>
                <span className={`${styles.badge} ${styles.badgeNeutral}`}>Flat: {smartComparison.summary.flatCount}</span>
                {smartComparison.summary.unavailableCount > 0 && (
                  <span className={`${styles.badge} ${styles.badgeWarning}`}>Unavailable: {smartComparison.summary.unavailableCount}</span>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div className={styles.fieldGroup} style={{ maxWidth: 280 }}>
              <label htmlFor="qp-comparison-preset" className={styles.fieldLabel}>
                Reference Period
              </label>
              <select
                id="qp-comparison-preset"
                className={styles.selectInput}
                value={comparisonPreset}
                onChange={event => onComparisonPresetChange(event.target.value as ComparisonPreset)}
              >
                {COMPARISON_PRESET_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : smartComparison ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Highlighted Current vs Reference Period Overview */}
              <div className={styles.comparisonPeriodsGrid} aria-label="Comparison Period Details">
                <div className={`${styles.comparisonPeriodCard} ${styles.comparisonPeriodCardCurrent}`}>
                  <div className={styles.comparisonPeriodHead}>
                    <span className={styles.comparisonPeriodTitle}>Current Analysis Period</span>
                    <span className={`${styles.badge} ${styles.badgeInfo}`}>
                      {formatDayDuration(smartComparison.reportingPeriod.dayCount)}
                    </span>
                  </div>
                  <dl className={styles.comparisonPeriodRows}>
                    <div className={styles.comparisonPeriodRow}>
                      <dt>Dataset</dt>
                      <dd>{smartComparison.tableName}</dd>
                    </div>
                    <div className={styles.comparisonPeriodRow}>
                      <dt>Date Range</dt>
                      <dd>{smartComparison.reportingPeriod.start} to {smartComparison.reportingPeriod.end}</dd>
                    </div>
                    <div className={styles.comparisonPeriodRow}>
                      <dt>Duration</dt>
                      <dd>{formatDayDuration(smartComparison.reportingPeriod.dayCount)}</dd>
                    </div>
                  </dl>
                </div>

                <div className={`${styles.comparisonPeriodCard} ${styles.comparisonPeriodCardReference}`}>
                  <div className={styles.comparisonPeriodHead}>
                    <span className={styles.comparisonPeriodTitle}>Reference Comparison Period</span>
                    {smartComparison.comparisonPeriod && (
                      <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                        {formatDayDuration(smartComparison.comparisonPeriod.dayCount)}
                      </span>
                    )}
                  </div>
                  {smartComparison.comparisonPeriod ? (
                    <dl className={styles.comparisonPeriodRows}>
                      <div className={styles.comparisonPeriodRow}>
                        <dt>Date Range</dt>
                        <dd>{smartComparison.comparisonPeriod.start} to {smartComparison.comparisonPeriod.end}</dd>
                      </div>
                      <div className={styles.comparisonPeriodRow}>
                        <dt>Duration</dt>
                        <dd>{formatDayDuration(smartComparison.comparisonPeriod.dayCount)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className={styles.comparisonPeriodEmpty}>
                      No reference comparison period selected.
                    </p>
                  )}
                </div>
              </div>

              {(smartComparison.statusReason || safeComparisonNote) && (
                <div className={styles.infoBanner}>
                  <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    {smartComparison.statusReason && <div>{smartComparison.statusReason}</div>}
                    {safeComparisonNote && <div>{safeComparisonNote}</div>}
                  </div>
                </div>
              )}

              {smartComparison.metrics.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th className={styles.numCell}>Current</th>
                        <th className={styles.numCell}>Reference</th>
                        <th className={styles.numCell}>Change</th>
                        <th>Direction</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {smartComparison.metrics.map(row => (
                        <tr key={row.metricId}>
                          <td><strong>{row.name}</strong></td>
                          <td className={styles.numCell}>{row.formattedCurrentValue ?? "Unavailable"}</td>
                          <td className={styles.numCell}>{row.formattedComparisonValue ?? "No baseline"}</td>
                          <td className={styles.numCell}>
                            {row.baselineStatus === "valid"
                              ? formatSignedPercent(row.changePercent)
                              : row.baselineStatus === "zero_baseline"
                                ? "Zero baseline"
                                : "N/A"}
                          </td>
                          <td>
                            <span
                              className={`${styles.badge} ${
                                row.outcome === "improved"
                                  ? styles.badgePositive
                                  : row.outcome === "declined"
                                    ? styles.badgeCritical
                                    : row.outcome === "unavailable"
                                      ? styles.badgeWarning
                                      : styles.badgeNeutral
                              }`}
                            >
                              {row.trendDirection === "up" && <ArrowUpRight size={11} />}
                              {row.trendDirection === "down" && <ArrowDownRight size={11} />}
                              {row.trendDirection === "flat" && <Minus size={11} />}
                              {row.outcome}
                            </span>
                          </td>
                          <td style={{ fontSize: 11, color: "var(--muted, #657c8a)" }}>{row.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No comparable metrics available</strong>
                  <p>Ensure the dataset has valid date records in both the current and reference windows.</p>
                </div>
              )}

              {comparisonChartData.length > 0 && (
                <div className={styles.chartBox} aria-label="Smart day comparison bar chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={comparisonChartData} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e4ecec" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#546472" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#546472" }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Current" fill="#2F4A63" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="Reference" fill="#5B91A3" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyBox}>
              <strong>Smart Comparison unavailable</strong>
              <p>Run analysis on a table with historical date coverage to compare periods.</p>
            </div>
          )}
        </article>

        {/* 2. FINDINGS & DAILY INTELLIGENCE BRIEF */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Findings and Daily Intelligence Brief">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><Sparkles size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Findings &amp; Daily Intelligence Brief</h3>
                <p className={styles.cardSub}>Executive summary, confirmed findings with evidence-backed possible explanations, and automatic investigations.</p>
              </div>
            </div>
            {brief && (
              <div className={styles.metaPills}>
                <span className={`${styles.badge} ${brief.status === "ready" ? styles.badgePositive : styles.badgeWarning}`}>
                  {brief.status.replace("_", " ")}
                </span>
                <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                  {confirmedFindings.length} finding(s)
                </span>
              </div>
            )}
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : brief ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className={styles.infoBanner}>
                <Sparkles size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ marginBottom: 4 }}>
                    <strong>Executive Summary</strong>
                  </div>
                  <div>{brief.executiveSummary}</div>
                </div>
              </div>

              {confirmedFindings.length > 0 ? (
                <div className={styles.findingsGrid}>
                  {confirmedFindings.map(finding => {
                    const showArea = Boolean(
                      finding.affectedArea &&
                      intelligence?.tableName &&
                      finding.affectedArea.trim().toLowerCase() !== intelligence.tableName.trim().toLowerCase()
                    );
                    const isLargeSwing = finding.changePercent !== null && Math.abs(finding.changePercent) >= 35;
                    return (
                      <article key={finding.id} className={`${styles.findingCard} ${findingBorderClass(finding.category)}`}>
                        <div className={styles.findingHead}>
                          <div className={styles.metaPills}>
                            <span className={`${styles.badge} ${styles.badgePositive}`}>
                              Confirmed Finding
                            </span>
                            {isLargeSwing && (
                              <span className={`${styles.badge} ${styles.badgeWarning}`}>
                                Unusual Swing
                              </span>
                            )}
                          </div>
                          <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                            {finding.category.replace("_", " ")}
                          </span>
                        </div>
                        <h4 className={styles.findingTitle}>Confirmed Finding: {finding.headline}</h4>
                        <p className={styles.findingBody}>{finding.whatHappened}</p>
                        {finding.whatChanged && (
                          <p className={styles.findingBody}>
                            <strong>Change:</strong> {finding.whatChanged}
                          </p>
                        )}
                        {showArea && (
                          <p className={styles.findingArea}>
                            <strong>Area:</strong> {finding.affectedArea}
                          </p>
                        )}
                        {finding.possibleExplanation && (
                          <div className={styles.possibleExplanationBox}>
                            <strong className={styles.possibleExplanationLabel}>Possible Explanation:</strong>
                            <p className={styles.possibleExplanationText}>{finding.possibleExplanation}</p>
                          </div>
                        )}
                        {finding.investigation && renderFindingInvestigationPanel(finding.investigation)}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No major anomalies or events flagged for this period</strong>
                  <p>Your metrics are either within normal expectations or required columns were unavailable in this dataset.</p>
                </div>
              )}

              {brief.dataCaveats.length > 0 && (
                <div className={styles.warnBanner}>
                  <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <strong>Data gaps &amp; caveats:</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {brief.dataCaveats.map((caveat, idx) => (
                        <li key={idx}>{caveat}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyBox}>
              <strong>Findings unavailable</strong>
              <p>Select a connected dataset with mapped date and domain columns to generate findings.</p>
            </div>
          )}
        </article>

        {/* 3. DAILY ALERTS & NOTIFICATIONS */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Daily Alerts and Notifications">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><Bell size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Daily Alerts &amp; Notifications</h3>
                <p className={styles.cardSub}>Threshold violations, unusual domain shifts, and customizable alert rules.</p>
              </div>
            </div>
            <div className={styles.metaPills}>
              <span className={`${styles.badge} ${unreadCount > 0 ? styles.badgeCritical : styles.badgeNeutral}`}>
                {unreadCount} unread / {alerts.length} total
              </span>
            </div>
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className={styles.metaPills} role="group" aria-label="Filter alerts by status or severity">
                  {(["all", "unread", "critical", "warning", "positive", "info"] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={`${styles.toolTab} ${alertFilter === mode ? styles.toolTabActive : ""}`}
                      style={{ padding: "5px 10px", fontSize: 11 }}
                      onClick={() => setAlertFilter(mode)}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    disabled={unreadCount === 0}
                    onClick={onMarkAllAlertsRead}
                  >
                    <CheckCheck size={13} /> Mark All Read
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setDraftRules(alertRules);
                      setRulesOpen(prev => !prev);
                    }}
                  >
                    <Settings2 size={13} /> Alert Thresholds
                  </button>
                </div>
              </div>

              {rulesOpen && (
                <div className={styles.ambiguousBox} style={{ borderColor: "var(--border, #d9e6e5)", background: "var(--qp-surface, #f5faf8)" }}>
                  <strong style={{ fontSize: 12, color: "var(--qp-navy, #131B2B)" }}>Alert Notification Thresholds (Persisted via Settings API)</strong>
                  <div className={styles.formGrid}>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Revenue / Primary Metric Drop Alert (%)</span>
                      <input
                        type="number"
                        className={styles.textInput}
                        min={1}
                        max={95}
                        value={draftRules.revenueDropPercent}
                        onChange={e => setDraftRules(prev => ({ ...prev, revenueDropPercent: Number(e.target.value) }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Positive Surge Highlight (%)</span>
                      <input
                        type="number"
                        className={styles.textInput}
                        min={1}
                        max={300}
                        value={draftRules.revenueGrowthPercent}
                        onChange={e => setDraftRules(prev => ({ ...prev, revenueGrowthPercent: Number(e.target.value) }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Low Margin Floor (%)</span>
                      <input
                        type="number"
                        className={styles.textInput}
                        min={0}
                        max={90}
                        value={draftRules.minProfitMarginPercent}
                        onChange={e => setDraftRules(prev => ({ ...prev, minProfitMarginPercent: Number(e.target.value) }))}
                      />
                    </label>
                    <label className={styles.fieldGroup}>
                      <span className={styles.fieldLabel}>Max Cancellation / Failure Rate (%)</span>
                      <input
                        type="number"
                        className={styles.textInput}
                        min={1}
                        max={95}
                        value={draftRules.maxCancellationRatePercent}
                        onChange={e => setDraftRules(prev => ({ ...prev, maxCancellationRatePercent: Number(e.target.value) }))}
                      />
                    </label>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={draftRules.enabled}
                        onChange={e => setDraftRules(prev => ({ ...prev, enabled: e.target.checked }))}
                      />
                      Enable domain anomaly &amp; threshold alerts
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className={styles.ghostBtn} onClick={() => setRulesOpen(false)}>Cancel</button>
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        disabled={savingAlertRules}
                        onClick={async () => {
                          await onSaveAlertRules(draftRules);
                          setRulesOpen(false);
                        }}
                      >
                        {savingAlertRules ? "Saving..." : "Save Alert Rules"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {filteredAlerts.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {filteredAlerts.map(alert => (
                    <div
                      key={alert.id}
                      className={`${styles.findingCard} ${
                        alert.severity === "critical"
                          ? styles.findingNegative
                          : alert.severity === "warning"
                            ? styles.findingUnusual
                            : alert.severity === "positive"
                              ? styles.findingPositive
                              : styles.findingEvent
                      }`}
                      style={{ opacity: alert.isRead ? 0.72 : 1 }}
                    >
                      <div className={styles.findingHead}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className={`${styles.badge} ${severityBadgeClass(alert.severity)}`}>
                            {alert.severity}
                          </span>
                          <strong style={{ fontSize: 12.5 }}>{alert.title}</strong>
                          {alert.metricValue && (
                            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                              {alert.metricLabel ? `${alert.metricLabel}: ` : ""}{alert.metricValue}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          onClick={() => onToggleAlertRead(alert.id)}
                        >
                          {alert.isRead ? "Mark unread" : "Mark read"}
                        </button>
                      </div>
                      <p className={styles.findingBody}>{alert.message}</p>
                      <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>
                        {alert.periodLabel} · {alert.isRead ? "Read" : "Unread"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No matching alerts</strong>
                  <p>
                    {alerts.length === 0
                      ? "No threshold violations or domain anomalies were triggered for this reporting period."
                      : "Try clearing the active severity/read filter to view all alerts."}
                  </p>
                </div>
              )}
            </div>
          )}
        </article>

        {/* 4. ROOT CAUSE ANALYSIS */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Root Cause Analysis">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><SearchCheck size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Root Cause Analysis</h3>
                <p className={styles.cardSub}>Dimension-level contributor breakdown explaining which segments drove period-over-period shifts.</p>
              </div>
            </div>
            {rootCause && (
              <span className={`${styles.badge} ${rootCause.available ? styles.badgeInfo : styles.badgeNeutral}`}>
                {rootCause.analyses.length} metric breakdown(s)
              </span>
            )}
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : rootCause ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className={styles.warnBanner}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Causality Disclaimer:</strong> {rootCause.causalityDisclaimer}
                  {intelligence?.analysis.source.executionMode === "database_aggregate" && (
                    <div style={{ marginTop: 4 }}>
                      <strong>Large-dataset mode:</strong> Computed using independent database-side <code>GROUP BY</code> queries per dimension without loading raw rows into memory.
                    </div>
                  )}
                </div>
              </div>

              {rootCause.available && rootCause.analyses.length > 0 ? (
                rootCause.analyses.map(analysis => {
                  const contributors = [...analysis.negativeContributors, ...analysis.positiveContributors].slice(0, 10);
                  return (
                    <div key={analysis.metricId} style={{ border: "1px solid var(--border, #d9e6e5)", borderRadius: 10, padding: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                        <div>
                          <strong style={{ fontSize: 13 }}>{analysis.metricName}</strong>
                          <div style={{ fontSize: 11.5, color: "var(--muted, #657c8a)" }}>{analysis.summary}</div>
                        </div>
                        <span className={`${styles.badge} ${analysis.reliability === "reliable" ? styles.badgePositive : styles.badgeWarning}`}>
                          {analysis.reliability} · Delta: {analysis.totalDelta >= 0 ? "+" : ""}{analysis.totalDelta.toLocaleString(undefined, { maximumFractionDigits: 2 })} ({formatSignedPercent(analysis.changePercent)})
                        </span>
                      </div>

                      {contributors.length > 0 ? (
                        <div className={styles.tableWrap}>
                          <table className={styles.dataTable}>
                            <thead>
                              <tr>
                                <th>Dimension</th>
                                <th>Group</th>
                                <th className={styles.numCell}>Current</th>
                                <th className={styles.numCell}>Reference</th>
                                <th className={styles.numCell}>Delta</th>
                                <th className={styles.numCell}>Share of Change</th>
                                <th>Presence</th>
                              </tr>
                            </thead>
                            <tbody>
                              {contributors.map((item, idx) => (
                                <tr key={`${item.dimensionId}-${item.groupLabel}-${idx}`}>
                                  <td>{item.dimensionLabel}</td>
                                  <td><strong>{item.groupLabel}</strong></td>
                                  <td className={styles.numCell}>{item.currentValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                                  <td className={styles.numCell}>{item.comparisonValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                                  <td className={styles.numCell}>
                                    {item.absoluteDelta >= 0 ? "+" : ""}{item.absoluteDelta.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                  </td>
                                  <td className={styles.numCell}>
                                    {item.contributionPercent !== null ? `${item.contributionPercent.toFixed(1)}%` : "N/A"}
                                  </td>
                                  <td>
                                    <span className={`${styles.badge} ${item.appearance === "both_periods" ? styles.badgeNeutral : styles.badgeInfo}`}>
                                      {item.appearance === "current_only" ? "Newly appeared" : item.appearance === "comparison_only" ? "Disappeared" : "Both periods"}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className={styles.cardSub}>{analysis.unavailableReason || "No individual dimension contributors stood out for this metric."}</p>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className={styles.emptyBox}>
                  <strong>Root Cause breakdown unavailable for this view</strong>
                  <p>{rootCause.unavailableReason || "A valid comparison period and at least one categorical business dimension are required."}</p>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyBox}>
              <strong>Root Cause Analysis unavailable</strong>
              <p>Select a table with categorical dimensions and historical comparison coverage.</p>
            </div>
          )}
        </article>

        {/* 5. ACTIONABLE RECOMMENDATIONS */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Actionable Recommendations">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><Lightbulb size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Actionable Recommendations</h3>
                <p className={styles.cardSub}>Priority-ranked, evidence-backed advisories tied directly to computed findings.</p>
              </div>
            </div>
            <span className={`${styles.badge} ${recommendations.length > 0 ? styles.badgeInfo : styles.badgeNeutral}`}>
              {recommendations.length} recommendation(s)
            </span>
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className={styles.infoBanner}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Recommendations are strictly evidence-based advisories derived from backend findings. QueryPilot-X never mutates your connected database or executes external business actions automatically.
                </span>
              </div>

              {recommendations.length > 0 ? (
                <div className={styles.findingsGrid}>
                  {recommendations.map(rec => (
                    <article key={rec.id} className={`${styles.findingCard} ${rec.priority === "critical" ? styles.findingNegative : rec.priority === "high" ? styles.findingUnusual : styles.findingEvent}`}>
                      <div className={styles.findingHead}>
                        <span className={`${styles.badge} ${priorityBadgeClass(rec.priority)}`}>
                          {rec.priority} priority
                        </span>
                        <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                          Evidence: {rec.evidenceLevel} · via {rec.sourceTool.replace("_", " ")}
                        </span>
                      </div>
                      <h4 className={styles.findingTitle}>{rec.title}</h4>
                      <p className={styles.findingBody}>{rec.description}</p>
                      <div className={styles.findingFoot}>
                        <span><strong>Supporting finding:</strong> {rec.reason}</span>
                        {rec.metricName && (
                          <span><strong>Affected metric:</strong> {rec.metricName}{rec.metricValue ? ` (${rec.metricValue})` : ""}</span>
                        )}
                        <span><strong>Suggested action:</strong> {rec.suggestedAction}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No urgent actions recommended</strong>
                  <p>No verifiable risks, anomalies, or data quality gaps required intervention in this period.</p>
                </div>
              )}
            </div>
          )}
        </article>

        {/* 6. DATA HEALTH MONITOR */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Data Health Monitor">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><HeartPulse size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Data Health Monitor</h3>
                <p className={styles.cardSub}>Source freshness, null ratios, duplicate detection, and historical date coverage diagnostics.</p>
              </div>
            </div>
            {dataHealth && (
              <div className={styles.metaPills}>
                <span className={`${styles.badge} ${healthStatusBadgeClass(dataHealth.overallStatus)}`}>
                  Score: {dataHealth.healthScore}/100 · {dataHealth.overallStatus}
                </span>
              </div>
            )}
          </div>

          {loadingIntelligence ? (
            <CardLoadingSkeleton />
          ) : dataHealth ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className={styles.healthScoreRow}>
                <div className={styles.healthMiniCard}>
                  <span>Overall Health Score</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong>{dataHealth.healthScore}/100</strong>
                    <span className={`${styles.badge} ${healthStatusBadgeClass(dataHealth.overallStatus)}`}>
                      {dataHealth.overallStatus}
                    </span>
                  </div>
                </div>
                <div className={styles.healthMiniCard}>
                  <span>Latest Source Record</span>
                  <strong>{dataHealth.sourceFreshness.latestDate ? dataHealth.sourceFreshness.latestDate.slice(0, 10) : "Unknown"}</strong>
                  <span style={{ fontSize: 10 }}>Freshness: {dataHealth.sourceFreshness.status}</span>
                </div>
                <div className={styles.healthMiniCard}>
                  <span>Analysis Generated At</span>
                  <strong style={{ fontSize: 13 }}>{formatShortTimestamp(dataHealth.analysisGeneratedAt, timezone)}</strong>
                  <span style={{ fontSize: 10 }}>Distinct from source record time</span>
                </div>
                <div className={styles.healthMiniCard}>
                  <span>Historical Coverage</span>
                  <strong>{dataHealth.historicalCoverage.coveredDays} day(s)</strong>
                  <span style={{ fontSize: 10 }}>
                    {dataHealth.historicalCoverage.expectedDatesMissing.length > 0
                      ? `${dataHealth.historicalCoverage.expectedDatesMissing.length} missing expected date(s)`
                      : "No missing expected dates"}
                  </span>
                </div>
              </div>

              {dataHealth.checks.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Status</th>
                        <th>Measured Value</th>
                        <th>Explanation &amp; Remediation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dataHealth.checks.map(check => (
                        <tr key={check.id}>
                          <td>
                            <strong>{check.title}</strong>
                            <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>{check.category}</div>
                          </td>
                          <td>
                            <span className={`${styles.badge} ${healthStatusBadgeClass(check.status)}`}>
                              {check.status}
                            </span>
                          </td>
                          <td className={styles.numCell}>{check.metricValue ?? "—"}</td>
                          <td>
                            <div>{check.explanation}</div>
                            {check.affectedFields.length > 0 && (
                              <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)", marginTop: 2 }}>
                                Fields: <code>{check.affectedFields.join(", ")}</code>
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: "var(--qp-slate, #2F4A63)", marginTop: 3 }}>
                              <strong>Remediation:</strong> {check.remediation}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>All data health checks passed</strong>
                  <p>No freshness, null, duplicate, or date validity warnings were reported.</p>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.emptyBox}>
              <strong>Data Health Monitor unavailable</strong>
              <p>Select a connected dataset to inspect freshness, nulls, duplicates, and historical coverage.</p>
            </div>
          )}
        </article>

        {/* 7. ARCHIVE & COMPARE */}
        <article className={`${styles.card} ${styles.toolCard}`} aria-label="Archive and Compare">
          <div className={styles.toolCardHeader}>
            <div className={styles.toolCardTitleRow}>
              <span className={styles.toolCardIcon}><Archive size={16} /></span>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>Archive &amp; Compare</h3>
                <p className={styles.cardSub}>Persisted organisation reports, side-by-side archived report comparison, and authorised PDF downloads.</p>
              </div>
            </div>
            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
              {archivedReports.length} report(s)
            </span>
          </div>

          {loadingArchive ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className={styles.skeletonLine} style={{ width: "70%" }} />
              <div className={styles.skeletonLine} style={{ width: "85%" }} />
            </div>
          ) : archivedReports.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Comparison selector */}
              {archivedReports.length >= 2 && (
                <div className={styles.ambiguousBox} style={{ borderColor: "var(--border, #d9e6e5)", background: "var(--qp-surface, #f5faf8)" }}>
                  <strong style={{ fontSize: 12, color: "var(--qp-navy, #131B2B)" }}>Compare Two Archived Reports</strong>
                  <div className={styles.formGrid}>
                    <div className={styles.fieldGroup}>
                      <label htmlFor="qp-archive-left" className={styles.fieldLabel}>Baseline Report (Left)</label>
                      <select
                        id="qp-archive-left"
                        className={styles.selectInput}
                        value={selectedLeftReport?.id || ""}
                        onChange={e => setLeftArchiveId(e.target.value)}
                      >
                        {archivedReports.map(rep => (
                          <option key={rep.id} value={rep.id}>
                            {rep.periodStart}..{rep.periodEnd} ({rep.frequency} · {rep.domainName})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.fieldGroup}>
                      <label htmlFor="qp-archive-right" className={styles.fieldLabel}>Target Report (Right)</label>
                      <select
                        id="qp-archive-right"
                        className={styles.selectInput}
                        value={selectedRightReport?.id || ""}
                        onChange={e => setRightArchiveId(e.target.value)}
                      >
                        {archivedReports.map(rep => (
                          <option key={rep.id} value={rep.id}>
                            {rep.periodStart}..{rep.periodEnd} ({rep.frequency} · {rep.domainName})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      disabled={comparingArchive || !selectedLeftReport || !selectedRightReport || selectedLeftReport.id === selectedRightReport.id}
                      onClick={() => {
                        if (selectedLeftReport && selectedRightReport) {
                          void onCompareArchivedReports(selectedLeftReport.id, selectedRightReport.id);
                        }
                      }}
                    >
                      <GitCompare size={14} />
                      {comparingArchive ? "Comparing..." : "Compare Selected Reports"}
                    </button>
                    {selectedLeftReport && selectedRightReport && selectedLeftReport.id !== selectedRightReport.id && (
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        disabled={downloadingReportId === selectedRightReport.id}
                        onClick={() => void onDownloadReportPdf(selectedRightReport, selectedLeftReport.id)}
                      >
                        <Download size={14} />
                        Download Comparison PDF
                      </button>
                    )}
                  </div>
                </div>
              )}

              {archiveCompareError && (
                <div className={styles.errorBanner} role="alert">
                  <span>{archiveCompareError}</span>
                </div>
              )}

              {archiveComparison && (
                <div style={{ border: "1px solid var(--border, #d9e6e5)", borderRadius: 10, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Comparison Result</strong>
                    <span className={`${styles.badge} ${archiveComparison.compatible ? styles.badgePositive : styles.badgeWarning}`}>
                      {archiveComparison.compatible ? "Compatible" : "Incompatible"}
                    </span>
                  </div>
                  <p className={styles.cardSub} style={{ marginBottom: 10 }}>
                    {archiveComparison.incompatibilityReason || archiveComparison.summary}
                  </p>
                  {archiveComparison.compatible && archiveComparison.metrics.length > 0 && (
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Metric</th>
                            <th className={styles.numCell}>Baseline</th>
                            <th className={styles.numCell}>Target</th>
                            <th className={styles.numCell}>Change</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {archiveComparison.metrics.map(m => (
                            <tr key={m.metricId}>
                              <td><strong>{m.name}</strong></td>
                              <td className={styles.numCell}>{m.formattedLeftValue ?? "N/A"}</td>
                              <td className={styles.numCell}>{m.formattedRightValue ?? "N/A"}</td>
                              <td className={styles.numCell}>{formatSignedPercent(m.changePercent)}</td>
                              <td><span className={`${styles.badge} ${styles.badgeNeutral}`}>{m.status.replace("_", " ")}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Archived reports table */}
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Type</th>
                      <th>Domain &amp; Dataset</th>
                      <th>PDF Status</th>
                      <th className={styles.numCell}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedReports.slice(0, 12).map(rep => (
                      <tr key={rep.id}>
                        <td>
                          <strong>{rep.periodStart} to {rep.periodEnd}</strong>
                          <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>
                            Generated {formatShortTimestamp(rep.generatedAt, timezone)}
                          </div>
                        </td>
                        <td>
                          <span className={`${styles.badge} ${rep.generationType === "automatic" ? styles.badgeInfo : styles.badgeNeutral}`}>
                            {rep.generationType} · {rep.frequency}
                          </span>
                        </td>
                        <td>
                          <strong>{rep.domainName}</strong>
                          <div style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>{rep.datasetTable}</div>
                        </td>
                        <td>
                          <span
                            className={`${styles.badge} ${
                              rep.pdfStatus === "generated"
                                ? styles.badgePositive
                                : rep.pdfStatus === "failed"
                                  ? styles.badgeWarning
                                  : styles.badgeNeutral
                            }`}
                          >
                            {rep.pdfStatus === "generated"
                              ? <><CheckCircle2 size={11} /> Ready</>
                              : rep.pdfStatus === "failed"
                                ? "Failed"
                                : "On demand"}
                          </span>
                        </td>
                        <td className={styles.numCell}>
                          {isReportPdfDownloadable(rep) ? (
                            <button
                              type="button"
                              className={styles.secondaryBtn}
                              disabled={downloadingReportId === rep.id}
                              onClick={() => void onDownloadReportPdf(rep)}
                            >
                              <Download size={13} />
                              {downloadingReportId === rep.id ? "Loading..." : "PDF"}
                            </button>
                          ) : (
                            <span style={{ fontSize: 10.5, color: "var(--muted, #657c8a)" }}>Unavailable</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className={styles.emptyBox}>
              <strong>No persisted reports in archive yet</strong>
              <p>Enable Daily Report automation to populate your persisted report archive for comparison and PDF download.</p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
