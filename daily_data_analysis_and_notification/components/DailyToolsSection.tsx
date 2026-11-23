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
  type AlertFilterMode,
  type ToolPanelId
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
  const [activeTool, setActiveTool] = useState<ToolPanelId>("brief");
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

  const toolTabs: Array<{ id: ToolPanelId; label: string; icon: React.ReactNode; count?: number; danger?: boolean }> = [
    { id: "brief", label: "Intelligence Brief", icon: <Sparkles size={13} />, count: brief?.findings.length },
    { id: "comparison", label: "Smart Comparison", icon: <GitCompare size={13} />, count: smartComparison?.metrics.length },
    { id: "alerts", label: "Alerts", icon: <Bell size={13} />, count: unreadCount || alerts.length, danger: unreadCount > 0 },
    { id: "root_cause", label: "Root Cause", icon: <SearchCheck size={13} />, count: rootCause?.analyses.length },
    { id: "recommendations", label: "Recommendations", icon: <Lightbulb size={13} />, count: recommendations.length },
    { id: "data_health", label: "Data Health", icon: <HeartPulse size={13} />, count: dataHealth ? dataHealth.healthScore : undefined },
    { id: "archive", label: "Archive & Compare", icon: <Archive size={13} />, count: archivedReports.length }
  ];

  return (
    <section className={styles.card} aria-label="Seven Daily Analysis Tools">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleGroup}>
          <h2 className={styles.cardTitle}>
            <Activity size={17} /> Daily Analysis Tools
            {domainMeta && <span className={`${styles.badge} ${styles.badgeInfo}`}>{domainMeta.name}</span>}
          </h2>
          <p className={styles.cardSub}>
            {intelligence
              ? `Period: ${intelligence.reportingPeriod.start} to ${intelligence.reportingPeriod.end}${
                  intelligence.comparisonPeriod
                    ? ` · Reference: ${intelligence.comparisonPeriod.label} (${intelligence.comparisonPeriod.start} to ${intelligence.comparisonPeriod.end})`
                    : ""
                } · Source table: ${intelligence.tableName}`
              : "Live business intelligence computed directly from the connected read-only database."}
          </p>
        </div>
        {intelligence && intelligence.partialFailures.length > 0 && (
          <span className={`${styles.badge} ${styles.badgeWarning}`}>
            {intelligence.partialFailures.length} tool warning(s)
          </span>
        )}
      </div>

      {/* Tool navigation tabs */}
      <div className={styles.toolsTabs} role="tablist" aria-label="Daily Analysis Tools">
        {toolTabs.map(tab => {
          const active = activeTool === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`${styles.toolTab} ${active ? styles.toolTabActive : ""}`}
              onClick={() => setActiveTool(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span className={`${styles.countBubble} ${tab.danger ? styles.countBubbleDanger : ""}`}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {intelligenceError && (
        <div className={styles.errorBanner} style={{ marginTop: 14 }} role="alert">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} /> {intelligenceError}
          </span>
        </div>
      )}

      {loadingIntelligence && activeTool !== "archive" ? (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className={styles.skeletonLine} style={{ width: "45%" }} />
          <div className={styles.skeletonLine} style={{ width: "92%" }} />
          <div className={styles.skeletonLine} style={{ width: "86%" }} />
          <div className={styles.skeletonLine} style={{ width: "70%" }} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          {/* 1. DAILY INTELLIGENCE BRIEF */}
          {activeTool === "brief" && (
            brief ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className={styles.infoBanner}>
                  <Sparkles size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                      <strong>Executive Summary</strong>
                      <span className={`${styles.badge} ${brief.status === "ready" ? styles.badgePositive : styles.badgeWarning}`}>
                        {brief.status.replace("_", " ")}
                      </span>
                    </div>
                    <div>{brief.executiveSummary}</div>
                  </div>
                </div>

                {brief.findings.length > 0 ? (
                  <div className={styles.findingsGrid}>
                    {brief.findings.map(finding => (
                      <article key={finding.id} className={`${styles.findingCard} ${findingBorderClass(finding.category)}`}>
                        <div className={styles.findingHead}>
                          <span className={`${styles.badge} ${finding.certainty === "confirmed" ? styles.badgePositive : styles.badgeWarning}`}>
                            {finding.certainty === "confirmed" ? "Confirmed Finding" : "Possible Explanation"}
                          </span>
                          <span className={`${styles.badge} ${styles.badgeNeutral}`}>
                            {finding.category.replace("_", " ")}
                          </span>
                        </div>
                        <h3 className={styles.findingTitle}>{finding.headline}</h3>
                        <p className={styles.findingBody}>{finding.whatHappened}</p>
                        {finding.whatChanged && (
                          <p className={styles.findingBody}>
                            <strong>Change:</strong> {finding.whatChanged}
                          </p>
                        )}
                        <div className={styles.findingFoot}>
                          <span><strong>Area:</strong> {finding.affectedArea}</span>
                          <span><strong>Why it matters:</strong> {finding.whyItMatters}</span>
                          <span><strong>Next check:</strong> {finding.investigateNext}</span>
                        </div>
                      </article>
                    ))}
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
                <strong>Daily Intelligence Brief unavailable</strong>
                <p>Select a connected dataset with mapped date and domain columns to generate a brief.</p>
              </div>
            )
          )}

          {/* 2. SMART DAY COMPARISON */}
          {activeTool === "comparison" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

              {smartComparison ? (
                <>
                  {(smartComparison.statusReason || smartComparison.weekdayNote) && (
                    <div className={styles.infoBanner}>
                      <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                      <div>
                        {smartComparison.statusReason && <div>{smartComparison.statusReason}</div>}
                        {smartComparison.weekdayNote && <div>{smartComparison.weekdayNote}</div>}
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
                </>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>Smart Comparison unavailable</strong>
                  <p>Run analysis on a table with historical date coverage to compare periods.</p>
                </div>
              )}
            </div>
          )}

          {/* 3. DAILY ALERTS & NOTIFICATIONS */}
          {activeTool === "alerts" && (
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

          {/* 4. ROOT CAUSE ANALYSIS */}
          {activeTool === "root_cause" && (
            rootCause ? (
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
            )
          )}

          {/* 5. ACTIONABLE RECOMMENDATIONS */}
          {activeTool === "recommendations" && (
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
                      <h3 className={styles.findingTitle}>{rec.title}</h3>
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

          {/* 6. DATA HEALTH MONITOR */}
          {activeTool === "data_health" && (
            dataHealth ? (
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
            )
          )}

          {/* 7. REPORT ARCHIVE & COMPARISON ENTRY POINT */}
          {activeTool === "archive" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className={styles.infoBanner}>
                <Archive size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Report Archive &amp; Comparison Entry Point:</strong> Select any two persisted reports from the same domain to compare metrics or export a comparison PDF. The full 30-day Historical Dashboard and expanded archive explorer will be delivered in Stage 7.
                </div>
              </div>

              {loadingArchive ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className={styles.skeletonLine} style={{ width: "70%" }} />
                  <div className={styles.skeletonLine} style={{ width: "85%" }} />
                </div>
              ) : archivedReports.length > 0 ? (
                <>
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
                              <button
                                type="button"
                                className={styles.secondaryBtn}
                                disabled={downloadingReportId === rep.id}
                                onClick={() => void onDownloadReportPdf(rep)}
                              >
                                <Download size={13} />
                                {downloadingReportId === rep.id ? "Loading..." : "PDF"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No persisted reports in history yet</strong>
                  <p>Generate a Manual Report or enable Daily Report automation to populate your persisted report archive.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
