"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Bell,
  BellOff,
  CalendarDays,
  CheckCheck,
  CheckCircle2,
  Clock,
  Database,
  DollarSign,
  Download,
  FileSpreadsheet,
  Info,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  TrendingUp,
  type LucideIcon
} from "lucide-react";
import type { AnalysisDimension, AnalysisReport } from "../types";
import type { AnalysisSettings } from "../settings";
import { detectDatasetColumns, type DatasetMapping } from "../database/dataset-mapping";
import {
  DEFAULT_ALERT_RULES,
  evaluateReportAlerts,
  mergeAlerts,
  sanitizeAlertRules,
  type AlertRules,
  type AlertSeverity,
  type DailyReportAlert
} from "../notifications";
import { buildReportCsv, csvFilename } from "../export-csv";
import type { Table } from "../../src/lib/database";
import styles from "./DailyAnalysisNotifications.module.css";

type Props = { onBack: () => void };
type DayMode = "daily" | "weekly" | "monthly" | "manual";
type AlertFilter = "all" | "unread" | "issues" | "positive";

const ALERTS_STORAGE_KEY = "querypilot.dailyAlerts";
const ALERT_RULES_STORAGE_KEY = "querypilot.dailyAlertRules";

const mappingFields = [
  ["orderId", "Order ID"], ["orderDate", "Order date"], ["product", "Product"], ["category", "Category"],
  ["quantity", "Quantity"], ["revenue", "Revenue / price"], ["cost", "Cost"], ["profit", "Profit"], ["discount", "Discount"],
  ["status", "Order status"], ["gender", "Customer gender"], ["region", "Region"], ["rating", "Customer rating"]
] as const;

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const displayMetric = (report: AnalysisReport, key: string, value: string) => !report.availableMetrics || report.availableMetrics.includes(key) ? value : "Unavailable";

function currentClockInTimezone(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date()).reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
    const hour = (parts.hour === "24" ? "00" : parts.hour || "00").padStart(2, "0");
    const minute = (parts.minute || "00").padStart(2, "0");
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${minute}` };
  } catch {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return { date, time };
  }
}

function MiniBars({ title, items, valueKey }: { title: string; items: AnalysisDimension[]; valueKey: "revenue" | "orders" | "units" }) {
  const max = Math.max(...items.map(item => item[valueKey]), 1);
  return <section className="analysis-card chart-card"><h2>{title}</h2>{items.length ? items.slice(0, 8).map(item => (
    <div className="bar-row" key={item.label}><span title={item.label}>{item.label}</span><div><i style={{ width: `${Math.max((item[valueKey] / max) * 100, 2)}%` }}/></div><b>{valueKey === "revenue" ? money(item[valueKey]) : number(item[valueKey])}</b></div>
  )) : <p className="analysis-empty">No completed records in this period.</p>}</section>;
}

function AlertSeverityIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "critical") return <AlertCircle size={15} className={`${styles.alertIcon} ${styles.iconCritical}`}/>;
  if (severity === "warning") return <AlertTriangle size={15} className={`${styles.alertIcon} ${styles.iconWarning}`}/>;
  if (severity === "positive") return <CheckCircle2 size={15} className={`${styles.alertIcon} ${styles.iconPositive}`}/>;
  return <Info size={15} className={`${styles.alertIcon} ${styles.iconInfo}`}/>;
}

function alertSeverityClass(severity: AlertSeverity) {
  if (severity === "critical") return styles.severityCritical;
  if (severity === "warning") return styles.severityWarning;
  if (severity === "positive") return styles.severityPositive;
  return styles.severityInfo;
}

export default function DailyAnalysisDashboard({ onBack }: Props) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [history, setHistory] = useState<AnalysisReport[]>([]);
  const [dayMode, setDayMode] = useState<DayMode>("daily");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedTime, setSelectedTime] = useState("00:15");
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfBusyId, setPdfBusyId] = useState<number | null>(null);
  const [pdfMessage, setPdfMessage] = useState("");
  const [settings, setSettings] = useState<AnalysisSettings>({ comparisonDays: 30, timezone: "Asia/Dhaka", dailyReportEnabled: true, notificationEnabled: true, scheduledTime: "00:15" });
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<DailyReportAlert[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRules>(DEFAULT_ALERT_RULES);
  const [draftRules, setDraftRules] = useState<AlertRules>(DEFAULT_ALERT_RULES);
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("all");
  const lastAutoRunRef = useRef<string>("");
  const armedScheduleRef = useRef<{ date: string; time: string; armedAt: string } | null>(null);
  const alertRulesRef = useRef<AlertRules>(DEFAULT_ALERT_RULES);

  function persistAlerts(nextAlerts: DailyReportAlert[]) {
    setAlerts(nextAlerts);
    try { localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(nextAlerts)); } catch { /* ignore storage quota */ }
  }

  function evaluateAndRecordAlerts(targetReport: AnalysisReport, rulesOverride?: AlertRules) {
    const activeRules = rulesOverride || alertRulesRef.current;
    const generated = evaluateReportAlerts(targetReport, activeRules);
    if (!generated.length) return;
    setAlerts(prev => {
      const next = mergeAlerts(prev, generated, 50);
      try { localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore storage quota */ }
      return next;
    });
  }

  function toggleAlertRead(alertId: string) {
    persistAlerts(alerts.map(item => item.id === alertId ? { ...item, isRead: !item.isRead } : item));
  }

  function markAllAlertsRead() {
    persistAlerts(alerts.map(item => ({ ...item, isRead: true })));
  }

  function clearReadAlerts() {
    persistAlerts(alerts.filter(item => !item.isRead));
  }

  function handleSaveAlertRules() {
    const cleaned = sanitizeAlertRules(draftRules);
    setAlertRules(cleaned);
    setDraftRules(cleaned);
    alertRulesRef.current = cleaned;
    try { localStorage.setItem(ALERT_RULES_STORAGE_KEY, JSON.stringify(cleaned)); } catch { /* ignore */ }
    const updatedSettings: AnalysisSettings = { ...settings, notificationEnabled: cleaned.enabled };
    setSettings(updatedSettings);
    try { localStorage.setItem("querypilot.dailySettings", JSON.stringify(updatedSettings)); } catch { /* ignore */ }
    if (report) {
      if (cleaned.enabled) {
        const fresh = evaluateReportAlerts(report, cleaned);
        const currentReportKey = report.generationKey || `${report.reportKind}|${report.periodStart}|${report.periodEnd}`;
        const otherReportAlerts = alerts.filter(item => item.reportKey !== currentReportKey);
        persistAlerts(mergeAlerts(otherReportAlerts, fresh, 50));
      } else {
        setPdfMessage("Daily alert notifications paused.");
      }
    }
    setRulesOpen(false);
    if (cleaned.enabled) setPdfMessage("Alert rules saved and applied to the current report.");
  }

  function downloadCsv(target: AnalysisReport) {
    setError("");
    try {
      const csv = buildReportCsv(target);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = csvFilename(target);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setPdfMessage("CSV export downloaded.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export CSV.");
    }
  }

  async function loadHistory() {
    try { setHistory(JSON.parse(localStorage.getItem("querypilot.dailyReports") || "[]")); } catch { setHistory([]); }
  }

  async function loadTables() {
    const response = await fetch("/api/tables", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load Supabase tables.");
    const availableTables = (data.tables || []) as Table[];
    setTables(availableTables);
    if (!availableTables.length) {
      setError("No readable public tables were found in the connected Supabase project.");
      return;
    }
    const saved = localStorage.getItem("querypilot.dailyDataset");
    let selected: { table?: string; mapping?: Record<string, string> } = {};
    if (saved) try { selected = JSON.parse(saved); } catch { selected = {}; }
    const table = availableTables.find(item => item.name === selected.table)
      || availableTables.find(item => item.name === "daily_sales_orders")
      || availableTables.find(item => {
        const detected = detectDatasetColumns(item);
        return Boolean(detected.orderId && detected.orderDate);
      })
      || availableTables[0];
    if (table) {
      setSelectedTable(table.name);
      if (selected.table === table.name && selected.mapping) {
        const validMapping = Object.fromEntries(
          Object.entries(selected.mapping).filter(([, col]) => typeof col === "string" && table.columns.includes(col))
        );
        setMapping(validMapping);
      } else {
        setMapping({});
      }
    }
  }

  function buildPayload(mode: DayMode) {
    if (mode === "weekly") return { kind: "historical", range: "week" };
    if (mode === "monthly") return { kind: "historical", range: "month" };
    if (mode === "manual") return { kind: "historical", range: "custom", start: customStart, end: customEnd };
    return { comparisonDays: settings.comparisonDays || 30 };
  }

  async function generate(modeOverride?: DayMode, scheduledAt?: string) {
    const activeMode = modeOverride || dayMode;
    if (activeMode === "manual" && (!/^\d{4}-\d{2}-\d{2}$/.test(customStart) || !/^\d{4}-\d{2}-\d{2}$/.test(customEnd) || customStart > customEnd)) {
      setError("Select a valid start date and end date for Manual mode.");
      return;
    }
    setBusy(true); setError("");
    try {
      if (!selectedTable) throw new Error("Select a Supabase table before generating a report.");
      const dataset = { table: selectedTable, mapping };
      localStorage.setItem("querypilot.dailyDataset", JSON.stringify(dataset));
      const payload = { ...buildPayload(activeMode), dataset };
      const response = await fetch("/api/daily-analysis/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not generate report.");
      const generatedReport: AnalysisReport = scheduledAt
        ? { ...data.report, generationKey: `${data.report.generationKey || data.report.reportingDate}|scheduled|${scheduledAt}|${Date.now()}` }
        : data.report;
      setReport(generatedReport);
      evaluateAndRecordAlerts(generatedReport);
      setHistory(prev => {
        const nextHistory = [generatedReport, ...prev.filter(item => item.generationKey !== generatedReport.generationKey)].slice(0, 20);
        try { localStorage.setItem("querypilot.dailyReports", JSON.stringify(nextHistory)); } catch { /* ignore storage quota */ }
        return nextHistory;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate report.");
    } finally { setBusy(false); }
  }

  function handleDayModeChange(nextMode: DayMode) {
    setDayMode(nextMode);
    setError("");
    if (nextMode !== "manual" && selectedTable && hasRequiredColumns) {
      void generate(nextMode);
    }
  }

  function handleTimeChange(nextTime: string) {
    setSelectedTime(nextTime);
    lastAutoRunRef.current = "";
    const now = currentClockInTimezone(settings.timezone || "Asia/Dhaka");
    armedScheduleRef.current = nextTime ? { date: now.date, time: nextTime, armedAt: now.time } : null;
    const updated: AnalysisSettings = { ...settings, scheduledTime: nextTime, dailyReportEnabled: true };
    setSettings(updated);
    try { localStorage.setItem("querypilot.dailySettings", JSON.stringify(updated)); } catch { /* ignore */ }
    setScheduleStatus(nextTime ? `Scheduled at ${nextTime} (${updated.timezone || "Asia/Dhaka"})` : "");
  }

  async function downloadPdf(target: AnalysisReport) {
    const busyKey = target.id || -1;
    setPdfBusyId(busyKey);
    setPdfMessage("");
    setError("");
    try {
      const downloadResponse = await fetch(`/api/daily-analysis/reports/${target.id || 1}/pdf`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
      if (!downloadResponse.ok) throw new Error((await downloadResponse.json()).error || "Could not download the PDF.");
      const blob = await downloadResponse.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const filename = `querypilot-x-report-${target.reportKind}-${target.periodStart}-to-${target.periodEnd}.pdf`;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      const generatedAt = new Date().toISOString();
      setReport(current => current && current.generationKey === target.generationKey ? { ...current, pdfStatus: "generated", pdfFilename: filename, pdfGeneratedAt: generatedAt } : current);
      setHistory(prev => {
        const nextHistory = prev.map(item => item.generationKey === target.generationKey ? { ...item, pdfStatus: "generated" as const, pdfFilename: filename, pdfGeneratedAt: generatedAt } : item);
        try { localStorage.setItem("querypilot.dailyReports", JSON.stringify(nextHistory)); } catch { /* ignore */ }
        return nextHistory;
      });
      setPdfMessage("PDF download completed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not download the PDF.");
    } finally {
      setPdfBusyId(null);
    }
  }

  useEffect(() => {
    const savedSettings = localStorage.getItem("querypilot.dailySettings");
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings) as AnalysisSettings;
        setSettings(parsed);
        if (parsed.scheduledTime) {
          setSelectedTime(parsed.scheduledTime);
          setScheduleStatus(`Scheduled at ${parsed.scheduledTime} (${parsed.timezone || "Asia/Dhaka"})`);
        }
      } catch { /* use defaults */ }
    }
    const savedRules = localStorage.getItem(ALERT_RULES_STORAGE_KEY);
    if (savedRules) {
      try {
        const parsedRules = sanitizeAlertRules(JSON.parse(savedRules) as Partial<AlertRules>);
        setAlertRules(parsedRules);
        setDraftRules(parsedRules);
        alertRulesRef.current = parsedRules;
      } catch { /* use defaults */ }
    }
    const savedAlerts = localStorage.getItem(ALERTS_STORAGE_KEY);
    if (savedAlerts) {
      try {
        const parsedAlerts = JSON.parse(savedAlerts) as DailyReportAlert[];
        if (Array.isArray(parsedAlerts)) setAlerts(parsedAlerts);
      } catch { /* ignore */ }
    }
    void Promise.all([loadTables(), loadHistory()]).catch(reason => setError(reason instanceof Error ? reason.message : "Could not load Supabase data."));
  }, []);

  const currentTable = useMemo(() => tables.find(table => table.name === selectedTable), [tables, selectedTable]);
  const autoMapping = useMemo<Partial<DatasetMapping>>(() => currentTable ? detectDatasetColumns(currentTable) : {}, [currentTable]);
  const hasRequiredColumns = Boolean((mapping.orderId || autoMapping.orderId) && (mapping.orderDate || autoMapping.orderDate));
  const customManualRangeValid = dayMode !== "manual" || (/^\d{4}-\d{2}-\d{2}$/.test(customStart) && /^\d{4}-\d{2}-\d{2}$/.test(customEnd) && customStart <= customEnd);

  useEffect(() => {
    if (selectedTable && !report && hasRequiredColumns) void generate("daily");
  }, [selectedTable, hasRequiredColumns]);

  useEffect(() => {
    if (!selectedTime || !selectedTable || !hasRequiredColumns) return;
    const checkSchedule = () => {
      const now = currentClockInTimezone(settings.timezone || "Asia/Dhaka");
      const slot = `${now.date}|${selectedTime}`;
      const isExactMinute = now.time === selectedTime;
      const passedWhileTabHidden = Boolean(
        armedScheduleRef.current
        && armedScheduleRef.current.date === now.date
        && armedScheduleRef.current.time === selectedTime
        && armedScheduleRef.current.armedAt <= selectedTime
        && now.time > selectedTime
      );
      if ((isExactMinute || passedWhileTabHidden) && lastAutoRunRef.current !== slot) {
        lastAutoRunRef.current = slot;
        armedScheduleRef.current = null;
        setScheduleStatus(`Auto-generated at ${now.time} (${now.date})`);
        void generate(undefined, now.time);
      }
    };
    checkSchedule();
    const timer = window.setInterval(checkSchedule, 1000);
    window.addEventListener("focus", checkSchedule);
    document.addEventListener("visibilitychange", checkSchedule);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkSchedule);
      document.removeEventListener("visibilitychange", checkSchedule);
    };
  }, [selectedTime, selectedTable, hasRequiredColumns, settings.timezone, dayMode, customStart, customEnd, mapping]);

  const comparison = report?.comparisonDailyAverage;
  const revenueAvailable = !report?.availableMetrics || report.availableMetrics.includes("totalRevenue");
  const change = useMemo(() => revenueAvailable && report && comparison && comparison.totalRevenue ? ((report.current.totalRevenue - comparison.totalRevenue) / comparison.totalRevenue) * 100 : null, [revenueAvailable, report, comparison]);
  const unreadAlertsCount = useMemo(() => alerts.filter(item => !item.isRead).length, [alerts]);
  const filteredAlerts = useMemo(() => {
    if (alertFilter === "unread") return alerts.filter(item => !item.isRead);
    if (alertFilter === "issues") return alerts.filter(item => item.severity === "critical" || item.severity === "warning");
    if (alertFilter === "positive") return alerts.filter(item => item.severity === "positive" || item.severity === "info");
    return alerts;
  }, [alerts, alertFilter]);
  const dailyTrendMaxRevenue = useMemo(() => Math.max(...(report?.dailyPerformance || []).map(day => day.totalRevenue), 1), [report]);

  return <div className="analysis-dashboard">
    <div className="analysis-toolbar">
      <button className="back-button" onClick={onBack}>Back to workspace</button>
      <div className="analysis-toolbar-actions">
        <span className="connection-status" title="Read-only Supabase connection"><ShieldCheck size={14}/> Read-only Supabase{selectedTable ? ` · ${selectedTable}` : ""}</span>
        <button className={`secondary-button ${styles.alertButton}`} onClick={() => setAlertsOpen(!alertsOpen)}>
          {alertRules.enabled ? <Bell size={14}/> : <BellOff size={14}/>} Alerts
          {unreadAlertsCount > 0 && <span className={styles.unreadBadge}>{unreadAlertsCount}</span>}
        </button>
        <button className="secondary-button" onClick={() => setDatasetOpen(!datasetOpen)}><SlidersHorizontal size={14}/> Dataset</button>
        <button className="secondary-button" disabled={busy || pdfBusyId !== null || !selectedTable || !customManualRangeValid} onClick={() => void generate()}><RefreshCw size={14} className={busy ? "spinning" : ""}/> Refresh</button>
        {report && <button className="secondary-button" disabled={busy} onClick={() => downloadCsv(report)}><FileSpreadsheet size={14}/> Export CSV</button>}
        {report && <button className="secondary-button" disabled={busy || pdfBusyId !== null} onClick={() => void downloadPdf(report)}><Download size={14}/>{pdfBusyId === (report.id || -1) ? "Generating PDF..." : "Download PDF"}</button>}
      </div>
    </div>

    <div className="section-heading"><div><div className="section-eyebrow">DAILY ANALYSIS & REPORTS</div><h1>Performance at a glance.</h1><p>Completed orders are recognized; other statuses remain visible separately.</p></div></div>

    <div className="report-controls">
      <label>
        <CalendarDays size={14}/> Select day
        <select aria-label="Select day" value={dayMode} onChange={event => handleDayModeChange(event.target.value as DayMode)} disabled={busy || !selectedTable}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="manual">Manual</option>
        </select>
      </label>

      {dayMode === "manual" && <>
        <input className="days-input" type="date" value={customStart} onChange={event => setCustomStart(event.target.value)} aria-label="Manual start date"/>
        <input className="days-input" type="date" value={customEnd} onChange={event => setCustomEnd(event.target.value)} aria-label="Manual end date"/>
        <button className="secondary-button" disabled={busy || !selectedTable || !customManualRangeValid} onClick={() => void generate("manual")}>Apply</button>
      </>}

      <label>
        <Clock size={14}/> Select time
        <input className="settings-input" type="time" aria-label="Select time" value={selectedTime} onChange={event => handleTimeChange(event.target.value)}/>
      </label>
      {scheduleStatus && <span className="schedule-badge">{scheduleStatus}</span>}
    </div>

    {alertsOpen && <section className={`analysis-card ${styles.panel}`}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>
          {alertRules.enabled ? <Bell size={15}/> : <BellOff size={15}/>}
          <h2>Daily Alerts & Notifications</h2>
          <span className={styles.panelSubtitle}>
            {alertRules.enabled
              ? unreadAlertsCount > 0 ? `${unreadAlertsCount} unread` : "All caught up"
              : "Paused"}
          </span>
        </div>
        <div className={styles.panelActions}>
          <button className="secondary-button" onClick={() => { setDraftRules(alertRules); setRulesOpen(!rulesOpen); }}>
            <Settings2 size={13}/> Alert rules
          </button>
          {unreadAlertsCount > 0 && (
            <button className="secondary-button" onClick={markAllAlertsRead}>
              <CheckCheck size={13}/> Mark all read
            </button>
          )}
          {alerts.some(item => item.isRead) && (
            <button className="secondary-button" onClick={clearReadAlerts}>
              <Trash2 size={13}/> Clear read
            </button>
          )}
        </div>
      </div>

      {rulesOpen && <div className={styles.rulesBox}>
        <div className={styles.rulesHeader}>
          <strong>KPI Alert Thresholds</strong>
          <label className={styles.ruleCheckbox}>
            <input
              type="checkbox"
              checked={draftRules.enabled}
              onChange={event => setDraftRules({ ...draftRules, enabled: event.target.checked })}
            />
            Enable automatic KPI alerts
          </label>
        </div>
        <div className={styles.rulesGrid}>
          <label className={styles.ruleField}>
            Revenue drop warning (%)
            <input
              className={styles.ruleInput}
              type="number"
              min={1}
              max={100}
              value={draftRules.revenueDropPercent}
              onChange={event => setDraftRules({ ...draftRules, revenueDropPercent: Number(event.target.value) })}
            />
          </label>
          <label className={styles.ruleField}>
            Revenue surge highlight (%)
            <input
              className={styles.ruleInput}
              type="number"
              min={1}
              max={500}
              value={draftRules.revenueGrowthPercent}
              onChange={event => setDraftRules({ ...draftRules, revenueGrowthPercent: Number(event.target.value) })}
            />
          </label>
          <label className={styles.ruleField}>
            Min profit margin (%)
            <input
              className={styles.ruleInput}
              type="number"
              min={0}
              max={100}
              value={draftRules.minProfitMarginPercent}
              onChange={event => setDraftRules({ ...draftRules, minProfitMarginPercent: Number(event.target.value) })}
            />
          </label>
          <label className={styles.ruleField}>
            Max cancel / return rate (%)
            <input
              className={styles.ruleInput}
              type="number"
              min={1}
              max={100}
              value={draftRules.maxCancellationRatePercent}
              onChange={event => setDraftRules({ ...draftRules, maxCancellationRatePercent: Number(event.target.value) })}
            />
          </label>
          <label className={styles.ruleField}>
            Min customer rating (1–5)
            <input
              className={styles.ruleInput}
              type="number"
              min={1}
              max={5}
              step={0.1}
              value={draftRules.minCustomerRating}
              onChange={event => setDraftRules({ ...draftRules, minCustomerRating: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className={styles.ruleToggles}>
          <label className={styles.ruleCheckbox}>
            <input
              type="checkbox"
              checked={draftRules.alertOnZeroRevenue}
              onChange={event => setDraftRules({ ...draftRules, alertOnZeroRevenue: event.target.checked })}
            />
            Alert on zero-sales periods
          </label>
          <label className={styles.ruleCheckbox}>
            <input
              type="checkbox"
              checked={draftRules.highlightTopPerformer}
              onChange={event => setDraftRules({ ...draftRules, highlightTopPerformer: event.target.checked })}
            />
            Highlight top performing product
          </label>
        </div>
        <div className={styles.rulesFooter}>
          <button className="secondary-button" onClick={() => setRulesOpen(false)}>Cancel</button>
          <button className="secondary-button" onClick={handleSaveAlertRules}>Save &amp; apply</button>
        </div>
      </div>}

      <div className={styles.filterBar}>
        {([
          ["all", `All (${alerts.length})`],
          ["unread", `Unread (${unreadAlertsCount})`],
          ["issues", "Warnings & Critical"],
          ["positive", "Highlights"]
        ] as Array<[AlertFilter, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`${styles.filterChip} ${alertFilter === value ? styles.filterChipActive : ""}`}
            onClick={() => setAlertFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {filteredAlerts.length ? <div className={styles.alertList}>
        {filteredAlerts.slice(0, 10).map(alert => (
          <div
            key={alert.id}
            className={`${styles.alertItem} ${alertSeverityClass(alert.severity)} ${alert.isRead ? styles.alertRead : styles.alertUnread}`}
          >
            <div className={styles.alertBody}>
              <AlertSeverityIcon severity={alert.severity}/>
              <div className={styles.alertContent}>
                <div className={styles.alertTopLine}>
                  <strong>{alert.title}</strong>
                  <span className={styles.metricPill}>{alert.metricLabel}: {alert.metricValue}</span>
                </div>
                <p className={styles.alertMessage}>{alert.message}</p>
                <div className={styles.alertMeta}>
                  Period: {alert.periodLabel} · {new Date(alert.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
            <button type="button" className={styles.alertAction} onClick={() => toggleAlertRead(alert.id)}>
              {alert.isRead ? "Mark unread" : "Mark read"}
            </button>
          </div>
        ))}
      </div> : <p className="analysis-empty">
        {alerts.length ? "No alerts match this filter." : "Alerts will appear here automatically after a report is generated."}
      </p>}
    </section>}

    {(datasetOpen || (selectedTable && !hasRequiredColumns)) && <section className="analysis-card settings-card">
      <div className="card-title"><h2>Supabase dataset & column mapping</h2><span>Read-only table selection</span></div>
      <div className="report-controls">
        <label>Supabase table <select value={selectedTable} onChange={event => { setSelectedTable(event.target.value); setMapping({}); setError(""); setReport(null); }}><option value="">Select a table</option>{tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
        {mappingFields.map(([key, label]) => selectedTable && (
          <label key={key}>{label} <select value={mapping[key] || ""} onChange={event => setMapping({ ...mapping, [key]: event.target.value })}>
            <option value="">{autoMapping[key] ? `Auto (${autoMapping[key]})` : "Automatic / unavailable"}</option>
            {currentTable?.columns.map(column => <option key={column} value={column}>{column}</option>)}
          </select></label>
        ))}
        <button className="secondary-button" disabled={busy || !selectedTable || !hasRequiredColumns} onClick={() => { setDatasetOpen(false); void generate(); }}>Apply dataset</button>
      </div>
    </section>}

    {selectedTable && !hasRequiredColumns && !error && <div className="analysis-empty-panel">Select the <strong>Order ID</strong> and <strong>Order date</strong> columns above, then click <strong>Apply dataset</strong>.</div>}
    {error && <div className="analysis-error">{error}</div>}
    {pdfMessage && <div className="pdf-status">{pdfMessage}</div>}
    {!report && !error && hasRequiredColumns && <div className="analysis-empty-panel">Loading read-only Supabase records...</div>}
    {report && <>
      <div className="report-meta">
        <CalendarDays size={15}/> Reporting date: <strong>{report.reportingDate}</strong>
        <span>Period: {report.periodStart} to {report.periodEnd}</span>
        {report.comparisonStart && <span>Comparison: {report.comparisonStart} to {report.comparisonEnd} ({report.comparisonDays} days)</span>}
        <span><Database size={13}/> Table: <strong>{report.dataset?.table || selectedTable}</strong></span>
      </div>
      <div className="analysis-stat-grid">{([
        ["Revenue", "totalRevenue", money(report.current.totalRevenue), DollarSign],
        ["Orders", "totalOrders", number(report.current.totalOrders), BarChart3],
        ["Units sold", "totalUnitsSold", number(report.current.totalUnitsSold), Activity],
        ["Product lines", "totalProductLines", number(report.current.totalProductLines), BarChart3],
        ["Gross profit", "grossProfit", money(report.current.grossProfit), TrendingUp],
        ["Profit margin", "grossProfitMargin", `${number(report.current.grossProfitMargin)}%`, TrendingUp],
        ["Discounts", "totalDiscounts", money(report.current.totalDiscounts), DollarSign],
        ["Avg. order value", "averageOrderValue", money(report.current.averageOrderValue), DollarSign],
        ["Avg. rating", "averageCustomerRating", report.current.averageCustomerRating === null ? "—" : number(report.current.averageCustomerRating), Star]
      ] as Array<[string, string, string, LucideIcon]>).map(([label, key, value, Icon]) => <div className="analysis-stat" key={label}><Icon size={16}/><span>{label}</span><strong>{displayMetric(report, key, value)}</strong></div>)}</div>
      {report.availableMetrics && report.availableMetrics.length < 9 && <div className="analysis-empty">Some KPIs are unavailable because the selected Supabase table does not provide those columns.</div>}
      {change !== null && <div className={"comparison-note " + (change >= 0 ? "positive" : "negative")}>{change >= 0 ? "Growth" : "Decline"} of {Math.abs(change).toFixed(1)}% revenue versus the comparison daily average.</div>}
      <div className="analysis-grid"><section className="analysis-card"><h2>Order status distribution</h2>{Object.entries(report.current.statusDistribution).map(([label, value]) => <div className="status-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section></div>
      {report.dailyPerformance.length > 1 && <section className="analysis-card" style={{ marginBottom: 16 }}>
        <h2>Daily performance breakdown ({report.dailyPerformance.length} days)</h2>
        <div className={styles.trendTableWrap}>
          <table className={styles.trendTable}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Revenue trend</th>
                <th className={styles.numericCell}>Revenue</th>
                <th className={styles.numericCell}>Orders</th>
                <th className={styles.numericCell}>Units</th>
                <th className={styles.numericCell}>Gross profit</th>
                <th className={styles.numericCell}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {report.dailyPerformance.map(day => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>
                    <div className={styles.trendBarTrack}>
                      <div className={styles.trendBarFill} style={{ width: `${revenueAvailable && day.totalRevenue > 0 ? Math.max((day.totalRevenue / dailyTrendMaxRevenue) * 100, 3) : 0}%` }}/>
                    </div>
                  </td>
                  <td className={styles.numericCell}>{displayMetric(report, "totalRevenue", money(day.totalRevenue))}</td>
                  <td className={styles.numericCell}>{displayMetric(report, "totalOrders", number(day.totalOrders))}</td>
                  <td className={styles.numericCell}>{displayMetric(report, "totalUnitsSold", number(day.totalUnitsSold))}</td>
                  <td className={styles.numericCell}>{displayMetric(report, "grossProfit", money(day.grossProfit))}</td>
                  <td className={styles.numericCell}>{displayMetric(report, "grossProfitMargin", `${number(day.grossProfitMargin)}%`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>}
      <div className="analysis-grid"><MiniBars title="Product performance" items={report.productPerformance} valueKey="revenue"/><MiniBars title="Category performance" items={report.categoryPerformance} valueKey="revenue"/><MiniBars title="Region performance" items={report.regionPerformance} valueKey="revenue"/><MiniBars title="Gender performance" items={report.genderPerformance} valueKey="orders"/></div>
      <section className="analysis-card history-card"><h2>Report history</h2>{history.length ? history.map((item, index) => <div className="history-entry" key={item.generationKey || item.id || index}><button onClick={() => setReport(item)}><span>{item.reportKind} · {item.reportingDate}{item.dataset?.table ? ` (${item.dataset.table})` : ""}{item.generationKey?.includes("|scheduled|") ? " · Scheduled" : ""}</span><small>{item.periodStart} to {item.periodEnd} · {new Date(item.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {item.status} · PDF: {item.pdfStatus === "generated" ? "ready" : item.pdfStatus === "failed" ? "failed" : "not generated"}</small></button><button className="history-download" disabled={pdfBusyId !== null} onClick={() => void downloadPdf(item)}><Download size={13}/>{pdfBusyId === (item.id || -1) ? "Generating..." : item.pdfStatus === "generated" ? "PDF" : "Generate PDF"}</button></div>) : <p className="analysis-empty">No generated reports yet.</p>}</section>
    </>}
  </div>;
}
