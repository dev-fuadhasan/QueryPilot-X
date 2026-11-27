"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Clock } from "lucide-react";
import type { BusinessDomainId, DatabaseProfile } from "../profiler/types";
import type { ComparisonPreset } from "../metrics/types";
import type { ReportArchiveComparisonResult, UnifiedDailyAnalysisResult } from "../intelligence/types";
import { DEFAULT_ALERT_RULES, sanitizeAlertRules, type AlertRules } from "../notifications";
import type {
  PersistentDailySettings,
  PersistentReportRecord,
  PersistentReportSummary,
  ReportFrequency,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";
import {
  buildReportHistoryQueryString,
  createStaleResetSnapshot,
  DEFAULT_REPORT_HISTORY_FILTERS,
  formatShortTimestamp,
  mergeToolAlertsWithReadState
} from "./dashboard-helpers";
import DomainDatasetBar from "./DomainDatasetBar";
import DailyReportPanel, { type UnifiedPdfGenerateRequest } from "./DailyReportPanel";
import DailyToolsSection from "./DailyToolsSection";
import styles from "./DailyAnalysisDashboard.module.css";

type Props = { onBack: () => void };

const READ_ALERTS_KEY = "querypilot.dailyAnalysis.readAlertIds";
const LAST_DATASET_KEY = "querypilot.dailyAnalysis.lastDataset";

function loadLastDataset(): string {
  try {
    return localStorage.getItem(LAST_DATASET_KEY) || "";
  } catch {
    return "";
  }
}

function saveLastDataset(tableName: string) {
  try {
    if (tableName) localStorage.setItem(LAST_DATASET_KEY, tableName);
  } catch {
    // ignore storage errors
  }
}

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

function base64ToPdfBlob(base64: string): Blob {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

function triggerPdfBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getCurrentClockInTz(tz: string): { date: string; time: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    const hh = (parts.hour === "24" ? "00" : parts.hour || "00").padStart(2, "0");
    const mm = (parts.minute || "00").padStart(2, "0");
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hh}:${mm}` };
  } catch {
    const now = new Date();
    return { date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 16) };
  }
}

export default function DailyAnalysisDashboard({ onBack }: Props) {
  const [selectedDomain, setSelectedDomain] = useState<BusinessDomainId>("sales_ecommerce");
  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});
  const [comparisonPreset, setComparisonPreset] = useState<ComparisonPreset>("previous_day");
  const [manualPeriodStart, setManualPeriodStart] = useState<string>("");
  const [manualPeriodEnd, setManualPeriodEnd] = useState<string>("");

  const [profile, setProfile] = useState<DatabaseProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState<boolean>(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [settings, setSettings] = useState<PersistentDailySettings | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageCapabilityStatus | null>(null);
  const [scheduleSummary, setScheduleSummary] = useState<ScheduleRuntimeSummary | null>(null);
  const [loadingSettings, setLoadingSettings] = useState<boolean>(true);
  const [savingSchedule, setSavingSchedule] = useState<boolean>(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Unified Daily Intelligence state (7 Daily Analysis Tools rendered directly as cards)
  const [intelligence, setIntelligence] = useState<UnifiedDailyAnalysisResult | null>(null);
  const [loadingIntelligence, setLoadingIntelligence] = useState<boolean>(false);
  const [intelligenceError, setIntelligenceError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  // Archived reports & comparison state (Tool #7 card)
  const [archivedReports, setArchivedReports] = useState<PersistentReportSummary[]>([]);
  const [loadingArchive, setLoadingArchive] = useState<boolean>(false);
  const [archiveComparison, setArchiveComparison] = useState<ReportArchiveComparisonResult | null>(null);
  const [comparingArchive, setComparingArchive] = useState<boolean>(false);
  const [archiveCompareError, setArchiveCompareError] = useState<string | null>(null);

  const [readAlertIds, setReadAlertIds] = useState<Set<string>>(() => new Set());
  const [savingAlertRules, setSavingAlertRules] = useState<boolean>(false);
  const [generatingPdf, setGeneratingPdf] = useState<boolean>(false);
  const [pdfGenerateError, setPdfGenerateError] = useState<string | null>(null);
  const [pdfGenerateNotice, setPdfGenerateNotice] = useState<string | null>(null);
  const [downloadingReportId, setDownloadingReportId] = useState<string | null>(null);
  const [pdfDownloadError, setPdfDownloadError] = useState<string | null>(null);

  // Request sequence guards prevent stale async responses from flashing after a domain/dataset switch
  const profileSeqRef = useRef(0);
  const intelSeqRef = useRef(0);
  const archiveSeqRef = useRef(0);
  const initializedRef = useRef(false);
  const lastScheduledCheckKeyRef = useRef<string>("");
  const runningScheduledRef = useRef(false);
  const pdfCacheRef = useRef<Map<string, { base64: string; filename: string }>>(new Map());

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

  const loadArchiveReports = useCallback(async () => {
    const seq = ++archiveSeqRef.current;
    setLoadingArchive(true);
    try {
      const qs = buildReportHistoryQueryString(DEFAULT_REPORT_HISTORY_FILTERS);
      const response = await fetch(`/api/daily-analysis/reports?${qs}`, { cache: "no-store" });
      const data = await response.json();
      if (seq !== archiveSeqRef.current) return;
      if (data.storageStatus) {
        setStorageStatus(data.storageStatus as StorageCapabilityStatus);
      }
      if (!response.ok) {
        setArchivedReports([]);
        return;
      }
      const items = Array.isArray(data.reports) ? (data.reports as PersistentReportSummary[]) : [];
      setArchivedReports(items);
    } catch {
      if (seq !== archiveSeqRef.current) return;
      setArchivedReports([]);
    } finally {
      if (seq === archiveSeqRef.current) {
        setLoadingArchive(false);
      }
    }
  }, []);

  const loadProfile = useCallback(async (_domain?: BusinessDomainId, preferredTable?: string | null, fresh = false) => {
    const seq = ++profileSeqRef.current;
    setLoadingProfile(true);
    setProfileError(null);
    try {
      const response = await fetch(fresh ? "/api/daily-analysis/profile?fresh=1" : "/api/daily-analysis/profile", { cache: "no-store" });
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
        || nextProfile.suggestedDomain?.matchedTables[0]
        || tables[0]?.name
        || "";

      if (resolvedTable) {
        saveLastDataset(resolvedTable);
        if (resolvedTable !== selectedDataset) {
          setSelectedDataset(resolvedTable);
        }
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
    domain?: BusinessDomainId;
    table: string;
    preset: ComparisonPreset;
    overrides: Record<string, string>;
    tz: string;
    rules: AlertRules;
    latestAvailableDate?: string | null;
    periodStart?: string;
    periodEnd?: string;
    fresh?: boolean;
  }) => {
    if (!params.table) return;
    saveLastDataset(params.table);
    const seq = ++intelSeqRef.current;
    setLoadingIntelligence(true);
    setIntelligenceError(null);
    const hasManualPeriod = Boolean(params.periodStart && params.periodEnd);
    try {
      const response = await fetch("/api/daily-analysis/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: params.table,
          timezone: params.tz,
          comparisonPreset: params.preset,
          periodStart: hasManualPeriod ? params.periodStart : undefined,
          periodEnd: hasManualPeriod ? params.periodEnd : undefined,
          includeAllDatasetColumns: true,
          anchorToDatasetDates: !hasManualPeriod,
          fresh: params.fresh === true,
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
      if (nextIntel.domainId) {
        setSelectedDomain(nextIntel.domainId);
      }
      setLastRefreshedAt(nextIntel.generatedAt || new Date().toISOString());
    } catch (error) {
      if (seq !== intelSeqRef.current) return;
      setIntelligenceError(error instanceof Error ? error.message : "Could not run Daily Analysis intelligence.");
    } finally {
      if (seq === intelSeqRef.current) {
        setLoadingIntelligence(false);
      }
    }
  }, []);

  // Initial load: launch settings + profile + archive + optimistic intelligence ALL IN PARALLEL (zero waterfall!)
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setReadAlertIds(loadReadAlertIds());

    void (async () => {
      setLoadingSettings(true);
      const cachedLastTable = loadLastDataset();
      if (cachedLastTable) {
        setSelectedDataset(cachedLastTable);
      }

      // Start all independent initial requests simultaneously instead of waiting sequentially
      const settingsPromise = fetch("/api/daily-analysis/settings", { cache: "no-store" })
        .then(async res => {
          const data = await res.json();
          return res.ok && data.settings ? data : null;
        })
        .catch(() => null);

      const profilePromise = loadProfile(undefined, cachedLastTable || null, false);
      const archivePromise = loadArchiveReports();

      // If we already know the last active table from localStorage, load intelligence immediately in parallel!
      let optimisticTableRan = "";
      const optimisticIntelPromise = cachedLastTable
        ? (() => {
            optimisticTableRan = cachedLastTable;
            return loadIntelligence({
              table: cachedLastTable,
              preset: "previous_day",
              overrides: {},
              tz: "Asia/Dhaka",
              rules: DEFAULT_ALERT_RULES
            });
          })()
        : Promise.resolve();

      const settingsData = await settingsPromise;
      let initialDomain: BusinessDomainId = "sales_ecommerce";
      let initialTable: string | null = cachedLastTable || null;
      let initialOverrides: Record<string, string> = {};
      let initialTz = "Asia/Dhaka";
      let initialRules: AlertRules = DEFAULT_ALERT_RULES;

      if (settingsData?.settings) {
        const loaded = settingsData.settings as PersistentDailySettings;
        setSettings(loaded);
        setStorageStatus(settingsData.storageStatus || null);
        setScheduleSummary(settingsData.scheduleSummary || null);
        initialDomain = loaded.selectedDomain || "sales_ecommerce";
        initialTable = loaded.selectedDataset || initialTable;
        initialOverrides = loaded.columnOverrides || {};
        initialTz = loaded.timezone || "Asia/Dhaka";
        initialRules = sanitizeAlertRules(loaded.alertRules || DEFAULT_ALERT_RULES);
        setSelectedDomain(initialDomain);
        if (initialTable) setSelectedDataset(initialTable);
        setColumnOverrides(initialOverrides);
      }
      setLoadingSettings(false);

      const [profileResult] = await Promise.all([profilePromise, archivePromise, optimisticIntelPromise]);

      const tableToRun = profileResult?.resolvedTable || initialTable || "";
      const profiledTable = profileResult?.nextProfile.tables.find(t => t.name === tableToRun) || null;
      const autoDomain = profileResult?.nextProfile.tableUnderstandings?.[tableToRun]?.domainId
        || profileResult?.nextProfile.suggestedDomain?.domainId
        || initialDomain;
      if (autoDomain !== initialDomain) {
        setSelectedDomain(autoDomain);
      }
      const needsFollowUpIntel = Boolean(
        tableToRun && (
          tableToRun !== optimisticTableRan
          || Object.keys(initialOverrides).length > 0
          || initialTz !== "Asia/Dhaka"
        )
      );
      if (needsFollowUpIntel) {
        await loadIntelligence({
          domain: autoDomain,
          table: tableToRun,
          preset: "previous_day",
          overrides: initialOverrides,
          tz: initialTz,
          rules: initialRules,
          latestAvailableDate: profiledTable?.freshness.latestDate || null
        });
      }
    })();
  }, [loadArchiveReports, loadIntelligence, loadProfile]);

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
      void loadArchiveReports();
    };
    window.addEventListener("querypilot:daily-analysis-refresh", handleRefreshEvent);
    return () => window.removeEventListener("querypilot:daily-analysis-refresh", handleRefreshEvent);
  }, [
    alertRules,
    columnOverrides,
    comparisonPreset,
    loadArchiveReports,
    loadIntelligence,
    selectedDataset,
    selectedDomain,
    timezone
  ]);

  function resetStaleResults() {
    const reset = createStaleResetSnapshot();
    setIntelligence(reset.intelligence);
    setArchiveComparison(reset.archiveComparison);
    setIntelligenceError(null);
    setArchiveCompareError(null);
  }

  async function handleDomainChange(nextDomain: BusinessDomainId) {
    if (nextDomain === selectedDomain) return;
    resetStaleResults();
    setSelectedDomain(nextDomain);
    setColumnOverrides({});
    const result = await loadProfile(nextDomain, selectedDataset);
    const nextTable = result?.resolvedTable || selectedDataset;
    if (nextTable) {
      await loadIntelligence({
        domain: nextDomain,
        table: nextTable,
        preset: comparisonPreset,
        overrides: {},
        tz: timezone,
        rules: alertRules
      });
    }
  }

  async function handleDatasetChange(nextTable: string) {
    if (nextTable === selectedDataset) return;
    resetStaleResults();
    setSelectedDataset(nextTable);
    setColumnOverrides({});
    setManualPeriodStart("");
    setManualPeriodEnd("");
    const profiledTable = availableTables.find(t => t.name === nextTable) || null;
    const autoDomain = profile?.tableUnderstandings?.[nextTable]?.domainId || selectedDomain;
    if (autoDomain !== selectedDomain) {
      setSelectedDomain(autoDomain);
    }
    if (nextTable) {
      await loadIntelligence({
        domain: autoDomain,
        table: nextTable,
        preset: comparisonPreset,
        overrides: {},
        tz: timezone,
        rules: alertRules,
        latestAvailableDate: profiledTable?.freshness.latestDate || null
      });
    }
  }

  async function handleRefreshAll() {
    if (!selectedDataset) return;
    await Promise.all([
      loadProfile(selectedDomain, selectedDataset, true),
      loadIntelligence({
        domain: selectedDomain,
        table: selectedDataset,
        preset: comparisonPreset,
        overrides: columnOverrides,
        tz: timezone,
        rules: alertRules,
        latestAvailableDate: currentTableProfile?.freshness.latestDate || null,
        fresh: true
      }),
      loadArchiveReports()
    ]);
  }

  async function handleComparisonPresetChange(nextPreset: ComparisonPreset) {
    setComparisonPreset(nextPreset);
    // Selecting "All Data (Full Dataset)" clears any narrower manual window so all rows are analyzed
    const useManual = nextPreset !== "none" && Boolean(manualPeriodStart && manualPeriodEnd);
    if (nextPreset === "none" && (manualPeriodStart || manualPeriodEnd)) {
      setManualPeriodStart("");
      setManualPeriodEnd("");
    }
    if (!selectedDataset) return;
    await loadIntelligence({
      domain: selectedDomain,
      table: selectedDataset,
      preset: nextPreset,
      overrides: columnOverrides,
      tz: timezone,
      rules: alertRules,
      periodStart: useManual ? manualPeriodStart : undefined,
      periodEnd: useManual ? manualPeriodEnd : undefined,
      latestAvailableDate: currentTableProfile?.freshness.latestDate || null
    });
  }

  async function handleApplyManualPeriod(start: string, end: string) {
    setManualPeriodStart(start);
    setManualPeriodEnd(end);
    if (!selectedDataset) return;
    await loadIntelligence({
      domain: selectedDomain,
      table: selectedDataset,
      preset: comparisonPreset,
      overrides: columnOverrides,
      tz: timezone,
      rules: alertRules,
      periodStart: start,
      periodEnd: end,
      latestAvailableDate: currentTableProfile?.freshness.latestDate || null
    });
  }

  async function handleClearManualPeriod() {
    setManualPeriodStart("");
    setManualPeriodEnd("");
    if (!selectedDataset) return;
    await loadIntelligence({
      domain: selectedDomain,
      table: selectedDataset,
      preset: comparisonPreset,
      overrides: columnOverrides,
      tz: timezone,
      rules: alertRules,
      latestAvailableDate: currentTableProfile?.freshness.latestDate || null
    });
  }

  const triggerScheduledRun = useCallback(async (forceRun = false) => {
    if (runningScheduledRef.current) return;
    runningScheduledRef.current = true;
    try {
      const response = await fetch("/api/daily-analysis/reports/run-scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forceRun,
          dataset: selectedDataset || undefined,
          domain: selectedDomain || undefined,
          comparisonPreset
        })
      });
      const data = await response.json();
      if (!response.ok) {
        return;
      }
      if (data.storageStatus) {
        setStorageStatus(data.storageStatus as StorageCapabilityStatus);
      }
      if (data.generated) {
        const latestAuto = data.latestAutomaticReport as PersistentReportSummary | null;
        if (latestAuto && typeof data.pdfBase64 === "string" && data.pdfBase64.length > 0) {
          pdfCacheRef.current.set(latestAuto.id, {
            base64: data.pdfBase64,
            filename: latestAuto.pdfFilename || `querypilot-x-${latestAuto.domainId}-${latestAuto.periodStart}-to-${latestAuto.periodEnd}.pdf`
          });
        }
        const periodSummary = latestAuto ? ` (${latestAuto.periodStart} to ${latestAuto.periodEnd})` : "";
        const confirmText = `Automatic PDF generated successfully${periodSummary} and ready to download.`;
        setSaveFeedback({ type: "success", text: confirmText });
        setPdfGenerateNotice(confirmText);
        if (latestAuto) {
          setArchivedReports(prev => [latestAuto, ...prev.filter(item => item.id !== latestAuto.id)]);
          setScheduleSummary(prev => (prev ? { ...prev, latestAutomaticReport: latestAuto } : prev));
        }
        void loadArchiveReports();
      }
    } catch {
      // Background scheduled check errors are non-blocking
    } finally {
      runningScheduledRef.current = false;
    }
  }, [comparisonPreset, loadArchiveReports, selectedDataset, selectedDomain]);

  // Watch the configured schedule clock while the dashboard is open and auto-generate when due
  useEffect(() => {
    if (!settings?.autoReportEnabled || !selectedDataset) return;
    const checkDue = () => {
      const clock = getCurrentClockInTz(settings.timezone || "Asia/Dhaka");
      const dueTime = settings.scheduledTime || "00:15";
      if (clock.time < dueTime) return;
      const checkKey = `${clock.date}|${settings.frequency}|${dueTime}|${selectedDataset}`;
      if (lastScheduledCheckKeyRef.current === checkKey) return;
      lastScheduledCheckKeyRef.current = checkKey;
      void triggerScheduledRun(false);
    };
    checkDue();
    const timer = window.setInterval(checkDue, 20_000);
    return () => window.clearInterval(timer);
  }, [
    selectedDataset,
    settings?.autoReportEnabled,
    settings?.frequency,
    settings?.scheduledTime,
    settings?.timezone,
    triggerScheduledRun
  ]);

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
      const savedSettings = data.settings as PersistentDailySettings;
      setSettings(savedSettings);
      if (data.storageStatus) setStorageStatus(data.storageStatus as StorageCapabilityStatus);
      if (data.scheduleSummary) setScheduleSummary(data.scheduleSummary as ScheduleRuntimeSummary);
      lastScheduledCheckKeyRef.current = "";

      setSaveFeedback({
        type: "success",
        text: savedSettings.autoReportEnabled
          ? `Schedule updated (${savedSettings.frequency} at ${savedSettings.scheduledTime} ${savedSettings.timezone}). Automatic PDF will generate when due.`
          : "Automatic report generation paused."
      });
      if (savedSettings.autoReportEnabled) {
        const clock = getCurrentClockInTz(savedSettings.timezone || "Asia/Dhaka");
        if (clock.time >= savedSettings.scheduledTime) {
          void triggerScheduledRun(false);
        }
      }
    } catch (error) {
      setSaveFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "Could not save schedule settings."
      });
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleGeneratePdf(requestPayload: UnifiedPdfGenerateRequest) {
    if (generatingPdf || !selectedDataset) return;
    setGeneratingPdf(true);
    setPdfGenerateError(null);
    setPdfGenerateNotice(null);
    try {
      const earliest = currentTableProfile?.freshness.earliestDate?.slice(0, 10) || null;
      const latest = currentTableProfile?.freshness.latestDate?.slice(0, 10) || null;
      const startDate = requestPayload.startDate?.trim() || "";
      const endDate = requestPayload.endDate?.trim() || "";
      const hasManualDates = Boolean(startDate && endDate);

      const quickRange: "all_history" | "last_30_days" | "custom" = hasManualDates
        ? "custom"
        : requestPayload.comparisonPreset === "none"
          ? "all_history"
          : "last_30_days";

      const response = await fetch("/api/daily-analysis/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "manual",
          table: selectedDataset,
          domain: selectedDomain,
          quickRange,
          ...(hasManualDates ? { startDate, endDate } : {}),
          comparisonPreset: requestPayload.comparisonPreset,
          anchorToDatasetDates: !hasManualDates,
          timezone,
          overrides: Object.keys(columnOverrides).length ? columnOverrides : undefined,
          earliestAvailableDate: earliest || undefined,
          latestAvailableDate: latest || undefined
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not generate and store the PDF report.");
      }
      const created = data.report as PersistentReportRecord;
      if (created.pdfStatus === "generated") {
        const filename = created.pdfFilename || `querypilot-x-${created.domainId}-${created.periodStart}-to-${created.periodEnd}.pdf`;
        if (typeof data.pdfBase64 === "string" && data.pdfBase64.length > 0) {
          pdfCacheRef.current.set(created.id, {
            base64: data.pdfBase64,
            filename
          });
        }
        setPdfGenerateNotice(
          `PDF generated successfully (${created.periodStart} to ${created.periodEnd}) and ready to download.`
        );
        // Immediately reflect the new PDF in Latest Stored PDF & Archive
        setArchivedReports(prev => [created, ...prev.filter(item => item.id !== created.id)]);
      } else {
        setPdfGenerateError(created.pdfError || "Report metadata saved, but PDF storage did not complete.");
      }
      void loadArchiveReports();
    } catch (error) {
      setPdfGenerateError(error instanceof Error ? error.message : "Could not generate and store the PDF report.");
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleDownloadPdf(report: PersistentReportSummary | PersistentReportRecord, compareWithId?: string) {
    if (downloadingReportId) return;
    setDownloadingReportId(report.id);
    setPdfDownloadError(null);
    try {
      const suffix = compareWithId ? "-comparison" : "";
      const fallbackFilename = report.pdfFilename || `querypilot-x-${report.domainId}-${report.periodStart}-to-${report.periodEnd}${suffix}.pdf`;

      // Fast, serverless-safe download from verified in-session PDF cache when available
      if (!compareWithId) {
        const cached = pdfCacheRef.current.get(report.id);
        if (cached) {
          triggerPdfBlobDownload(base64ToPdfBlob(cached.base64), cached.filename || fallbackFilename);
          return;
        }
      }

      const isCloudDirect = !compareWithId && report.id.startsWith("cloud_") && Boolean(report.pdfStorageKey);
      const endpoint = isCloudDirect && report.pdfStorageKey
        ? `/api/storage/download?key=${encodeURIComponent(report.pdfStorageKey)}`
        : `/api/daily-analysis/reports/${encodeURIComponent(report.id)}/pdf${compareWithId ? `?compareWith=${encodeURIComponent(compareWithId)}` : ""}`;
      const response = await fetch(endpoint, {
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
      triggerPdfBlobDownload(blob, fallbackFilename);
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
          <span className={styles.eyebrow}>REPORT AUTOMATION &amp; LIVE INTELLIGENCE</span>
          <h1 className={styles.pageTitle}>Daily Analysis</h1>
          <p className={styles.pageSubtitle}>
            Automated Daily/Weekly/Monthly PDF reporting and all 7 live Daily Analysis tools displayed directly in one unified view.
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

      {/* Dynamic Business Domain, Dataset & Automatic Column Understanding Bar */}
      <DomainDatasetBar
        selectedDomain={selectedDomain}
        selectedDataset={selectedDataset}
        profile={profile}
        availableTables={availableTables}
        understanding={currentUnderstanding}
        columnOverrides={columnOverrides}
        loadingProfile={loadingProfile}
        loadingAnalysis={loadingIntelligence}
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
            void loadIntelligence({
              domain: selectedDomain,
              table: selectedDataset,
              preset: comparisonPreset,
              overrides: {},
              tz: timezone,
              rules: alertRules
            });
          }
        }}
        onApplyOverrides={() => {
          if (!selectedDataset) return;
          void loadIntelligence({
            domain: selectedDomain,
            table: selectedDataset,
            preset: comparisonPreset,
            overrides: columnOverrides,
            tz: timezone,
            rules: alertRules
          });
        }}
        onRefreshAll={() => void handleRefreshAll()}
      />

      {/* Report Automation & Integrated PDF Generator */}
      <DailyReportPanel
        settings={settings}
        selectedDataset={selectedDataset}
        storageStatus={storageStatus}
        scheduleSummary={scheduleSummary}
        latestStoredReport={archivedReports[0] || scheduleSummary?.latestAutomaticReport || null}
        earliestAvailableDate={currentTableProfile?.freshness.earliestDate?.slice(0, 10) || null}
        latestAvailableDate={currentTableProfile?.freshness.latestDate?.slice(0, 10) || null}
        defaultComparisonPreset={comparisonPreset}
        loadingSettings={loadingSettings}
        savingSchedule={savingSchedule}
        generatingPdf={generatingPdf}
        pdfGenerateError={pdfGenerateError}
        pdfGenerateNotice={pdfGenerateNotice}
        downloadingReportId={downloadingReportId}
        saveFeedback={saveFeedback}
        onSaveSchedule={handleSaveSchedule}
        onGeneratePdf={handleGeneratePdf}
        onDownloadPdf={report => handleDownloadPdf(report)}
      />

      {/* All 7 Daily Analysis Tools rendered directly as expanded cards */}
      <DailyToolsSection
        intelligence={intelligence}
        loadingIntelligence={loadingIntelligence}
        intelligenceError={intelligenceError}
        comparisonPreset={comparisonPreset}
        onComparisonPresetChange={preset => void handleComparisonPresetChange(preset)}
        manualPeriodStart={manualPeriodStart}
        manualPeriodEnd={manualPeriodEnd}
        earliestAvailableDate={currentTableProfile?.freshness.earliestDate?.slice(0, 10) || null}
        latestAvailableDate={currentTableProfile?.freshness.latestDate?.slice(0, 10) || null}
        onApplyManualPeriod={(start, end) => void handleApplyManualPeriod(start, end)}
        onClearManualPeriod={() => void handleClearManualPeriod()}
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
      />
    </div>
  );
}
