"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarRange,
  Clock,
  Database,
  Info,
  Layers,
  Minus,
  RefreshCw,
  TrendingUp
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { BusinessDomainId } from "../profiler/types";
import type { DynamicAnalysisResult, MetricResult } from "../metrics/types";
import type { ManualQuickRange } from "../storage/types";
import {
  computeHistoricalCoverageSummary,
  extractHistoricalSeriesOptions,
  extractSignificantHistoricalChanges,
  formatShortTimestamp,
  formatSignedPercent,
  getDomainUiMeta,
  MANUAL_QUICK_RANGE_OPTIONS,
  todayIsoInTimezone,
  validateManualRangeSelection
} from "./dashboard-helpers";
import styles from "./DailyAnalysisDashboard.module.css";

type HistoricalDashboardPanelProps = {
  selectedDomain: BusinessDomainId;
  selectedDataset: string;
  timezone: string;
  earliestAvailableDate: string | null;
  latestAvailableDate: string | null;
  quickRange: ManualQuickRange;
  customStart: string;
  customEnd: string;
  analysis: DynamicAnalysisResult | null;
  loading: boolean;
  error: string | null;
  lastAnalyzedAt: string | null;
  onRangeChange: (input: { quickRange: ManualQuickRange; startDate?: string; endDate?: string }) => void;
  onRefresh: () => void;
};

function deltaToneClass(metric: MetricResult): string {
  if (metric.changePercent === null || metric.trendDirection === "flat" || metric.trendDirection === "unavailable") {
    return styles.badgeNeutral;
  }
  if (metric.polarity === "neutral") return styles.badgeInfo;
  if (metric.isLossPosition && metric.performanceDirection === "improved") {
    return styles.badgeWarning;
  }
  const improved =
    (metric.polarity === "higher_is_better" && metric.changePercent > 0)
    || (metric.polarity === "lower_is_better" && metric.changePercent < 0);
  return improved ? styles.badgePositive : styles.badgeCritical;
}

export default function HistoricalDashboardPanel({
  selectedDomain,
  selectedDataset,
  timezone,
  earliestAvailableDate,
  latestAvailableDate,
  quickRange,
  customStart,
  customEnd,
  analysis,
  loading,
  error,
  lastAnalyzedAt,
  onRangeChange,
  onRefresh
}: HistoricalDashboardPanelProps) {
  const [draftStart, setDraftStart] = useState(customStart);
  const [draftEnd, setDraftEnd] = useState(customEnd);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [selectedMetricKey, setSelectedMetricKey] = useState<string>("");
  const [selectedDimensionId, setSelectedDimensionId] = useState<string>("");
  const [showUnavailable, setShowUnavailable] = useState<boolean>(false);

  useEffect(() => {
    setDraftStart(customStart);
    setDraftEnd(customEnd);
  }, [customStart, customEnd]);

  const domainMeta = getDomainUiMeta(selectedDomain);
  const maxDate = todayIsoInTimezone(timezone);

  const seriesOptions = useMemo(() => extractHistoricalSeriesOptions(analysis), [analysis]);
  const activeMetricKey = useMemo(() => {
    if (selectedMetricKey && seriesOptions.some(o => o.metricKey === selectedMetricKey)) {
      return selectedMetricKey;
    }
    return seriesOptions[0]?.metricKey || "";
  }, [selectedMetricKey, seriesOptions]);

  const breakdowns = analysis?.breakdowns || [];
  const activeBreakdown = useMemo(() => {
    if (!breakdowns.length) return null;
    return breakdowns.find(b => b.dimensionId === selectedDimensionId) || breakdowns[0];
  }, [breakdowns, selectedDimensionId]);

  const coverage = useMemo(() => computeHistoricalCoverageSummary(analysis), [analysis]);
  const significantChanges = useMemo(() => extractSignificantHistoricalChanges(analysis, 4), [analysis]);

  const trendChartData = useMemo(() => {
    if (!analysis || !activeMetricKey) return [];
    return analysis.timeSeries.map(point => ({
      date: point.date.slice(5),
      fullDate: point.date,
      value: point.metrics[activeMetricKey] ?? 0,
      records: point.recordCount
    }));
  }, [activeMetricKey, analysis]);

  const breakdownChartData = useMemo(() => {
    if (!activeBreakdown) return [];
    return activeBreakdown.items.slice(0, 8).map(item => ({
      label: item.label.length > 20 ? `${item.label.slice(0, 19)}…` : item.label,
      fullLabel: item.label,
      value: Number(item.primaryValue.toFixed(2)),
      share: item.sharePercent
    }));
  }, [activeBreakdown]);

  // Domain-specific structured extras (e.g. CRM RFM or Inventory Reorder Alerts)
  const rfmSegments = Array.isArray(analysis?.domainSpecificData?.rfmSegments)
    ? (analysis?.domainSpecificData?.rfmSegments as Array<{ segment: string; customerCount: number; sharePercent?: number }>)
    : [];
  const reorderAlerts = Array.isArray(analysis?.domainSpecificData?.reorderAlerts)
    ? (analysis?.domainSpecificData?.reorderAlerts as Array<{ sku: string; stockOnHand: number; reorderPoint: number; warehouse?: string }>)
    : [];

  function handleQuickSelect(nextRange: ManualQuickRange) {
    setRangeError(null);
    if (nextRange === "custom") {
      onRangeChange({ quickRange: "custom", startDate: draftStart, endDate: draftEnd });
      return;
    }
    onRangeChange({ quickRange: nextRange });
  }

  function handleApplyCustomRange(event: React.FormEvent) {
    event.preventDefault();
    const check = validateManualRangeSelection({
      quickRange: "custom",
      startDate: draftStart,
      endDate: draftEnd,
      timezone,
      earliestAvailableDate,
      latestAvailableDate
    });
    if (!check.valid) {
      setRangeError(check.error);
      return;
    }
    setRangeError(null);
    onRangeChange({ quickRange: "custom", startDate: draftStart, endDate: draftEnd });
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }} aria-label="Dynamic Historical Dashboard">
      {/* Range Control Card */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <h2 className={styles.cardTitle}>
              <TrendingUp size={17} /> Dynamic Historical Dashboard
              <span className={`${styles.badge} ${styles.badgeInfo}`}>{domainMeta.name}</span>
            </h2>
            <p className={styles.cardSub}>
              Live backend-computed historical KPIs, trend charts, and category breakdowns defaulting to the previous 30 days. Refreshed on demand from your read-only database.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={styles.freshnessChip} title="Refreshed on demand — not a real-time push stream">
              <Clock size={12} />
              {lastAnalyzedAt ? `Last analyzed: ${formatShortTimestamp(lastAnalyzedAt, timezone)}` : "On-demand query"}
            </span>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={loading || !selectedDataset}
              onClick={onRefresh}
            >
              <RefreshCw size={13} className={loading ? "spinning" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* 6 Historical Ranges */}
        <div className={styles.quickRangeGrid} role="radiogroup" aria-label="Historical dashboard period">
          {MANUAL_QUICK_RANGE_OPTIONS.map(option => {
            const active = quickRange === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`${styles.quickRangeCard} ${active ? styles.quickRangeCardActive : ""}`}
                onClick={() => handleQuickSelect(option.value)}
              >
                <strong>
                  {option.label}
                  {option.value === "last_30_days" ? " (Default)" : ""}
                </strong>
                <small>{option.hint}</small>
              </button>
            );
          })}
        </div>

        {quickRange === "custom" && (
          <form onSubmit={handleApplyCustomRange} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={styles.formGrid}>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-hist-start" className={styles.fieldLabel}>Start Date</label>
                <input
                  id="qp-hist-start"
                  type="date"
                  className={styles.textInput}
                  value={draftStart}
                  min={earliestAvailableDate?.slice(0, 10) || undefined}
                  max={draftEnd || maxDate}
                  onChange={e => { setDraftStart(e.target.value); setRangeError(null); }}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label htmlFor="qp-hist-end" className={styles.fieldLabel}>End Date</label>
                <input
                  id="qp-hist-end"
                  type="date"
                  className={styles.textInput}
                  value={draftEnd}
                  min={draftStart || earliestAvailableDate?.slice(0, 10) || undefined}
                  max={maxDate}
                  onChange={e => { setDraftEnd(e.target.value); setRangeError(null); }}
                />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--muted, #657c8a)" }}>
                Available history: {earliestAvailableDate && latestAvailableDate ? `${earliestAvailableDate.slice(0, 10)} to ${latestAvailableDate.slice(0, 10)}` : "Auto-detected from table"}
              </span>
              <button type="submit" className={styles.primaryBtn} disabled={loading || !selectedDataset}>
                <CalendarRange size={14} /> Apply Custom Range
              </button>
            </div>
          </form>
        )}

        {(rangeError || error) && (
          <div className={styles.errorBanner} style={{ marginTop: 12 }} role="alert">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={15} /> {rangeError || error}
            </span>
          </div>
        )}
      </div>

      {/* Loading Skeleton */}
      {loading && (
        <div className={styles.card}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={styles.skeletonLine} style={{ width: "42%" }} />
            <div className={styles.skeletonLine} style={{ width: "92%" }} />
            <div className={styles.skeletonLine} style={{ width: "86%" }} />
            <div className={styles.skeletonLine} style={{ width: "74%", height: 140 }} />
          </div>
        </div>
      )}

      {/* Main Historical Content */}
      {!loading && analysis && (
        <>
          {/* Data Coverage & Missing-Data Bar */}
          <div className={styles.healthScoreRow}>
            <div className={styles.healthMiniCard}>
              <span>Active Period</span>
              <strong style={{ fontSize: 13.5 }}>{analysis.reportingPeriod.start} to {analysis.reportingPeriod.end}</strong>
              <span style={{ fontSize: 10 }}>{analysis.reportingPeriod.dayCount} day(s) · {analysis.timezone}</span>
            </div>
            <div className={styles.healthMiniCard}>
              <span>Comparison Reference</span>
              <strong style={{ fontSize: 13.5 }}>
                {analysis.comparisonPeriod ? `${analysis.comparisonPeriod.start} to ${analysis.comparisonPeriod.end}` : "None"}
              </strong>
              <span style={{ fontSize: 10 }}>
                {analysis.comparisonSummary.available
                  ? `${analysis.comparisonSummary.improvedCount} improved · ${analysis.comparisonSummary.declinedCount} declined`
                  : analysis.comparisonSummary.reason || "No comparison window"}
              </span>
            </div>
            <div className={styles.healthMiniCard}>
              <span>Data Coverage</span>
              <strong>{coverage.observedDays}/{coverage.periodDays} days ({coverage.coveragePercent}%)</strong>
              <span style={{ fontSize: 10 }}>
                {coverage.missingDays > 0 ? `${coverage.missingDays} day(s) without records` : "Full daily coverage"}
              </span>
            </div>
            <div className={styles.healthMiniCard}>
              <span>Source Rows &amp; Mode</span>
              <strong>{coverage.rowCountInPeriod.toLocaleString()} rows</strong>
              <span style={{ fontSize: 10 }}>
                <Database size={10} style={{ display: "inline", marginRight: 3 }} />
                {analysis.source.executionMode === "database_aggregate" ? "DB-side aggregation" : "Scoped read-only query"}
              </span>
            </div>
          </div>

          {/* Empty dataset / missing data warning */}
          {coverage.isEmpty && (
            <div className={styles.warnBanner} role="status">
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>No source records found in {analysis.reportingPeriod.start} to {analysis.reportingPeriod.end}.</strong>{" "}
                Try expanding the period to <strong>Last 90 Days</strong>, <strong>All Available History</strong>, or a custom range within{" "}
                {earliestAvailableDate && latestAvailableDate
                  ? `${earliestAvailableDate.slice(0, 10)} to ${latestAvailableDate.slice(0, 10)}`
                  : "your dataset's date range"}.
              </div>
            </div>
          )}

          {analysis.dataQualityWarnings.length > 0 && (
            <div className={styles.warnBanner}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>Missing-data &amp; quality indicators:</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {analysis.dataQualityWarnings.map((warning, idx) => (
                    <li key={idx}>{warning}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Dynamic Domain-Specific KPI Grid (ONLY genuinely available metrics!) */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleGroup}>
                <h3 className={styles.cardTitle}>
                  <Layers size={15} /> {analysis.domainName} KPIs
                </h3>
                <p className={styles.cardSub}>
                  Showing {analysis.availableMetrics.length} calculable metric(s) from <code>{analysis.tableName}</code>. Unavailable metrics are never fabricated as zero.
                </p>
              </div>
              {analysis.unavailableMetrics.length > 0 && (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => setShowUnavailable(prev => !prev)}
                >
                  {showUnavailable ? "Hide" : "Show"} {analysis.unavailableMetrics.length} unavailable metric(s)
                </button>
              )}
            </div>

            {analysis.availableMetrics.length > 0 ? (
              <div className={styles.kpiGrid}>
                {analysis.availableMetrics.map(metric => (
                  <article key={metric.metricId} className={styles.kpiCard}>
                    <div className={styles.kpiHeader}>
                      <span className={styles.kpiName}>{metric.name}</span>
                      <span className={`${styles.badge} ${deltaToneClass(metric)}`}>
                        {metric.trendDirection === "up" && <ArrowUpRight size={11} />}
                        {metric.trendDirection === "down" && <ArrowDownRight size={11} />}
                        {metric.trendDirection === "flat" && <Minus size={11} />}
                        {metric.changePercent !== null ? formatSignedPercent(metric.changePercent) : "No ref"}
                      </span>
                    </div>
                    <strong className={styles.kpiValue}>{metric.formattedValue ?? "Unavailable"}</strong>
                    <div className={styles.kpiSub}>
                      <span>
                        {metric.formattedComparisonValue
                          ? `Ref: ${metric.formattedComparisonValue}`
                          : "No comparison baseline"}
                      </span>
                      <span>{metric.financialPositionLabel || metric.confidence}</span>
                    </div>
                    {metric.performanceLabel && metric.isLossPosition && (
                      <div className={styles.kpiSub}>
                        <span>Performance: <strong>{metric.performanceLabel}</strong></span>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.emptyBox}>
                <strong>No domain KPIs could be computed for this selection</strong>
                <p>
                  Required columns for <strong>{analysis.domainName}</strong> were not detected in <code>{analysis.tableName}</code>. Open <strong>Column Understanding</strong> above or switch to the matching business domain.
                </p>
              </div>
            )}

            {showUnavailable && analysis.unavailableMetrics.length > 0 && (
              <div className={styles.infoBanner} style={{ marginTop: 14 }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ width: "100%" }}>
                  <strong>Unavailable {analysis.domainName} Metrics ({analysis.unavailableMetrics.length})</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 11.5 }}>
                    {analysis.unavailableMetrics.map(metric => (
                      <li key={metric.metricId}>
                        <strong>{metric.name}:</strong> {metric.unavailableReason || `Missing required role(s): ${metric.missingRequiredFields.join(", ")}`}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Significant Historical Changes */}
          {significantChanges.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                  <h3 className={styles.cardTitle}>Significant Historical Changes</h3>
                  <p className={styles.cardSub}>Largest period-over-period shifts compared to {analysis.comparisonPeriod?.label || "reference period"}.</p>
                </div>
              </div>
              <div className={styles.findingsGrid}>
                {significantChanges.map(metric => (
                  <div key={`sig-${metric.metricId}`} className={`${styles.findingCard} ${deltaToneClass(metric) === styles.badgePositive ? styles.findingPositive : deltaToneClass(metric) === styles.badgeCritical ? styles.findingNegative : styles.findingEvent}`}>
                    <div className={styles.findingHead}>
                      <strong>{metric.name}</strong>
                      <span className={`${styles.badge} ${deltaToneClass(metric)}`}>
                        {formatSignedPercent(metric.changePercent)}
                      </span>
                    </div>
                    <p className={styles.findingBody}>
                      Current: <strong>{metric.formattedValue}</strong> vs Reference: <strong>{metric.formattedComparisonValue ?? "N/A"}</strong>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trend Chart & Category Breakdown Charts */}
          <div className={styles.chartsTwoCol}>
            {/* Left: Historical Trend Chart */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                  <h3 className={styles.cardTitle}>
                    <TrendingUp size={15} /> Historical Trend
                  </h3>
                  <p className={styles.cardSub}>Daily trajectory computed from backend time-series records.</p>
                </div>
                {seriesOptions.length > 1 && (
                  <select
                    aria-label="Select historical trend metric"
                    className={styles.selectInput}
                    style={{ width: "auto", minWidth: 165 }}
                    value={activeMetricKey}
                    onChange={e => setSelectedMetricKey(e.target.value)}
                  >
                    {seriesOptions.map(opt => (
                      <option key={opt.metricKey} value={opt.metricKey}>{opt.label}</option>
                    ))}
                  </select>
                )}
              </div>

              {trendChartData.length > 0 ? (
                <div className={styles.chartBox} aria-label="Historical trend chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trendChartData} margin={{ top: 10, right: 12, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="qpHistFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#5B91A3" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#5B91A3" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e4ecec" />
                      <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: "#546472" }} />
                      <YAxis tick={{ fontSize: 10.5, fill: "#546472" }} />
                      <Tooltip />
                      <Area type="monotone" dataKey="value" stroke="#2F4A63" strokeWidth={2} fill="url(#qpHistFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No time-series points available</strong>
                  <p>No dated numeric records were returned for this period.</p>
                </div>
              )}
            </div>

            {/* Right: Category & Dimension Breakdown */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                  <h3 className={styles.cardTitle}>
                    <BarChart3 size={15} /> Dimension Breakdown
                  </h3>
                  <p className={styles.cardSub}>
                    {activeBreakdown
                      ? `Top ${activeBreakdown.label} contributors from column "${activeBreakdown.sourceColumn}".`
                      : "Category and segment distribution for the selected domain."}
                  </p>
                </div>
                {breakdowns.length > 1 && (
                  <select
                    aria-label="Select breakdown dimension"
                    className={styles.selectInput}
                    style={{ width: "auto", minWidth: 165 }}
                    value={activeBreakdown?.dimensionId || ""}
                    onChange={e => setSelectedDimensionId(e.target.value)}
                  >
                    {breakdowns.map(dim => (
                      <option key={dim.dimensionId} value={dim.dimensionId}>{dim.label}</option>
                    ))}
                  </select>
                )}
              </div>

              {breakdownChartData.length > 0 ? (
                <>
                  <div className={styles.chartBox} aria-label="Dimension breakdown bar chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={breakdownChartData} layout="vertical" margin={{ top: 4, right: 16, left: 10, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e4ecec" />
                        <XAxis type="number" tick={{ fontSize: 10.5, fill: "#546472" }} />
                        <YAxis dataKey="label" type="category" width={115} tick={{ fontSize: 10.5, fill: "#2F4A63" }} />
                        <Tooltip />
                        <Bar dataKey="value" fill="#5B91A3" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className={styles.tableWrap} style={{ marginTop: 10 }}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>{activeBreakdown?.label || "Group"}</th>
                          <th className={styles.numCell}>Value</th>
                          <th className={styles.numCell}>Share</th>
                          <th className={styles.numCell}>Records</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeBreakdown?.items.slice(0, 6).map(item => (
                          <tr key={item.label}>
                            <td><strong>{item.label}</strong></td>
                            <td className={styles.numCell}>{item.primaryValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className={styles.numCell}>{item.sharePercent !== null ? `${item.sharePercent.toFixed(1)}%` : "—"}</td>
                            <td className={styles.numCell}>{item.recordCount.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className={styles.emptyBox}>
                  <strong>No categorical breakdown available</strong>
                  <p>No supported categorical columns were detected or populated for this period.</p>
                </div>
              )}
            </div>
          </div>

          {/* Domain-specific extras (CRM RFM or Inventory Reorder Alerts) */}
          {rfmSegments.length > 0 && (
            <div className={styles.card}>
              <h3 className={styles.cardTitle} style={{ marginBottom: 10 }}>CRM RFM Customer Segments</h3>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Segment</th>
                      <th className={styles.numCell}>Customers</th>
                      <th className={styles.numCell}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rfmSegments.map((seg, idx) => (
                      <tr key={idx}>
                        <td><strong>{seg.segment}</strong></td>
                        <td className={styles.numCell}>{seg.customerCount.toLocaleString()}</td>
                        <td className={styles.numCell}>{seg.sharePercent !== undefined ? `${seg.sharePercent.toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reorderAlerts.length > 0 && (
            <div className={styles.card}>
              <h3 className={styles.cardTitle} style={{ marginBottom: 10 }}>Inventory Reorder Priority Watchlist</h3>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Warehouse</th>
                      <th className={styles.numCell}>Stock on Hand</th>
                      <th className={styles.numCell}>Reorder Point</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reorderAlerts.slice(0, 10).map((item, idx) => (
                      <tr key={`${item.sku}-${idx}`}>
                        <td><strong>{item.sku}</strong></td>
                        <td>{item.warehouse || "—"}</td>
                        <td className={styles.numCell}>{item.stockOnHand.toLocaleString()}</td>
                        <td className={styles.numCell}>{item.reorderPoint.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!loading && !analysis && !error && (
        <div className={styles.emptyBox}>
          <strong>Select a connected dataset to load the Historical Dashboard</strong>
          <p>Historical metrics, trend charts, and breakdowns load automatically once a readable table or view is selected.</p>
        </div>
      )}
    </section>
  );
}
