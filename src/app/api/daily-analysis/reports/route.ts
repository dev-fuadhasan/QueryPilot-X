import { NextRequest, NextResponse } from "next/server";
import { addDays, generateAutomaticReport, generateAutomaticReportForDate, generateHistoricalReport, type HistoricalRange } from "@/../daily_data_analysis_and_notification/analysis-service";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { createSupabaseSalesRepository, type DatasetSelection } from "@/../daily_data_analysis_and_notification/database/supabase-sales-repository";
import { BUSINESS_DOMAIN_IDS, createSessionQueryExecutor, isValidIdentifier, type BusinessDomainId } from "@/../daily_data_analysis_and_notification/profiler";
import { isValidIsoDate, type ComparisonPreset } from "@/../daily_data_analysis_and_notification/metrics";
import {
  generateAndPersistManualReport,
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  type ManualQuickRange,
  type ReportFrequencyOrManual,
  type ReportGenerationType
} from "@/../daily_data_analysis_and_notification/storage";

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

  const includeAllDates = params.get("all") === "true";
  const organizationId = deriveOrganizationId(access.session);
  const storageStatus = getStorageCapabilityStatus();

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
      page,
      pageSize
    });

    return access.applyCookie(NextResponse.json(
      {
        reports: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
          appliedStartDate: result.appliedStartDate,
          appliedEndDate: result.appliedEndDate
        },
        storageStatus
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    return access.applyCookie(NextResponse.json(
      {
        reports: [],
        pagination: { total: 0, page, pageSize, totalPages: 1, appliedStartDate: startDate || null, appliedEndDate: endDate || null },
        storageStatus,
        warning: error instanceof Error ? error.message : "Persistent report history storage is not configured."
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

  // Stage 4 Multi-Domain Manual Report Generation with durable persistence & private PDF storage
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

    try {
      const organizationId = deriveOrganizationId(access.session);
      const repository = getPersistentReportRepository();
      const executor = createSessionQueryExecutor(access.session);
      const { record, downloadUrl } = await generateAndPersistManualReport({
        organizationId,
        ownerRef: access.session.projectName || access.session.projectRef || "authenticated_user",
        executor,
        repository,
        tableName: table,
        domainId,
        quickRange,
        startDate: typeof body.startDate === "string" ? body.startDate : undefined,
        endDate: typeof body.endDate === "string" ? body.endDate : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        comparisonPreset: typeof body.comparisonPreset === "string" ? body.comparisonPreset as ComparisonPreset : undefined,
        overrides: Object.keys(overrides).length ? overrides : undefined
      });

      return access.applyCookie(NextResponse.json(
        { report: record, downloadUrl },
        { status: 201, headers: { "Cache-Control": "no-store" } }
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate manual report.";
      const status = /development mode|not configured/i.test(message) ? 503 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  }

  // Legacy Sales report generation (100% preserved for existing DailyAnalysisDashboard compatibility)
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
