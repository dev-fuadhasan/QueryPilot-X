"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
  CalendarClock,
  Clock,
  FileSpreadsheet,
  TrendingUp
} from "lucide-react";
import type { BusinessDomainId, DatabaseProfile } from "../profiler/types";
import type { ComparisonPreset, DynamicAnalysisResult } from "../metrics/types";
import type { ReportArchiveComparisonResult, UnifiedDailyAnalysisResult } from "../intelligence/types";
import { DEFAULT_ALERT_RULES, sanitizeAlertRules, type AlertRules } from "../notifications";
import type {
  ManualQuickRange,
  PersistentDailySettings,
  PersistentReportRecord,
  PersistentReportSummary,
  ReportFrequency,
  ReportHistoryStorageState,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";
import {
  buildReportHistoryQueryString,
  createStaleResetSnapshot,
  DEFAULT_REPORT_HISTORY_FILTERS,
  formatShortTimestamp,
  mergeToolAlertsWithReadState,
  type DashboardSectionTab,
  type ReportHistoryFilterState
} from "./dashboard-helpers";
import DomainDatasetBar from "./DomainDatasetBar";
import DailyReportPanel from "./DailyReportPanel";
import ManualReportPanel from "./ManualReportPanel";
import DailyToolsSection from "./DailyToolsSection";
import HistoricalDashboardPanel from "./HistoricalDashboardPanel";
import ReportHistoryPanel, { type ReportHistoryPagination } from "./ReportHistoryPanel";
import styles from "./DailyAnalysisDashboard.module.css";

type Props = { onBack: () => void };

const READ_ALERTS_KEY = "querypilot.dailyAnalysis.readAlertIds";

function loadReadAlertIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_ALERTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadAlertIds(ids: Set<string>) {
  try {
    localStorage.setItem(READ_ALERTS_KEY, JSON.stringify(Array.from(ids).slice(-200)));
  } catch {
    // ignore quota errors
  }
}

const DEFAULT_PAGINATION: ReportHistoryPagination = {
  total: 0,
  page: 1,
  pageSize: DEFAULT_REPORT_HISTORY_FILTERS.pageSize,
  totalPages: 1,
  appliedStartDate: null,
  appliedEndDate: null
};

export default function DailyAnalysisDashboard({ onBack }: Props) {
  const [activeTab, setActiveTab] = useState<DashboardSectionTab>("daily_report");
  const [selectedDomain, setSelectedDomain] = useState<BusinessDomainId>("sales_ecommerce");
  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});
  const [comparisonPreset, setComparisonPreset] = useState<ComparisonPreset>("previous_day");

  const [profile, setProfile] = useState<DatabaseProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState<boolean>(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [settings, setSettings] = useState<PersistentDailySettings | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageCapabilityStatus | null>(null);
  const [scheduleSummary, setScheduleSummary] = useState<ScheduleRuntimeSummary | null>(null);
  const [loadingSettings, setLoadingSettings] = useState<boolean>(true);
  const [savingSchedule, setSavingSchedule] = useState<boolean>(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Unified Daily Intelligence state (7 Daily Analysis Tools)
  const [intelligence, setIntelligence] = useState<UnifiedDailyAnalysisResult | null>(null);
  const [loadingIntelligence, setLoadingIntelligence] = useState<boolean>(false);
  const [intelligenceError, setIntelligenceError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  // Stage 7 Dynamic 30-Day Historical Dashboard state
  const [historicalRange, setHistoricalRange] = useState<ManualQuickRange>("last_30_days");
  const [historicalCustomStart, setHistoricalCustomStart] = useState<string>("");
  const [historicalCustomEnd, setHistoricalCustomEnd] = useState<string>("");
  const [historicalAnalysis, setHistoricalAnalysis] = useState<DynamicAnalysisResult | null>(null);
  const [loadingHistorical, setLoadingHistorical] = useState<boolean>(false);
  const [historicalError, setHistoricalError] = useState<string | null>(null);
  const [historicalRefreshedAt, setHistoricalRefreshedAt] = useState<string | null>(null);

  // Manual Report state
  const [generatingManual, setGeneratingManual] = useState<boolean>(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<PersistentReportRecord | null>(null);

  // Stage 7 Complete Report History & Comparison state
  const [historyFilters, setHistoryFilters] = useState<ReportHistoryFilterState>(DEFAULT_REPORT_HISTORY_FILTERS);
  const [archivedReports, setArchivedReports] = useState<PersistentReportSummary[]>([]);
  const [historyPagination, setHistoryPagination] = useState<ReportHistoryPagination>(DEFAULT_PAGINATION);
  const [loadingArchive, setLoadingArchive] = useState<boolean>(false);
  const [historyStorageState, setHistoryStorageState] = useState<ReportHistoryStorageState>("ready");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [archiveComparison, setArchiveComparison] = useState<ReportArchiveComparisonResult | null>(null);
  const [comparingArchive, setComparingArchive] = useState<boolean>(false);
  const [archiveCompareError, setArchiveCompareError] = useState<string | null>(null);
  const [inspectedReport, setInspectedReport] = useState<PersistentReportRecord | null>(null);
  const [loadingInspect, setLoadingInspect] = useState<boolean>(false);

  const [readAlertIds, setReadAlertIds] = useState<Set<string>>(() => new Set());
  const [savingAlertRules, setSavingAlertRules] = useState<boolean>(false);
  const [downloadingReportId, setDownloadingReportId] = useState<string | null>(null);
  const [pdfDownloadError, setPdfDownloadError] = useState<string | null>(null);

  // Request sequence guards prevent stale async responses from flashing after a domain/dataset switch
  const profileSeqRef = useRef(0);
  const intelSeqRef = useRef(0);
  const histSeqRef = useRef(0);
  const archiveSeqRef = useRef(0);
  const initializedRef = useRef(false);

  const timezone = settings?.timezone || "Asia/Dhaka";
  const alertRules: AlertRules = useMemo(
    () => sanitizeAlertRules(settings?.alertRules || DEFAULT_ALERT_RULES),
    [settings?.alertRules]
  );

  const availableTables = profile?.tables || [];
  const currentTableProfile = useMemo(
    () => availableTables.find(item => item.name === selectedDataset) || null,
    [availableTables, selectedDataset]
  );
  const currentUnderstanding = selectedDataset && profile?.tableUnderstandings
    ? profile.tableUnderstandings[selectedDataset] || null
    : null;

  const displayAlerts = useMemo(
    () => mergeToolAlertsWithReadState(intelligence?.tools.alerts || [], readAlertIds),
    [intelligence?.tools.alerts, readAlertIds]
  );

  const loadArchiveReports = useCallback(async (overrideFilters?: ReportHistoryFilterState) => {
    const seq = ++archiveSeqRef.current;
    const activeFilters = overrideFilters || historyFilters;
    setLoadingArchive(true);
    setHistoryError(null);
    try {
      const qs = buildReportHistoryQueryString(activeFilters);
      const response = await fetch(`/api/daily-analysis/reports?${qs}`, { cache: "no-store" });
      const data = await response.json();
      if (seq !== archiveSeqRef.current) return;
      if (data.storageStatus) {
        setStorageStatus(data.storageStatus as StorageCapabilityStatus);
      }
      if (!response.ok) {
        const nextState: ReportHistoryStorageState =
          data.storageState === "storage_unavailable" || response.status === 503
            ? "storage_unavailable"
            : "error";
        setArchivedReports([]);
        setHistoryPagination(DEFAULT_PAGINATION);
        setHistoryStorageState(nextState);
        setHistoryError(data.error || "Could not load persisted report history.");
        setHistoryWarning(null);
        return;
      }
      const items = Array.isArray(data.reports) ? (data.reports as PersistentReportSummary[]) : [];
      setArchivedReports(items);
      if (data.pagination) {
        setHistoryPagination(data.pagination as ReportHistoryPagination);
      }
      setHistoryStorageState(
        (data.storageState as ReportHistoryStorageState | undefined)
        || (items.length > 0 ? "ready" : "empty_no_reports")
      );
      setHistoryWarning(typeof data.warning === "string" ? data.warning : null);
    } catch (error) {
      if (seq !== archiveSeqRef.current) return;
      setHistoryStorageState("error");
      setHistoryError(error instanceof Error ? error.message : "Could not load persisted report history.");
    } finally {
      if (seq === archiveSeqRef.current) {
        setLoadingArchive(false);
      }
    }
  }, [historyFilters]);

  const loadProfile = useCallback(async (domain: BusinessDomainId, preferredTable?: string | null) => {
    const seq = ++profileSeqRef.current;
    setLoadingProfile(true);
    setProfileError(null);
    try {
      const response = await fetch(`/api/daily-analysis/profile?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
      const data = await response.json();
      if (seq !== profileSeqRef.current) return null;
      if (!response.ok) {
        throw new Error(data.error || "Could not profile the connected database.");
      }
      const nextProfile = data.profile as DatabaseProfile;
      setProfile(nextProfile);

      const tables = nextProfile.tables || [];
      const resolvedTable =
        (preferredTable && tables.find(t => t.name === preferredTable)?.name)
        || (selectedDataset && tables.find(t => t.name === selectedDataset)?.name)
        || nextProfile.domainSuggestions.find(s => s.domainId === domain)?.matchedTables[0]
        || tables[0]?.name
        || "";

      if (resolvedTable && resolvedTable !== selectedDataset) {
        setSelectedDataset(resolvedTable);
      }
      return { nextProfile, resolvedTable };
    } catch (error) {
      if (seq !== profileSeqRef.current) return null;
      setProfileError(error instanceof Error ? error.message : "Could not profile the connected database.");
      return null;
    } finally {
      if (seq === profileSeqRef.current) {
        setLoadingProfile(false);
      }
    }
  }, [selectedDataset]);

  const loadIntelligence = useCallback(async (params: {
    domain: BusinessDomainId;
    table: string;
    preset: ComparisonPreset;
    overrides: Record<string, string>;
    tz: string;
    rules: AlertRules;
  }) => {
    if (!params.table) return;
    const seq = ++intelSeqRef.current;
    setLoadingIntelligence(true);
    setIntelligenceError(null);
    try {
      const response = await fetch("/api/daily-analysis/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: params.table,
          domain: params.domain,
          timezone: params.tz,
          comparisonPreset: params.preset,
          overrides: Object.keys(params.overrides).length ? params.overrides : undefined,
          alertRules: params.rules
        })
      });
      const data = await response.json();
      if (seq !== intelSeqRef.current) return;
      if (!response.ok) {
        throw new Error(data.error || "Could not run Daily Analysis intelligence.");
      }
      const nextIntel = data.intelligence as UnifiedDailyAnalysisResult;
      setIntelligence(nextIntel);
      setLastRefreshedAt(nextIntel.generatedAt || new Date().toISOString());
    } catch (error) {
      if (seq !== intelSeqRef.current) return;
      setIntelligence(null);
      setIntelligenceError(error instanceof Error ? error.message : "Could not run Daily Analysis intelligence.");
    } finally {
      if (seq === intelSeqRef.current) {
        setLoadingIntelligence(false);
      }
    }
  }, []);

  const loadHistoricalAnalysis = useCallback(async (params: {
    domain: BusinessDomainId;
    table: string;
    quickRange: ManualQuickRange;
    startDate?: string;
    endDate?: string;
    overrides: Record<string, string>;
    tz: string;
    earliestAvailableDate?: string | null;
    latestAvailableDate?: string | null;
  }) => {
    if (!params.table) return;
    if (params.quickRange === "custom" && (!params.startDate || !params.endDate)) return;
    const seq = ++histSeqRef.current;
    setLoadingHistorical(true);
    setHistoricalError(null);
    try {
      const response = await fetch("/api/daily-analysis/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: params.table,
          domain: params.domain,
          quickRange: params.quickRange,
          periodStart: params.quickRange === "custom" ? params.startDate : undefined,
          periodEnd: params.quickRange === "custom" ? params.endDate : undefined,
          timezone: params.tz,
          overrides: Object.keys(params.overrides).length ? params.overrides : undefined,
          earliestAvailableDate: params.earliestAvailableDate?.slice(0, 10) || undefined,
          latestAvailableDate: params.latestAvailableDate?.slice(0, 10) || undefined
        })
      });
      const data = await response.json();
      if (seq !== histSeqRef.current) return;
      if (!response.ok) {
        throw new Error(data.error || "Could not load historical analysis.");
      }
      const nextAnalysis = data.analysis as DynamicAnalysisResult;
      setHistoricalAnalysis(nextAnalysis);
      setHistoricalRefreshedAt(nextAnalysis.generatedAt || new Date().toISOString());
    } catch (error) {
      if (seq !== histSeqRef.current) return;
      setHistoricalAnalysis(null);
      setHistoricalError(error instanceof Error ? error.message : "Could not load historical analysis.");
    } finally {
      if (seq === histSeqRef.current) {
        setLoadingHistorical(false);
      }
    }
  }, []);

  // Initial load: settings + profile + archive + intelligence + default 30-day historical dashboard
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setReadAlertIds(loadReadAlertIds());

    void (async () => {
      setLoadingSettings(true);
      let initialDomain: BusinessDomainId = "sales_ecommerce";
      let initialTable: string | null = null;
      let initialOverrides: Record<string, string> = {};
      let initialTz = "Asia/Dhaka";
      let initialRules: AlertRules = DEFAULT_ALERT_RULES;

      try {
        const res = await fetch("/api/daily-analysis/settings", { cache: "no-store" });
        const data = await res.json();
        if (res.ok && data.settings) {
          const loaded = data.settings as PersistentDailySettings;
          setSettings(loaded);
          setStorageStatus(data.storageStatus || null);
          setScheduleSummary(data.scheduleSummary || null);
          initialDomain = loaded.selectedDomain || "sales_ecommerce";
          initialTable = loaded.selectedDataset || null;
          initialOverrides = loaded.columnOverrides || {};
          initialTz = loaded.timezone || "Asia/Dhaka";
          initialRules = sanitizeAlertRules(loaded.alertRules || DEFAULT_ALERT_RULES);
          setSelectedDomain(initialDomain);
          if (initialTable) setSelectedDataset(initialTable);
          setColumnOverrides(initialOverrides);
        }
      } catch {
        // Keep safe defaults
      } finally {
        setLoadingSettings(false);
      }

      const [profileResult] = await Promise.all([
        loadProfile(initialDomain, initialTable),
        loadArchiveReports(DEFAULT_REPORT_HISTORY_FILTERS)
      ]);

      const tableToRun = profileResult?.resolvedTable || initialTable || "";
      const profiledTable = profileResult?.nextProfile.tables.find(t => t.name === tableToRun) || null;
      if (tableToRun) {
        await Promise.all([
          loadIntelligence({
            domain: initialDomain,
            table: tableToRun,
            preset: "previous_day",
            overrides: initialOverrides,
            tz: initialTz,
            rules: initialRules
          }),
          loadHistoricalAnalysis({
            domain: initialDomain,
            table: tableToRun,
            quickRange: "last_30_days",
            overrides: initialOverrides,
            tz: initialTz,
            earliestAvailableDate: profiledTable?.freshness.earliestDate || null,
            latestAvailableDate: profiledTable?.freshness.latestDate || null
          })
        ]);
      }
    })();
  }, [loadArchiveReports, loadHistoricalAnalysis, loadIntelligence, loadProfile]);

  // Compatible event-driven refresh hook
  useEffect(() => {
    const handleRefreshEvent = () => {
      if (!selectedDataset) return;
      void loadIntelligence({
        domain: selectedDomain,
        table: selectedDataset,
        preset: comparisonPreset,
        overrides: columnOverrides,
        tz: timezone,
        rules: alertRules
      });
      void loadHistoricalAnalysis({
        domain: selectedDomain,
        table: selectedDataset,
        quickRange: historicalRange,
        startDate: historicalCustomStart,
        endDate: historicalCustomEnd,
        overrides: columnOverrides,
        tz: timezone,
        earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
        latestAvailableDate: currentTableProfile?.freshness.latestDate || null
      });
      void loadArchiveReports();
    };
    window.addEventListener("querypilot:daily-analysis-refresh", handleRefreshEvent);
    return () => window.removeEventListener("querypilot:daily-analysis-refresh", handleRefreshEvent);
  }, [
    alertRules,
    columnOverrides,
    comparisonPreset,
    currentTableProfile?.freshness.earliestDate,
    currentTableProfile?.freshness.latestDate,
    historicalCustomEnd,
    historicalCustomStart,
    historicalRange,
    loadArchiveReports,
    loadHistoricalAnalysis,
    loadIntelligence,
    selectedDataset,
    selectedDomain,
    timezone
  ]);

  function resetStaleResults() {
    const reset = createStaleResetSnapshot();
    setIntelligence(reset.intelligence);
    setHistoricalAnalysis(reset.historicalAnalysis);
    setManualResult(reset.manualResult);
    setArchiveComparison(reset.archiveComparison);
    setManualError(null);
    setIntelligenceError(null);
    setHistoricalError(null);
    setArchiveCompareError(null);
  }

  async function handleDomainChange(nextDomain: BusinessDomainId) {
    if (nextDomain === selectedDomain) return;
    resetStaleResults();
    setSelectedDomain(nextDomain);
    setColumnOverrides({});
    const result = await loadProfile(nextDomain, selectedDataset);
    const nextTable = result?.resolvedTable || selectedDataset;
    const profiledTable = result?.nextProfile.tables.find(t => t.name === nextTable) || null;
    if (nextTable) {
      await Promise.all([
        loadIntelligence({
          domain: nextDomain,
          table: nextTable,
          preset: comparisonPreset,
          overrides: {},
          tz: timezone,
          rules: alertRules
        }),
        loadHistoricalAnalysis({
          domain: nextDomain,
          table: nextTable,
          quickRange: historicalRange,
          startDate: historicalCustomStart,
          endDate: historicalCustomEnd,
          overrides: {},
          tz: timezone,
          earliestAvailableDate: profiledTable?.freshness.earliestDate || null,
          latestAvailableDate: profiledTable?.freshness.latestDate || null
        })
      ]);
    }
  }

  async function handleDatasetChange(nextTable: string) {
    if (nextTable === selectedDataset) return;
    resetStaleResults();
    setSelectedDataset(nextTable);
    setColumnOverrides({});
    const profiledTable = availableTables.find(t => t.name === nextTable) || null;
    if (nextTable) {
      await Promise.all([
        loadIntelligence({
          domain: selectedDomain,
          table: nextTable,
          preset: comparisonPreset,
          overrides: {},
          tz: timezone,
          rules: alertRules
        }),
        loadHistoricalAnalysis({
          domain: selectedDomain,
          table: nextTable,
          quickRange: historicalRange,
          startDate: historicalCustomStart,
          endDate: historicalCustomEnd,
          overrides: {},
          tz: timezone,
          earliestAvailableDate: profiledTable?.freshness.earliestDate || null,
          latestAvailableDate: profiledTable?.freshness.latestDate || null
        })
      ]);
    }
  }

  async function handleRefreshAll() {
    if (!selectedDataset) return;
    await Promise.all([
      loadProfile(selectedDomain, selectedDataset),
      loadIntelligence({
        domain: selectedDomain,
        table: selectedDataset,
        preset: comparisonPreset,
        overrides: columnOverrides,
        tz: timezone,
        rules: alertRules
      }),
      loadHistoricalAnalysis({
        domain: selectedDomain,
        table: selectedDataset,
        quickRange: historicalRange,
        startDate: historicalCustomStart,
        endDate: historicalCustomEnd,
        overrides: columnOverrides,
        tz: timezone,
        earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
        latestAvailableDate: currentTableProfile?.freshness.latestDate || null
      }),
      loadArchiveReports()
    ]);
  }

  async function handleHistoricalRangeChange(input: {
    quickRange: ManualQuickRange;
    startDate?: string;
    endDate?: string;
  }) {
    setHistoricalRange(input.quickRange);
    if (input.startDate !== undefined) setHistoricalCustomStart(input.startDate);
    if (input.endDate !== undefined) setHistoricalCustomEnd(input.endDate);
    if (!selectedDataset) return;
    if (input.quickRange === "custom" && (!input.startDate || !input.endDate)) return;

    await loadHistoricalAnalysis({
      domain: selectedDomain,
      table: selectedDataset,
      quickRange: input.quickRange,
      startDate: input.startDate ?? historicalCustomStart,
      endDate: input.endDate ?? historicalCustomEnd,
      overrides: columnOverrides,
      tz: timezone,
      earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
      latestAvailableDate: currentTableProfile?.freshness.latestDate || null
    });
  }

  async function handleHistoryFiltersChange(nextFilters: ReportHistoryFilterState) {
    setHistoryFilters(nextFilters);
    await loadArchiveReports(nextFilters);
  }

  async function handleInspectReport(reportId: string) {
    setLoadingInspect(true);
    try {
      const response = await fetch(`/api/daily-analysis/reports/${encodeURIComponent(reportId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load report details.");
      setInspectedReport(data.report as PersistentReportRecord);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load report details.");
    } finally {
      setLoadingInspect(false);
    }
  }

  async function handleComparisonPresetChange(nextPreset: ComparisonPreset) {
    setComparisonPreset(nextPreset);
    if (!selectedDataset) return;
    await loadIntelligence({
      domain: selectedDomain,
      table: selectedDataset,
      preset: nextPreset,
      overrides: columnOverrides,
      tz: timezone,
      rules: alertRules
    });
  }

  async function handleSaveSchedule(payload: {
    autoReportEnabled: boolean;
    frequency: ReportFrequency;
    scheduledTime: string;
    timezone: string;
  }) {
    setSavingSchedule(true);
    setSaveFeedback(null);
    try {
      const response = await fetch("/api/daily-analysis/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          selectedDomain,
          selectedDataset: selectedDataset || null,
          columnOverrides
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not save schedule settings.");
      }
      setSettings(data.settings as PersistentDailySettings);
      if (data.storageStatus) setStorageStatus(data.storageStatus as StorageCapabilityStatus);
      if (data.scheduleSummary) setScheduleSummary(data.scheduleSummary as ScheduleRuntimeSummary);

      const syncNotice = (data.scheduleSummary as ScheduleRuntimeSummary | undefined)?.lastSync?.notice;
      setSaveFeedback({
        type: "success",
        text: syncNotice || "Schedule settings confirmed and saved by the backend."
      });
    } catch (error) {
      setSaveFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "Could not save schedule settings."
      });
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleGenerateManualReport(input: {
    quickRange: ManualQuickRange;
    startDate?: string;
    endDate?: string;
  }) {
    if (generatingManual) return;
    setGeneratingManual(true);
    setManualError(null);
    try {
      const response = await fetch("/api/daily-analysis/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "manual",
          table: selectedDataset,
          domain: selectedDomain,
          quickRange: input.quickRange,
          startDate: input.startDate,
          endDate: input.endDate,
          timezone,
          overrides: Object.keys(columnOverrides).length ? columnOverrides : undefined,
          earliestAvailableDate: currentTableProfile?.freshness.earliestDate?.slice(0, 10) || undefined,
          latestAvailableDate: currentTableProfile?.freshness.latestDate?.slice(0, 10) || undefined
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not generate manual report.");
      }
      setManualResult(data.report as PersistentReportRecord);
      await loadArchiveReports();
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "Could not generate manual report.");
    } finally {
      setGeneratingManual(false);
    }
  }

  async function handleDownloadPdf(report: PersistentReportSummary | PersistentReportRecord, compareWithId?: string) {
    if (downloadingReportId) return;
    setDownloadingReportId(report.id);
    setPdfDownloadError(null);
    try {
      const query = compareWithId ? `?compareWith=${encodeURIComponent(compareWithId)}` : "";
      const response = await fetch(`/api/daily-analysis/reports/${encodeURIComponent(report.id)}/pdf${query}`, {
        method: "GET",
        cache: "no-store"
      });
      if (!response.ok) {
        let message = "Could not download the PDF.";
        try {
          const err = await response.json();
          if (err?.error) message = err.error;
        } catch {
          // ignore non-json body
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const suffix = compareWithId ? "-comparison" : "";
      anchor.download = report.pdfFilename || `querypilot-x-${report.domainId}-${report.periodStart}-to-${report.periodEnd}${suffix}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setPdfDownloadError(error instanceof Error ? error.message : "Could not download the PDF.");
    } finally {
      setDownloadingReportId(null);
    }
  }

  async function handleCompareArchivedReports(leftId: string, rightId: string) {
    setComparingArchive(true);
    setArchiveCompareError(null);
    try {
      const response = await fetch("/api/daily-analysis/reports/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leftReportId: leftId, rightReportId: rightId })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not compare selected reports.");
      }
      setArchiveComparison(data.comparison as ReportArchiveComparisonResult);
    } catch (error) {
      setArchiveCompareError(error instanceof Error ? error.message : "Could not compare selected reports.");
    } finally {
      setComparingArchive(false);
    }
  }

  function handleToggleAlertRead(alertId: string) {
    setReadAlertIds(prev => {
      const next = new Set(prev);
      if (next.has(alertId)) next.delete(alertId);
      else next.add(alertId);
      saveReadAlertIds(next);
      return next;
    });
  }

  function handleMarkAllAlertsRead() {
    setReadAlertIds(prev => {
      const next = new Set(prev);
      for (const alert of displayAlerts) next.add(alert.id);
      saveReadAlertIds(next);
      return next;
    });
  }

  async function handleSaveAlertRules(nextRules: AlertRules) {
    setSavingAlertRules(true);
    try {
      const cleaned = sanitizeAlertRules(nextRules);
      const response = await fetch("/api/daily-analysis/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertRules: cleaned })
      });
      const data = await response.json();
      if (response.ok && data.settings) {
        setSettings(data.settings as PersistentDailySettings);
        if (selectedDataset) {
          await loadIntelligence({
            domain: selectedDomain,
            table: selectedDataset,
            preset: comparisonPreset,
            overrides: columnOverrides,
            tz: timezone,
            rules: cleaned
          });
        }
      }
    } finally {
      setSavingAlertRules(false);
    }
  }

  return (
    <div className={styles.shell}>
      {/* Header */}
      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            <ArrowLeft size={13} /> Back to Smart Dashboard
          </button>
          <span className={styles.eyebrow}>DAILY INTELLIGENCE, HISTORICAL ANALYTICS &amp; ARCHIVES</span>
          <h1 className={styles.pageTitle}>Daily Analysis</h1>
          <p className={styles.pageSubtitle}>
            Automated Daily/Weekly/Monthly PDF reporting, on-demand manual reports, live multi-domain intelligence, dynamic 30-day historical analytics, and persisted Report History.
          </p>
        </div>

        <div className={styles.topActions}>
          <span className={styles.freshnessChip} title="Analysis refreshes on dataset changes and manual refresh (on-demand)">
            <Clock size={13} />
            {lastRefreshedAt
              ? `Last analyzed: ${formatShortTimestamp(lastRefreshedAt, timezone)}`
              : loadingIntelligence
                ? "Analyzing dataset..."
                : "On-demand analysis"}
          </span>
        </div>
      </header>

      {/* Global errors */}
      {profileError && (
        <div className={styles.errorBanner} role="alert">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} /> {profileError}
          </span>
          <button type="button" className={styles.ghostBtn} onClick={() => setProfileError(null)}>Dismiss</button>
        </div>
      )}
      {pdfDownloadError && (
        <div className={styles.errorBanner} role="alert">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} /> {pdfDownloadError}
          </span>
          <button type="button" className={styles.ghostBtn} onClick={() => setPdfDownloadError(null)}>Dismiss</button>
        </div>
      )}

      {/* Primary 5-section navigation */}
      <nav className={styles.sectionNav} aria-label="Daily Analysis main sections">
        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "daily_report" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "daily_report" ? "page" : undefined}
          onClick={() => setActiveTab("daily_report")}
        >
          <span className={styles.sectionTabIcon}><CalendarClock size={17} /></span>
          <span className={styles.sectionTabText}>
            <strong>Daily Report</strong>
            <small>Automatic PDF schedule</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "manual_report" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "manual_report" ? "page" : undefined}
          onClick={() => setActiveTab("manual_report")}
        >
          <span className={styles.sectionTabIcon}><FileSpreadsheet size={17} /></span>
          <span className={styles.sectionTabText}>
            <strong>Manual Report</strong>
            <small>Quick &amp; custom ranges</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "tools" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "tools" ? "page" : undefined}
          onClick={() => setActiveTab("tools")}
        >
          <span className={styles.sectionTabIcon}><Activity size={17} /></span>
          <span className={styles.sectionTabText}>
            <strong>Analysis Tools</strong>
            <small>7 intelligence tools</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "historical" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "historical" ? "page" : undefined}
          onClick={() => setActiveTab("historical")}
        >
          <span className={styles.sectionTabIcon}><TrendingUp size={17} /></span>
          <span className={styles.sectionTabText}>
            <strong>Historical Dashboard</strong>
            <small>30-day KPIs &amp; trends</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "history" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "history" ? "page" : undefined}
          onClick={() => setActiveTab("history")}
        >
          <span className={styles.sectionTabIcon}><Archive size={17} /></span>
          <span className={styles.sectionTabText}>
            <strong>Report History</strong>
            <small>Archive, filter &amp; compare</small>
          </span>
        </button>
      </nav>

      {/* Dynamic Business Domain, Dataset & Automatic Column Understanding Bar */}
      <DomainDatasetBar
        selectedDomain={selectedDomain}
        selectedDataset={selectedDataset}
        profile={profile}
        availableTables={availableTables}
        understanding={currentUnderstanding}
        columnOverrides={columnOverrides}
        loadingProfile={loadingProfile}
        loadingAnalysis={loadingIntelligence || loadingHistorical}
        onDomainChange={domain => void handleDomainChange(domain)}
        onDatasetChange={table => void handleDatasetChange(table)}
        onOverrideChange={(role, columnName) => {
          setColumnOverrides(prev => {
            const next = { ...prev };
            if (!columnName) delete next[role];
            else next[role] = columnName;
            return next;
          });
        }}
        onClearOverrides={() => {
          setColumnOverrides({});
          if (selectedDataset) {
            void Promise.all([
              loadIntelligence({
                domain: selectedDomain,
                table: selectedDataset,
                preset: comparisonPreset,
                overrides: {},
                tz: timezone,
                rules: alertRules
              }),
              loadHistoricalAnalysis({
                domain: selectedDomain,
                table: selectedDataset,
                quickRange: historicalRange,
                startDate: historicalCustomStart,
                endDate: historicalCustomEnd,
                overrides: {},
                tz: timezone,
                earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
                latestAvailableDate: currentTableProfile?.freshness.latestDate || null
              })
            ]);
          }
        }}
        onApplyOverrides={() => {
          if (!selectedDataset) return;
          void Promise.all([
            loadIntelligence({
              domain: selectedDomain,
              table: selectedDataset,
              preset: comparisonPreset,
              overrides: columnOverrides,
              tz: timezone,
              rules: alertRules
            }),
            loadHistoricalAnalysis({
              domain: selectedDomain,
              table: selectedDataset,
              quickRange: historicalRange,
              startDate: historicalCustomStart,
              endDate: historicalCustomEnd,
              overrides: columnOverrides,
              tz: timezone,
              earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
              latestAvailableDate: currentTableProfile?.freshness.latestDate || null
            })
          ]);
        }}
        onRefreshAll={() => void handleRefreshAll()}
      />

      {/* Section 1: Daily Report */}
      {activeTab === "daily_report" && (
        <DailyReportPanel
          settings={settings}
          selectedDataset={selectedDataset}
          storageStatus={storageStatus}
          scheduleSummary={scheduleSummary}
          loadingSettings={loadingSettings}
          savingSchedule={savingSchedule}
          downloadingReportId={downloadingReportId}
          saveFeedback={saveFeedback}
          onSaveSchedule={handleSaveSchedule}
          onDownloadPdf={report => handleDownloadPdf(report)}
        />
      )}

      {/* Section 2: Manual Report */}
      {activeTab === "manual_report" && (
        <ManualReportPanel
          selectedDomain={selectedDomain}
          selectedDataset={selectedDataset}
          timezone={timezone}
          earliestAvailableDate={currentTableProfile?.freshness.earliestDate || null}
          latestAvailableDate={currentTableProfile?.freshness.latestDate || null}
          generating={generatingManual}
          downloadingReportId={downloadingReportId}
          error={manualError}
          generatedReport={manualResult}
          onGenerateManualReport={handleGenerateManualReport}
          onDownloadPdf={report => handleDownloadPdf(report)}
        />
      )}

      {/* Section 3: Seven Daily Analysis Tools */}
      {activeTab === "tools" && (
        <DailyToolsSection
          intelligence={intelligence}
          loadingIntelligence={loadingIntelligence}
          intelligenceError={intelligenceError}
          comparisonPreset={comparisonPreset}
          onComparisonPresetChange={preset => void handleComparisonPresetChange(preset)}
          alerts={displayAlerts}
          alertRules={alertRules}
          savingAlertRules={savingAlertRules}
          onToggleAlertRead={handleToggleAlertRead}
          onMarkAllAlertsRead={handleMarkAllAlertsRead}
          onSaveAlertRules={handleSaveAlertRules}
          archivedReports={archivedReports}
          loadingArchive={loadingArchive}
          archiveComparison={archiveComparison}
          comparingArchive={comparingArchive}
          archiveCompareError={archiveCompareError}
          downloadingReportId={downloadingReportId}
          timezone={timezone}
          onCompareArchivedReports={handleCompareArchivedReports}
          onDownloadReportPdf={handleDownloadPdf}
          onOpenReportHistory={() => setActiveTab("history")}
          onOpenHistoricalDashboard={() => setActiveTab("historical")}
        />
      )}

      {/* Section 4: Dynamic 30-Day Historical Dashboard */}
      {activeTab === "historical" && (
        <HistoricalDashboardPanel
          selectedDomain={selectedDomain}
          selectedDataset={selectedDataset}
          timezone={timezone}
          earliestAvailableDate={currentTableProfile?.freshness.earliestDate || null}
          latestAvailableDate={currentTableProfile?.freshness.latestDate || null}
          quickRange={historicalRange}
          customStart={historicalCustomStart}
          customEnd={historicalCustomEnd}
          analysis={historicalAnalysis}
          loading={loadingHistorical}
          error={historicalError}
          lastAnalyzedAt={historicalRefreshedAt}
          onRangeChange={input => void handleHistoricalRangeChange(input)}
          onRefresh={() => {
            if (!selectedDataset) return;
            void loadHistoricalAnalysis({
              domain: selectedDomain,
              table: selectedDataset,
              quickRange: historicalRange,
              startDate: historicalCustomStart,
              endDate: historicalCustomEnd,
              overrides: columnOverrides,
              tz: timezone,
              earliestAvailableDate: currentTableProfile?.freshness.earliestDate || null,
              latestAvailableDate: currentTableProfile?.freshness.latestDate || null
            });
          }}
        />
      )}

      {/* Section 5: Complete Report History & Archived Report Comparison */}
      {activeTab === "history" && (
        <ReportHistoryPanel
          reports={archivedReports}
          pagination={historyPagination}
          filters={historyFilters}
          loading={loadingArchive}
          storageState={historyStorageState}
          storageStatus={storageStatus}
          error={historyError}
          warning={historyWarning}
          timezone={timezone}
          downloadingReportId={downloadingReportId}
          comparison={archiveComparison}
          comparing={comparingArchive}
          compareError={archiveCompareError}
          inspectedReport={inspectedReport}
          loadingInspect={loadingInspect}
          onFiltersChange={next => void handleHistoryFiltersChange(next)}
          onRefresh={() => void loadArchiveReports()}
          onInspectReport={handleInspectReport}
          onCloseInspect={() => setInspectedReport(null)}
          onCompareReports={handleCompareArchivedReports}
          onClearComparison={() => {
            setArchiveComparison(null);
            setArchiveCompareError(null);
          }}
          onDownloadPdf={handleDownloadPdf}
        />
      )}
    </div>
  );
}
