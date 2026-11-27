import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deriveUserIdFromSession } from "@/lib/storage/session-auth";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import {
  BUSINESS_DOMAIN_IDS,
  createSessionQueryExecutor,
  isValidIdentifier,
  type BusinessDomainId
} from "@/../daily_data_analysis_and_notification/profiler";
import { runUnifiedDailyAnalysisWithExecutor } from "@/../daily_data_analysis_and_notification/intelligence";
import type { ComparisonPreset } from "@/../daily_data_analysis_and_notification/metrics";
import {
  assertValidPdfBuffer,
  buildHistoricalContextForReport,
  buildPdfMetadataFromRecord,
  buildReportPdfFilename,
  createDefaultPdfStorage,
  getDefaultDailySettings,
  getPersistentReportRepository,
  getPreviousCompletedPeriod,
  getStorageCapabilityStatus,
  isScheduleDueNow,
  renderValidatedPdfForPayload,
  resolveSharedPdfStorageEnv,
  runScheduledReports,
  type PersistentDailySettings,
  type PersistentReportRecord
} from "@/../daily_data_analysis_and_notification/storage";
import {
  listDailyPdfsFromSharedStorage,
  loadSharedSettingsEnvelope,
  saveSharedSettingsEnvelope,
  uploadDailyPdfToSharedStorage
} from "@/../daily_data_analysis_and_notification/storage/shared-cloud-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_COMPARISON_PRESETS = new Set<ComparisonPreset>([
  "previous_day",
  "previous_week",
  "previous_month",
  "previous_7_days",
  "previous_30_days",
  "previous_90_days",
  "previous_180_days",
  "previous_365_days",
  "same_weekday_previous_weeks",
  "custom",
  "none"
]);

/**
 * Authenticated session-backed runner for due automatic reports.
 * Uses the exact same dataset-anchored Smart Comparison date logic so automatic PDFs
 * always analyze real active dataset periods instead of empty wall-clock dates.
 */
export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let forceRun = false;
  let requestedDataset: string | null = null;
  let requestedDomain: BusinessDomainId | null = null;
  let requestedComparisonPreset: ComparisonPreset | undefined;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body?.forceRun === "boolean") {
      forceRun = body.forceRun;
    }
    if (typeof body?.dataset === "string" && isValidIdentifier(body.dataset.trim())) {
      requestedDataset = body.dataset.trim();
    }
    if (typeof body?.domain === "string" && (BUSINESS_DOMAIN_IDS as readonly string[]).includes(body.domain)) {
      requestedDomain = body.domain as BusinessDomainId;
    }
    if (typeof body?.comparisonPreset === "string" && ALLOWED_COMPARISON_PRESETS.has(body.comparisonPreset as ComparisonPreset)) {
      requestedComparisonPreset = body.comparisonPreset as ComparisonPreset;
    }
  } catch {
    // Empty body is valid
  }

  const organizationId = deriveOrganizationId(access.session);
  const storageUserId = deriveUserIdFromSession(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);
  const storageMode = resolveSharedPdfStorageEnv().configured ? "cloud" : "local_temporary";
  const executor = createSessionQueryExecutor(access.session);

  try {
    const repository = getPersistentReportRepository();

    // Ensure "Run Auto PDF Now" works even if the user has not clicked Save Schedule yet
    if (forceRun) {
      const existingSettings = await repository.getSettings(organizationId);
      if (!existingSettings || !existingSettings.selectedDataset) {
        const fallbackDataset = existingSettings?.selectedDataset || requestedDataset;
        if (fallbackDataset) {
          const base = existingSettings || getDefaultDailySettings(organizationId);
          const merged: PersistentDailySettings = {
            ...base,
            selectedDataset: fallbackDataset,
            selectedDomain: requestedDomain || base.selectedDomain,
            autoReportEnabled: true
          };
          await repository.saveSettings(merged);
          await saveSharedSettingsEnvelope(storageUserId, merged).catch(() => undefined);
        }
      } else if (!existingSettings.autoReportEnabled) {
        // Temporarily honor forceRun for saved schedule by generating directly if scheduler skips disabled schedule
      }
    }

    const result = await runScheduledReports({
      repository,
      resolveSourceExecutor: async orgId => (orgId === organizationId ? executor : null),
      storageUserId,
      organizationIdFilter: organizationId,
      forceDue: forceRun,
      anchorToDatasetDates: true,
      comparisonPresetOverride: requestedComparisonPreset
    });

    let generated = result.outcomes.some(o => o.status === "generated" || o.status === "retried_pdf");
    const failedOutcome = result.outcomes.find(o => o.status === "failed");

    let autoList = await repository.listReports({
      organizationId,
      generationType: "automatic",
      defaultDays: 0,
      page: 1,
      pageSize: 1
    });

    // If forceRun was requested but skipped (e.g., autoReportEnabled=false or previous run had missing/failed PDF),
    // generate and store a fresh automatic PDF for the latest completed period right now.
    if (forceRun && !generated && !failedOutcome) {
      const savedSettings = await repository.getSettings(organizationId);
      const effectiveSettings: PersistentDailySettings = {
        ...(savedSettings || getDefaultDailySettings(organizationId)),
        selectedDataset: savedSettings?.selectedDataset || requestedDataset,
        selectedDomain: savedSettings?.selectedDomain || requestedDomain || "sales_ecommerce"
      };

      const existingLatest = autoList.items[0] || null;
      const pdfStorage = createDefaultPdfStorage();
      let existingPdfValid = false;
      if (existingLatest && existingLatest.pdfStatus === "generated" && existingLatest.pdfStorageKey) {
        const bytes = await pdfStorage.readPdf(existingLatest.pdfStorageKey).catch(() => null);
        if (bytes) {
          try {
            assertValidPdfBuffer(bytes);
            existingPdfValid = true;
          } catch {
            existingPdfValid = false;
          }
        }
      }

      if (effectiveSettings.selectedDataset && (!existingLatest || !existingPdfValid)) {
        const now = new Date();
        const period = getPreviousCompletedPeriod(effectiveSettings.frequency, effectiveSettings.timezone, now);
        const comparisonPreset: ComparisonPreset = requestedComparisonPreset
          || (effectiveSettings.frequency === "daily"
            ? "previous_day"
            : effectiveSettings.frequency === "weekly"
              ? "previous_week"
              : "previous_month");

        const unified = await runUnifiedDailyAnalysisWithExecutor(executor, effectiveSettings.selectedDataset, {
          domainId: effectiveSettings.selectedDomain,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          timezone: effectiveSettings.timezone,
          comparisonPreset,
          overrides: effectiveSettings.columnOverrides,
          allowMediumConfidence: true,
          includeAllDatasetColumns: true,
          anchorToDatasetDates: true,
          alertRules: effectiveSettings.alertRules,
          expectedCadence: effectiveSettings.expectedCadence,
          now
        });

        const resolvedStart = unified.analysis.reportingPeriod.start;
        const resolvedEnd = unified.analysis.reportingPeriod.end;

        const historicalContext = await buildHistoricalContextForReport({
          executor,
          tableName: effectiveSettings.selectedDataset,
          domainId: unified.domainId,
          periodStart: resolvedStart,
          periodEnd: resolvedEnd,
          frequency: effectiveSettings.frequency,
          timezone: effectiveSettings.timezone,
          overrides: effectiveSettings.columnOverrides,
          now
        });

        const reportPayloadWithContext: Record<string, unknown> = {
          ...(unified as unknown as Record<string, unknown>),
          ...(historicalContext ? { historicalContext } : {})
        };

        const persisted = await repository.saveReport({
          id: randomUUID(),
          organizationId,
          ownerRef: storageUserId,
          domainId: unified.domainId,
          domainName: unified.domainName,
          datasetTable: unified.tableName,
          reportingDate: resolvedEnd,
          periodStart: resolvedStart,
          periodEnd: resolvedEnd,
          comparisonStart: unified.comparisonPeriod?.start ?? null,
          comparisonEnd: unified.comparisonPeriod?.end ?? null,
          comparisonPreset: unified.comparisonPeriod?.preset ?? null,
          frequency: effectiveSettings.frequency,
          generationType: "automatic",
          executionKey: null,
          status: "generated",
          summaryText: unified.tools.intelligenceBrief?.executiveSummary
            || `${unified.domainName} ${effectiveSettings.frequency} report (${resolvedStart} to ${resolvedEnd})`,
          reportPayload: reportPayloadWithContext,
          pdfStatus: "not_generated",
          pdfStorageKey: null,
          pdfFilename: null,
          pdfGeneratedAt: null,
          pdfSizeBytes: null,
          pdfError: null,
          errorMessage: null,
          generatedAt: unified.generatedAt
        });

        const filename = buildReportPdfFilename(persisted);
        const pdfBytes = await renderValidatedPdfForPayload(persisted.reportPayload, "automatic", {
          metadata: buildPdfMetadataFromRecord(persisted, access.session.projectName || organizationId),
          historicalContext
        });
        assertValidPdfBuffer(pdfBytes);

        const stored = await pdfStorage.savePdf({
          organizationId,
          storageUserId,
          reportId: persisted.id,
          filename,
          bytes: pdfBytes
        });
        const verifyBytes = await pdfStorage.readPdf(stored.storageKey);
        if (!verifyBytes) {
          throw new Error("PDF persistence verification failed: stored file could not be read back.");
        }
        assertValidPdfBuffer(verifyBytes);

        await repository.updateReportPdfMetadata(organizationId, persisted.id, {
          pdfStatus: "generated",
          pdfStorageKey: stored.storageKey,
          pdfFilename: stored.filename,
          pdfGeneratedAt: new Date().toISOString(),
          pdfSizeBytes: stored.sizeBytes,
          pdfError: null
        });
        await repository.setScheduleCursor(organizationId, effectiveSettings.frequency, period.periodEnd);

        generated = true;
        autoList = await repository.listReports({
          organizationId,
          generationType: "automatic",
          defaultDays: 0,
          page: 1,
          pageSize: 1
        });
      }
    }

    const latestAuto = autoList.items[0] || null;
    let pdfBase64: string | undefined;
    if (generated && storageMode !== "cloud" && latestAuto?.pdfStatus === "generated" && latestAuto.pdfStorageKey) {
      const storedBytes = await createDefaultPdfStorage().readPdf(latestAuto.pdfStorageKey).catch(() => null);
      if (storedBytes) {
        pdfBase64 = storedBytes.toString("base64");
      }
    }

    return access.applyCookie(NextResponse.json(
      {
        scheduler: result,
        generated,
        latestAutomaticReport: latestAuto,
        error: failedOutcome?.error || null,
        storageStatus,
        storageMode,
        ...(pdfBase64 ? { pdfBase64 } : {})
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (repoError) {
    const repoMsg = repoError instanceof Error ? repoError.message : "";
    const isRepoUnavailable = /development mode|not configured|QUERYPILOT_APP_DATABASE_URL|DATABASE_URL/i.test(repoMsg);
    if (!isRepoUnavailable) {
      return NextResponse.json(
        { error: repoMsg || "Could not execute scheduled report.", storageStatus, storageMode },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Direct storage mode (automatically uses Cloud if configured, else temporary local folder `generated-reports/`)
    try {
      const envelope = await loadSharedSettingsEnvelope(storageUserId);
      const baseSettings = envelope?.settings || getDefaultDailySettings(organizationId);
      const settings: PersistentDailySettings = {
        ...baseSettings,
        selectedDataset: baseSettings.selectedDataset || (forceRun ? requestedDataset : null),
        selectedDomain: baseSettings.selectedDataset ? baseSettings.selectedDomain : (requestedDomain || baseSettings.selectedDomain)
      };

      if (!settings.selectedDataset) {
        return access.applyCookie(NextResponse.json(
          {
            generated: false,
            latestAutomaticReport: null,
            error: forceRun ? "Save your schedule with a connected dataset selected first." : null,
            storageStatus,
            storageMode
          },
          { headers: { "Cache-Control": "no-store" } }
        ));
      }

      const now = new Date();
      const cursor = envelope?.cursors?.[settings.frequency] ?? null;
      const due = forceRun || isScheduleDueNow(settings, cursor, now);
      if (!due) {
        const existing = await listDailyPdfsFromSharedStorage(storageUserId, organizationId).catch(() => []);
        return access.applyCookie(NextResponse.json(
          {
            generated: false,
            latestAutomaticReport: existing.find(r => r.generationType === "automatic") || existing[0] || null,
            error: null,
            storageStatus,
            storageMode
          },
          { headers: { "Cache-Control": "no-store" } }
        ));
      }

      const period = getPreviousCompletedPeriod(settings.frequency, settings.timezone, now);
      if (!forceRun && cursor && cursor >= period.periodEnd) {
        const existing = await listDailyPdfsFromSharedStorage(storageUserId, organizationId).catch(() => []);
        return access.applyCookie(NextResponse.json(
          {
            generated: false,
            latestAutomaticReport: existing.find(r => r.generationType === "automatic") || existing[0] || null,
            error: null,
            storageStatus,
            storageMode
          },
          { headers: { "Cache-Control": "no-store" } }
        ));
      }

      const comparisonPreset: ComparisonPreset = requestedComparisonPreset
        || (settings.frequency === "daily"
          ? "previous_day"
          : settings.frequency === "weekly"
            ? "previous_week"
            : "previous_month");

      const unified = await runUnifiedDailyAnalysisWithExecutor(executor, settings.selectedDataset, {
        domainId: settings.selectedDomain,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: settings.timezone,
        comparisonPreset,
        overrides: settings.columnOverrides,
        allowMediumConfidence: true,
        includeAllDatasetColumns: true,
        anchorToDatasetDates: true,
        alertRules: settings.alertRules,
        expectedCadence: settings.expectedCadence,
        now
      });

      const resolvedStart = unified.analysis.reportingPeriod.start;
      const resolvedEnd = unified.analysis.reportingPeriod.end;

      const historicalContext = await buildHistoricalContextForReport({
        executor,
        tableName: settings.selectedDataset,
        domainId: unified.domainId,
        periodStart: resolvedStart,
        periodEnd: resolvedEnd,
        frequency: settings.frequency,
        timezone: settings.timezone,
        overrides: settings.columnOverrides,
        now
      });

      const reportPayloadWithContext: Record<string, unknown> = {
        ...(unified as unknown as Record<string, unknown>),
        ...(historicalContext ? { historicalContext } : {})
      };

      const record: PersistentReportRecord = {
        id: randomUUID(),
        organizationId,
        ownerRef: storageUserId,
        domainId: unified.domainId,
        domainName: unified.domainName,
        datasetTable: unified.tableName,
        reportingDate: resolvedEnd,
        periodStart: resolvedStart,
        periodEnd: resolvedEnd,
        comparisonStart: unified.comparisonPeriod?.start ?? null,
        comparisonEnd: unified.comparisonPeriod?.end ?? null,
        comparisonPreset: unified.comparisonPeriod?.preset ?? null,
        frequency: settings.frequency,
        generationType: "automatic",
        executionKey: null,
        status: "generated",
        summaryText: unified.tools.intelligenceBrief?.executiveSummary
          || `${unified.domainName} ${settings.frequency} report (${resolvedStart} to ${resolvedEnd})`,
        reportPayload: reportPayloadWithContext,
        pdfStatus: "not_generated",
        pdfStorageKey: null,
        pdfFilename: null,
        pdfGeneratedAt: null,
        pdfSizeBytes: null,
        pdfError: null,
        errorMessage: null,
        generatedAt: unified.generatedAt,
        createdAt: unified.generatedAt
      };

      const filename = buildReportPdfFilename(record);
      const pdfBytes = await renderValidatedPdfForPayload(record.reportPayload, "automatic", {
        metadata: buildPdfMetadataFromRecord(record, access.session.projectName || organizationId),
        historicalContext
      });
      assertValidPdfBuffer(pdfBytes);

      const uploaded = await uploadDailyPdfToSharedStorage({
        userId: storageUserId,
        filename,
        bytes: pdfBytes,
        metadata: {
          domainId: record.domainId,
          domainName: record.domainName,
          datasetTable: record.datasetTable,
          frequency: settings.frequency,
          periodStart: resolvedStart,
          periodEnd: resolvedEnd,
          generationType: "automatic",
          summaryText: record.summaryText
        }
      });

      await saveSharedSettingsEnvelope(storageUserId, settings, {
        [settings.frequency]: period.periodEnd
      });

      const isCloud = uploaded.backend === "supabase_storage";
      const { reportPayload: _omitPayload, ...summary } = record;
      const latestAutomaticReport = {
        ...summary,
        id: `${isCloud ? "cloud" : "local"}_${uploaded.fileId}`,
        pdfStatus: "generated" as const,
        pdfStorageKey: uploaded.storageKey,
        pdfFilename: uploaded.filename,
        pdfGeneratedAt: uploaded.createdAt,
        pdfSizeBytes: uploaded.sizeBytes
      };

      return access.applyCookie(NextResponse.json(
        {
          generated: true,
          latestAutomaticReport,
          error: null,
          storageStatus,
          storageMode: isCloud ? "cloud" : "local_temporary",
          ...(!isCloud ? { pdfBase64: pdfBytes.toString("base64") } : {})
        },
        { headers: { "Cache-Control": "no-store" } }
      ));
    } catch (cloudError) {
      const message = cloudError instanceof Error ? cloudError.message : "Could not generate automatic scheduled PDF.";
      return NextResponse.json(
        { error: message, storageStatus, storageMode },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
}
