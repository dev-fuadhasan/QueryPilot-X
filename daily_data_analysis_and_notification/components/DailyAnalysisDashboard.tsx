"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Clock,
  FileSpreadsheet
} from "lucide-react";
import type { BusinessDomainId, DatabaseProfile } from "../profiler/types";
import type { ComparisonPreset } from "../metrics/types";
import type { ReportArchiveComparisonResult, UnifiedDailyAnalysisResult } from "../intelligence/types";
import { DEFAULT_ALERT_RULES, sanitizeAlertRules, type AlertRules } from "../notifications";
import type {
  ManualQuickRange,
  PersistentDailySettings,
  PersistentReportRecord,
  PersistentReportSummary,
  ReportFrequency,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";
import {
  createStaleResetSnapshot,
  formatShortTimestamp,
  mergeToolAlertsWithReadState,
  type DashboardSectionTab
} from "./dashboard-helpers";
import DomainDatasetBar from "./DomainDatasetBar";
import DailyReportPanel from "./DailyReportPanel";
import ManualReportPanel from "./ManualReportPanel";
import DailyToolsSection from "./DailyToolsSection";
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

  const [intelligence, setIntelligence] = useState<UnifiedDailyAnalysisResult | null>(null);
  const [loadingIntelligence, setLoadingIntelligence] = useState<boolean>(false);
  const [intelligenceError, setIntelligenceError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const [generatingManual, setGeneratingManual] = useState<boolean>(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<PersistentReportRecord | null>(null);

  const [archivedReports, setArchivedReports] = useState<PersistentReportSummary[]>([]);
  const [loadingArchive, setLoadingArchive] = useState<boolean>(false);
  const [archiveComparison, setArchiveComparison] = useState<ReportArchiveComparisonResult | null>(null);
  const [comparingArchive, setComparingArchive] = useState<boolean>(false);
  const [archiveCompareError, setArchiveCompareError] = useState<string | null>(null);

  const [readAlertIds, setReadAlertIds] = useState<Set<string>>(() => new Set());
  const [savingAlertRules, setSavingAlertRules] = useState<boolean>(false);
  const [downloadingReportId, setDownloadingReportId] = useState<string | null>(null);
  const [pdfDownloadError, setPdfDownloadError] = useState<string | null>(null);

  // Request sequence guards prevent stale async responses from flashing after a domain/dataset switch
  const profileSeqRef = useRef(0);
  const intelSeqRef = useRef(0);
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

  const loadArchiveReports = useCallback(async () => {
    setLoadingArchive(true);
    try {
      const response = await fetch("/api/daily-analysis/reports?page=1&pageSize=20", { cache: "no-store" });
      const data = await response.json();
      if (response.ok && Array.isArray(data.reports)) {
        setArchivedReports(data.reports as PersistentReportSummary[]);
      }
    } catch {
      // keep existing archive state
    } finally {
      setLoadingArchive(false);
    }
  }, []);

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

  // Initial load: read persistent settings + profile connected DB + load archive
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
        // Keep safe defaults if settings request fails
      } finally {
        setLoadingSettings(false);
      }

      const [profileResult] = await Promise.all([
        loadProfile(initialDomain, initialTable),
        loadArchiveReports()
      ]);

      const tableToRun = profileResult?.resolvedTable || initialTable || "";
      if (tableToRun) {
        await loadIntelligence({
          domain: initialDomain,
          table: tableToRun,
          preset: "previous_day",
          overrides: initialOverrides,
          tz: initialTz,
          rules: initialRules
        });
      }
    })();
  }, [loadArchiveReports, loadIntelligence, loadProfile]);

  // Event-driven refresh hook prepared for Stage 7 live update integration (without claiming active real-time push today)
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
  }, [alertRules, columnOverrides, comparisonPreset, loadArchiveReports, loadIntelligence, selectedDataset, selectedDomain, timezone]);

  function resetStaleResults() {
    const reset = createStaleResetSnapshot();
    setIntelligence(reset.intelligence);
    setManualResult(reset.manualResult);
    setArchiveComparison(reset.archiveComparison);
    setManualError(null);
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
    if (nextTable) {
      await loadIntelligence({
        domain: selectedDomain,
        table: nextTable,
        preset: comparisonPreset,
        overrides: {},
        tz: timezone,
        rules: alertRules
      });
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
      loadArchiveReports()
    ]);
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
          // ignore non-json error body
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
          <span className={styles.eyebrow}>DAILY INTELLIGENCE &amp; AUTOMATED REPORTING</span>
          <h1 className={styles.pageTitle}>Daily Analysis</h1>
          <p className={styles.pageSubtitle}>
            Automated Daily/Weekly/Monthly PDF reporting, on-demand manual reports, and live multi-domain business intelligence across your connected read-only database.
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

      {/* Global errors (profile or PDF download) */}
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

      {/* Primary 3-section navigation: Daily Report | Manual Report | Daily Analysis Tools */}
      <nav className={styles.sectionNav} aria-label="Daily Analysis main sections">
        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "daily_report" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "daily_report" ? "page" : undefined}
          onClick={() => setActiveTab("daily_report")}
        >
          <span className={styles.sectionTabIcon}><CalendarClock size={18} /></span>
          <span className={styles.sectionTabText}>
            <strong>Daily Report</strong>
            <small>Automatic Daily, Weekly &amp; Monthly PDF schedule</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "manual_report" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "manual_report" ? "page" : undefined}
          onClick={() => setActiveTab("manual_report")}
        >
          <span className={styles.sectionTabIcon}><FileSpreadsheet size={18} /></span>
          <span className={styles.sectionTabText}>
            <strong>Manual Report</strong>
            <small>Quick ranges (7–365d, all history) &amp; custom dates</small>
          </span>
        </button>

        <button
          type="button"
          className={`${styles.sectionTab} ${activeTab === "tools" ? styles.sectionTabActive : ""}`}
          aria-current={activeTab === "tools" ? "page" : undefined}
          onClick={() => setActiveTab("tools")}
        >
          <span className={styles.sectionTabIcon}><Activity size={18} /></span>
          <span className={styles.sectionTabText}>
            <strong>Daily Analysis Tools</strong>
            <small>Brief, Comparison, Alerts, Root Cause, Actions &amp; Health</small>
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

      {/* Section 1: Daily Report (Primary Feature) */}
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

      {/* Section 2: Manual Report Generation */}
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
        />
      )}
    </div>
  );
}
