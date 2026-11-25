import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deriveUserIdFromSession } from "@/lib/storage/session-auth";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { createSessionQueryExecutor } from "@/../daily_data_analysis_and_notification/profiler";
import { runUnifiedDailyAnalysisWithExecutor } from "@/../daily_data_analysis_and_notification/intelligence";
import type { ComparisonPreset } from "@/../daily_data_analysis_and_notification/metrics";
import {
  assertValidPdfBuffer,
  buildHistoricalContextForReport,
  buildPdfMetadataFromRecord,
  buildReportPdfFilename,
  getDefaultDailySettings,
  getPersistentReportRepository,
  getPreviousCompletedPeriod,
  getStorageCapabilityStatus,
  isScheduleDueNow,
  renderValidatedPdfForPayload,
  runScheduledReports,
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

/**
 * Authenticated session-backed runner for due automatic reports.
 * Works with BOTH PostgreSQL/SQLite repository AND directly with the team's shared
 * Supabase Storage (`src/lib/storage/service.ts`) so scheduled PDFs are generated and
 * stored permanently across every device without requiring extra database setup.
 */
export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let forceRun = false;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body?.forceRun === "boolean") {
      forceRun = body.forceRun;
    }
  } catch {
    // Empty body is valid
  }

  const organizationId = deriveOrganizationId(access.session);
  const storageUserId = deriveUserIdFromSession(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);
  const executor = createSessionQueryExecutor(access.session);

  try {
    const repository = getPersistentReportRepository();
    const result = await runScheduledReports({
      repository,
      resolveSourceExecutor: async orgId => (orgId === organizationId ? executor : null),
      storageUserId,
      organizationIdFilter: organizationId,
      forceDue: forceRun
    });

    const autoList = await repository.listReports({
      organizationId,
      generationType: "automatic",
      defaultDays: 0,
      page: 1,
      pageSize: 1
    });

    const generated = result.outcomes.some(o => o.status === "generated" || o.status === "retried_pdf");
    const failedOutcome = result.outcomes.find(o => o.status === "failed");

    return access.applyCookie(NextResponse.json(
      {
        scheduler: result,
        generated,
        latestAutomaticReport: autoList.items[0] || null,
        error: failedOutcome?.error || null,
        storageStatus
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (repoError) {
    const repoMsg = repoError instanceof Error ? repoError.message : "";
    const isRepoUnavailable = /development mode|not configured|QUERYPILOT_APP_DATABASE_URL|DATABASE_URL/i.test(repoMsg);
    if (!isRepoUnavailable) {
      return NextResponse.json(
        { error: repoMsg || "Could not execute scheduled report.", storageStatus },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Shared Supabase Storage mode (no Postgres/SQLite needed!)
    try {
      const envelope = await loadSharedSettingsEnvelope(storageUserId);
      const settings = envelope?.settings || getDefaultDailySettings(organizationId);
      if (!settings.selectedDataset) {
        return access.applyCookie(NextResponse.json(
          {
            generated: false,
            latestAutomaticReport: null,
            error: forceRun ? "Save your schedule with a connected dataset selected first." : null,
            storageStatus
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
            storageStatus
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
            storageStatus
          },
          { headers: { "Cache-Control": "no-store" } }
        ));
      }

      const comparisonPreset: ComparisonPreset = settings.frequency === "daily"
        ? settings.comparisonPreset || "previous_day"
        : settings.frequency === "weekly"
          ? "previous_week"
          : "previous_month";

      const unified = await runUnifiedDailyAnalysisWithExecutor(executor, settings.selectedDataset, {
        domainId: settings.selectedDomain,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: settings.timezone,
        comparisonPreset,
        overrides: settings.columnOverrides,
        alertRules: settings.alertRules,
        expectedCadence: settings.expectedCadence,
        now
      });

      const historicalContext = await buildHistoricalContextForReport({
        executor,
        tableName: settings.selectedDataset,
        domainId: unified.domainId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
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
        reportingDate: period.reportingDate,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        comparisonStart: unified.comparisonPeriod?.start ?? null,
        comparisonEnd: unified.comparisonPeriod?.end ?? null,
        comparisonPreset: unified.comparisonPeriod?.preset ?? null,
        frequency: settings.frequency,
        generationType: "automatic",
        executionKey: null,
        status: "generated",
        summaryText: unified.tools.intelligenceBrief?.executiveSummary
          || `${unified.domainName} ${settings.frequency} report (${period.periodStart} to ${period.periodEnd})`,
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
          datasetTable: record.datasetTable,
          frequency: settings.frequency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          generationType: "automatic"
        }
      });

      await saveSharedSettingsEnvelope(storageUserId, settings, {
        [settings.frequency]: period.periodEnd
      });

      const { reportPayload: _omitPayload, ...summary } = record;
      const latestAutomaticReport = {
        ...summary,
        id: `cloud_${uploaded.fileId}`,
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
          storageStatus
        },
        { headers: { "Cache-Control": "no-store" } }
      ));
    } catch (cloudError) {
      const message = cloudError instanceof Error ? cloudError.message : "Could not generate automatic scheduled PDF.";
      return NextResponse.json(
        { error: message, storageStatus },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
}
