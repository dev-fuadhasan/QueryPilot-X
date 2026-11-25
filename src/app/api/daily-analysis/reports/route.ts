import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deriveUserIdFromSession } from "@/lib/storage/session-auth";
import { addDays, generateAutomaticReport, generateAutomaticReportForDate, generateHistoricalReport, type HistoricalRange } from "@/../daily_data_analysis_and_notification/analysis-service";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { createSupabaseSalesRepository, type DatasetSelection } from "@/../daily_data_analysis_and_notification/database/supabase-sales-repository";
import {
  BUSINESS_DOMAIN_IDS,
  createSessionQueryExecutor,
  isValidIdentifier,
  profileConnectedDatabase,
  type BusinessDomainId
} from "@/../daily_data_analysis_and_notification/profiler";
import { isValidIsoDate, type ComparisonPreset } from "@/../daily_data_analysis_and_notification/metrics";
import { runUnifiedDailyAnalysisWithExecutor } from "@/../daily_data_analysis_and_notification/intelligence";
import {
  assertValidPdfBuffer,
  buildPdfMetadataFromRecord,
  buildReportPdfFilename,
  generateAndPersistManualReport,
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  renderValidatedPdfForPayload,
  resolveManualReportPeriod,
  type ManualQuickRange,
  type PersistentReportPdfStatus,
  type PersistentReportRecord,
  type PersistentReportStatusFilter,
  type PersistentReportSummary,
  type ReportFrequencyOrManual,
  type ReportGenerationType,
  type ReportHistoryStorageState
} from "@/../daily_data_analysis_and_notification/storage";
import {
  listDailyPdfsFromSharedStorage,
  uploadDailyPdfToSharedStorage
} from "@/../daily_data_analysis_and_notification/storage/shared-cloud-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MANUAL_RANGES = new Set<ManualQuickRange>([
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_365_days",
  "all_history",
  "custom"
]);

function mergeCloudReports(
  repoItems: PersistentReportSummary[],
  cloudItems: PersistentReportSummary[]
): PersistentReportSummary[] {
  const seenKeys = new Set<string>();
  const merged: PersistentReportSummary[] = [];
  for (const item of repoItems) {
    if (item.pdfStorageKey) seenKeys.add(item.pdfStorageKey);
    merged.push(item);
  }
  for (const item of cloudItems) {
    if (item.pdfStorageKey && seenKeys.has(item.pdfStorageKey)) continue;
    merged.push(item);
  }
  return merged.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const params = request.nextUrl.searchParams;
  const page = Number(params.get("page") || 1);
  const pageSize = Number(params.get("pageSize") || params.get("limit") || 20);
  if (!Number.isInteger(page) || page < 1) {
    return NextResponse.json({ error: "page must be a positive integer." }, { status: 400 });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return NextResponse.json({ error: "pageSize must be an integer between 1 and 100." }, { status: 400 });
  }

  const startDate = params.get("start") || undefined;
  const endDate = params.get("end") || undefined;
  if (startDate && !isValidIsoDate(startDate)) {
    return NextResponse.json({ error: "start must use YYYY-MM-DD." }, { status: 400 });
  }
  if (endDate && !isValidIsoDate(endDate)) {
    return NextResponse.json({ error: "end must use YYYY-MM-DD." }, { status: 400 });
  }
  if (startDate && endDate && startDate > endDate) {
    return NextResponse.json({ error: "start must not be after end." }, { status: 400 });
  }

  const domainParam = params.get("domain") || undefined;
  if (domainParam && !(BUSINESS_DOMAIN_IDS as readonly string[]).includes(domainParam)) {
    return NextResponse.json({ error: "Invalid domain filter." }, { status: 400 });
  }

  const tableParam = params.get("table") || undefined;
  if (tableParam && !isValidIdentifier(tableParam)) {
    return NextResponse.json({ error: "Invalid table filter." }, { status: 400 });
  }

  const generationTypeParam = params.get("generationType") || undefined;
  if (generationTypeParam && generationTypeParam !== "automatic" && generationTypeParam !== "manual") {
    return NextResponse.json({ error: "generationType must be 'automatic' or 'manual'." }, { status: 400 });
  }

  const frequencyParam = params.get("frequency") || undefined;
  if (frequencyParam && !["daily", "weekly", "monthly", "manual"].includes(frequencyParam)) {
    return NextResponse.json({ error: "Invalid frequency filter." }, { status: 400 });
  }

  const statusParam = params.get("status") || undefined;
  if (statusParam && !["generated", "failed", "pending"].includes(statusParam)) {
    return NextResponse.json({ error: "status must be 'generated', 'failed', or 'pending'." }, { status: 400 });
  }

  const pdfStatusParam = params.get("pdfStatus") || undefined;
  if (pdfStatusParam && !["generated", "not_generated", "failed"].includes(pdfStatusParam)) {
    return NextResponse.json({ error: "pdfStatus must be 'generated', 'not_generated', or 'failed'." }, { status: 400 });
  }

  const rawSearch = params.get("search")?.trim() || undefined;
  const search = rawSearch ? rawSearch.slice(0, 120) : undefined;

  const includeAllDates = params.get("all") === "true";
  const organizationId = deriveOrganizationId(access.session);
  const storageUserId = deriveUserIdFromSession(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);

  // Always list PDFs stored in the team's shared Supabase Storage bucket (`querypilotx-storage`)
  const cloudReports = await listDailyPdfsFromSharedStorage(storageUserId, organizationId).catch(() => [] as PersistentReportSummary[]);

  try {
    const repository = getPersistentReportRepository();
    const result = await repository.listReports({
      organizationId,
      startDate,
      endDate,
      defaultDays: includeAllDates ? 0 : 30,
      domainId: domainParam as BusinessDomainId | undefined,
      datasetTable: tableParam,
      generationType: generationTypeParam as ReportGenerationType | undefined,
      frequency: frequencyParam as ReportFrequencyOrManual | undefined,
      status: statusParam as PersistentReportStatusFilter | undefined,
      pdfStatus: pdfStatusParam as PersistentReportPdfStatus | undefined,
      search,
      page,
      pageSize
    });

    const combined = mergeCloudReports(result.items, cloudReports);
    let storageState: ReportHistoryStorageState = "ready";
    if (combined.length === 0) {
      const unfiltered = await repository.listReports({
        organizationId,
        defaultDays: 0,
        page: 1,
        pageSize: 1
      });
      storageState = unfiltered.total > 0 ? "empty_filtered" : "empty_no_reports";
    }

    return access.applyCookie(NextResponse.json(
      {
        reports: combined,
        pagination: {
          total: Math.max(result.total, combined.length),
          page: result.page,
          pageSize: result.pageSize,
          totalPages: Math.max(1, Math.ceil(Math.max(result.total, combined.length) / pageSize)),
          appliedStartDate: result.appliedStartDate,
          appliedEndDate: result.appliedEndDate
        },
        storageStatus,
        storageState
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch {
    // Fallback cleanly to shared Supabase Storage report listing (no Postgres/SQLite required!)
    const filteredCloud = cloudReports.filter(item => {
      if (domainParam && item.domainId !== domainParam) return false;
      if (generationTypeParam && item.generationType !== generationTypeParam) return false;
      if (frequencyParam && item.frequency !== frequencyParam) return false;
      if (search && !`${item.pdfFilename || ""} ${item.domainName} ${item.periodStart} ${item.periodEnd}`.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      return true;
    });
    const offset = (page - 1) * pageSize;
    const paged = filteredCloud.slice(offset, offset + pageSize);
    const storageState: ReportHistoryStorageState = filteredCloud.length > 0
      ? "ready"
      : cloudReports.length > 0
        ? "empty_filtered"
        : "empty_no_reports";

    return access.applyCookie(NextResponse.json(
      {
        reports: paged,
        pagination: {
          total: filteredCloud.length,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(filteredCloud.length / pageSize)),
          appliedStartDate: startDate || null,
          appliedEndDate: endDate || null
        },
        storageStatus,
        storageState
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  }
}

export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "A valid JSON body is required." }, { status: 400 });
  }

  // Stage 4+ Multi-Domain Manual Report Generation with shared cloud PDF storage
  if (body.mode === "manual") {
    const table = typeof body.table === "string" ? body.table.trim() : "";
    if (!table || !isValidIdentifier(table)) {
      return NextResponse.json({ error: "A valid table identifier is required." }, { status: 400 });
    }

    const quickRange = typeof body.quickRange === "string" && ALLOWED_MANUAL_RANGES.has(body.quickRange as ManualQuickRange)
      ? body.quickRange as ManualQuickRange
      : null;
    if (!quickRange) {
      return NextResponse.json(
        { error: "quickRange must be one of: last_7_days, last_30_days, last_90_days, last_365_days, all_history, custom." },
        { status: 400 }
      );
    }

    let domainId: BusinessDomainId | undefined;
    if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
      if (typeof body.domain !== "string" || !(BUSINESS_DOMAIN_IDS as readonly string[]).includes(body.domain)) {
        return NextResponse.json({ error: `Unsupported domain. Expected one of: ${BUSINESS_DOMAIN_IDS.join(", ")}` }, { status: 400 });
      }
      domainId = body.domain as BusinessDomainId;
    }

    const overrides: Record<string, string> = {};
    if (body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)) {
      for (const [role, col] of Object.entries(body.overrides as Record<string, unknown>)) {
        if (typeof col === "string" && col.trim() && isValidIdentifier(col.trim())) {
          overrides[role] = col.trim();
        }
      }
    }

    const organizationId = deriveOrganizationId(access.session);
    const storageUserId = deriveUserIdFromSession(access.session);
    const executor = createSessionQueryExecutor(access.session);

    let earliestAvailableDate = typeof body.earliestAvailableDate === "string" && isValidIsoDate(body.earliestAvailableDate.trim())
      ? body.earliestAvailableDate.trim()
      : null;
    let latestAvailableDate = typeof body.latestAvailableDate === "string" && isValidIsoDate(body.latestAvailableDate.trim())
      ? body.latestAvailableDate.trim()
      : null;

    if (quickRange === "all_history" && (!earliestAvailableDate || !latestAvailableDate)) {
      try {
        const tableProfile = await profileConnectedDatabase(access.session, {
          selectedDomain: domainId || null,
          tableNames: [table]
        });
        const profiledTable = tableProfile.tables.find(t => t.name === table);
        if (profiledTable?.freshness.earliestDate) {
          earliestAvailableDate = earliestAvailableDate || profiledTable.freshness.earliestDate.slice(0, 10);
        }
        if (profiledTable?.freshness.latestDate) {
          latestAvailableDate = latestAvailableDate || profiledTable.freshness.latestDate.slice(0, 10);
        }
      } catch {
        // Proceed with safe defaults
      }
    }

    try {
      // First try full repository + shared PDF storage persistence (Postgres in prod or SQLite in dev)
      const repository = getPersistentReportRepository();
      const { record, downloadUrl } = await generateAndPersistManualReport({
        organizationId,
        ownerRef: access.session.projectName || access.session.projectRef || storageUserId,
        storageUserId,
        executor,
        repository,
        tableName: table,
        domainId,
        quickRange,
        startDate: typeof body.startDate === "string" ? body.startDate : undefined,
        endDate: typeof body.endDate === "string" ? body.endDate : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        comparisonPreset: typeof body.comparisonPreset === "string" ? body.comparisonPreset as ComparisonPreset : undefined,
        overrides: Object.keys(overrides).length ? overrides : undefined,
        earliestAvailableDate,
        latestAvailableDate
      });

      return access.applyCookie(NextResponse.json(
        { report: record, downloadUrl },
        { status: 201, headers: { "Cache-Control": "no-store" } }
      ));
    } catch (repoError) {
      const repoMsg = repoError instanceof Error ? repoError.message : "";
      const isRepoUnavailable = /development mode|not configured|QUERYPILOT_APP_DATABASE_URL|DATABASE_URL/i.test(repoMsg);
      if (!isRepoUnavailable) {
        return NextResponse.json(
          { error: repoMsg || "Could not generate manual report.", storageStatus: getStorageCapabilityStatus(organizationId) },
          { status: 400 }
        );
      }

      // Direct shared Supabase Storage mode (no Postgres/SQLite needed — uses src/lib/storage/service.ts!)
      try {
        const tz = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Dhaka";
        const { periodStart, periodEnd, reportingDate } = resolveManualReportPeriod({
          quickRange,
          startDate: typeof body.startDate === "string" ? body.startDate : undefined,
          endDate: typeof body.endDate === "string" ? body.endDate : undefined,
          timezone: tz,
          earliestAvailableDate,
          latestAvailableDate
        });

        const unified = await runUnifiedDailyAnalysisWithExecutor(executor, table, {
          domainId,
          periodStart,
          periodEnd,
          timezone: tz,
          comparisonPreset: typeof body.comparisonPreset === "string"
            ? body.comparisonPreset as ComparisonPreset
            : quickRange === "all_history"
              ? "none"
              : "previous_30_days",
          overrides: Object.keys(overrides).length ? overrides : undefined
        });

        const reportId = randomUUID();
        const summaryText = unified.tools.intelligenceBrief?.executiveSummary
          || `${unified.domainName} manual report (${periodStart} to ${periodEnd})`;

        const record: PersistentReportRecord = {
          id: `cloud_${reportId.slice(0, 8)}`,
          organizationId,
          ownerRef: storageUserId,
          domainId: unified.domainId,
          domainName: unified.domainName,
          datasetTable: unified.tableName,
          reportingDate,
          periodStart,
          periodEnd,
          comparisonStart: unified.comparisonPeriod?.start ?? null,
          comparisonEnd: unified.comparisonPeriod?.end ?? null,
          comparisonPreset: unified.comparisonPeriod?.preset ?? null,
          frequency: "manual",
          generationType: "manual",
          executionKey: null,
          status: "generated",
          summaryText,
          reportPayload: unified as unknown as Record<string, unknown>,
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
        const pdfBytes = await renderValidatedPdfForPayload(record.reportPayload, "historical", {
          metadata: buildPdfMetadataFromRecord(record, access.session.projectName || organizationId, quickRange)
        });
        assertValidPdfBuffer(pdfBytes);

        const uploaded = await uploadDailyPdfToSharedStorage({
          userId: storageUserId,
          filename,
          bytes: pdfBytes,
          metadata: {
            domainId: record.domainId,
            datasetTable: record.datasetTable,
            periodStart,
            periodEnd,
            generationType: "manual"
          }
        });

        record.id = `cloud_${uploaded.fileId}`;
        record.pdfStatus = "generated";
        record.pdfStorageKey = uploaded.storageKey;
        record.pdfFilename = uploaded.filename;
        record.pdfGeneratedAt = uploaded.createdAt;
        record.pdfSizeBytes = uploaded.sizeBytes;

        return access.applyCookie(NextResponse.json(
          {
            report: record,
            downloadUrl: `/api/storage/download?key=${encodeURIComponent(uploaded.storageKey)}`
          },
          { status: 201, headers: { "Cache-Control": "no-store" } }
        ));
      } catch (cloudError) {
        const message = cloudError instanceof Error ? cloudError.message : "Could not generate and upload PDF report.";
        return NextResponse.json(
          { error: message, storageStatus: getStorageCapabilityStatus(organizationId) },
          { status: 500 }
        );
      }
    }
  }

  // Legacy Sales report generation (100% preserved for compatibility)
  try {
    const selection = body.dataset && typeof body.dataset === "object" ? body.dataset as DatasetSelection : { table: "daily_sales_orders" };
    if (typeof selection.table !== "string" || !selection.table) return NextResponse.json({ error: "Select a Supabase table." }, { status: 400 });
    const { repository, table, mapping, availableMetrics } = await createSupabaseSalesRepository(access.session, selection);
    if (body.kind === "historical") {
      const range = String(body.range);
      if (!["week", "month", "three-months", "year", "all", "custom"].includes(range)) return NextResponse.json({ error: "Invalid historical range." }, { status: 400 });
      let report = generateHistoricalReport(repository, range as HistoricalRange, typeof body.start === "string" ? body.start : undefined, typeof body.end === "string" ? body.end : undefined);
      if (range !== "custom" && report.current.totalProductLines === 0) {
        const latestDate = repository.getLatestSaleDate();
        if (latestDate && latestDate < report.periodStart) {
          const fallbackStart = range === "week" ? addDays(latestDate, -6) : range === "month" ? addDays(latestDate, -29) : report.periodStart;
          report = generateHistoricalReport(repository, "custom", fallbackStart, latestDate);
        }
      }
      return access.applyCookie(NextResponse.json({ report: { ...report, dataset: { table: table.name, mapping }, availableMetrics } }, { status: 201 }));
    }
    const comparisonDays = body.comparisonDays === undefined ? undefined : Number(body.comparisonDays);
    let report = generateAutomaticReport(repository, comparisonDays);
    if (report.current.totalProductLines === 0 && Object.values(report.current.statusDistribution).every(count => count === 0)) {
      const latestDate = repository.getLatestSaleDate();
      if (latestDate) {
        report = generateAutomaticReportForDate(repository, latestDate, comparisonDays);
      }
    }
    return access.applyCookie(NextResponse.json({ report: { ...report, dataset: { table: table.name, mapping }, availableMetrics } }, { status: 201 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not generate the report." }, { status: 400 });
  }
}
