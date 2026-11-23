import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { renderAnalysisReport, type HistoricalContextBundle } from "@/../daily_data_analysis_and_notification/pdf/report-pdf";
import type { AnalysisReport } from "@/../daily_data_analysis_and_notification/types";
import { createSessionQueryExecutor } from "@/../daily_data_analysis_and_notification/profiler";
import { compareArchivedReports, type ReportArchiveComparisonResult, type UnifiedDailyAnalysisResult } from "@/../daily_data_analysis_and_notification/intelligence";
import {
  assertValidPdfBuffer,
  buildHistoricalContextForReport,
  buildPdfMetadataFromRecord,
  buildReportPdfFilename,
  createDefaultPdfStorage,
  getPersistentReportRepository,
  renderValidatedPdfForPayload,
  toArchivedReportFromPersistent
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ reportId: string }> };

function isValidReportId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

/**
 * Authorized private PDF download for a persisted report owned by the caller's organisation.
 * Supports optional `?compareWith=<otherReportId>` for explicitly selected archived report comparison
 * (both reports verified to belong to the caller's organisation). Never trusts client JSON payloads
 * for official persisted reports.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const { reportId } = await context.params;
  if (!reportId || !isValidReportId(reportId)) {
    return NextResponse.json({ error: "Invalid report identifier." }, { status: 400 });
  }

  const compareWithId = request.nextUrl.searchParams.get("compareWith")?.trim() || null;
  if (compareWithId && !isValidReportId(compareWithId)) {
    return NextResponse.json({ error: "Invalid compareWith report identifier." }, { status: 400 });
  }

  try {
    const organizationId = deriveOrganizationId(access.session);
    const repository = getPersistentReportRepository();
    const record = await repository.getReportById(organizationId, reportId);
    if (!record) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    let archivedComparison: ReportArchiveComparisonResult | null = null;
    if (compareWithId) {
      const otherRecord = await repository.getReportById(organizationId, compareWithId);
      if (!otherRecord) {
        return NextResponse.json({ error: "Comparison report not found for this organisation." }, { status: 404 });
      }
      archivedComparison = compareArchivedReports(
        toArchivedReportFromPersistent(otherRecord),
        toArchivedReportFromPersistent(record)
      );
    }

    const pdfStorage = createDefaultPdfStorage();
    let pdfBytes: Buffer | null = null;
    if (!archivedComparison && record.pdfStatus === "generated" && record.pdfStorageKey) {
      pdfBytes = await pdfStorage.readPdf(record.pdfStorageKey);
    }

    if (!pdfBytes) {
      // Enrich missing 30-day historical context server-side for Daily reports when needed
      let historicalContext = (record.reportPayload.historicalContext as HistoricalContextBundle | null | undefined) ?? null;
      if (!historicalContext && record.frequency === "daily" && record.reportPayload.analysis) {
        try {
          const unified = record.reportPayload as unknown as UnifiedDailyAnalysisResult;
          const executor = createSessionQueryExecutor(access.session);
          historicalContext = await buildHistoricalContextForReport({
            executor,
            tableName: record.datasetTable,
            domainId: record.domainId,
            periodStart: record.periodStart,
            periodEnd: record.periodEnd,
            frequency: "daily",
            timezone: unified.analysis.timezone
          });
        } catch {
          historicalContext = null;
        }
      }

      pdfBytes = await renderValidatedPdfForPayload(
        record.reportPayload,
        record.generationType === "automatic" ? "automatic" : "historical",
        {
          metadata: buildPdfMetadataFromRecord(record, access.session.projectName || organizationId),
          historicalContext,
          archivedComparison
        }
      );

      if (!archivedComparison) {
        try {
          const filename = record.pdfFilename || buildReportPdfFilename(record);
          const stored = await pdfStorage.savePdf({
            organizationId,
            reportId: record.id,
            filename,
            bytes: pdfBytes
          });
          await repository.updateReportPdfMetadata(organizationId, record.id, {
            pdfStatus: "generated",
            pdfStorageKey: stored.storageKey,
            pdfFilename: stored.filename,
            pdfGeneratedAt: new Date().toISOString(),
            pdfSizeBytes: stored.sizeBytes,
            pdfError: null
          });
        } catch {
          // Still stream the validated server-side PDF even if object storage is unconfigured
        }
      }
    } else {
      assertValidPdfBuffer(pdfBytes);
    }

    const filename = record.pdfFilename || buildReportPdfFilename(record);
    return access.applyCookie(new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBytes.byteLength),
        "Cache-Control": "private, no-store"
      }
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not download the PDF.";
    const status = /development mode|not configured/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * Legacy compatibility endpoint for ad-hoc client Sales report PDF rendering.
 * If reportId matches a persisted server-side report owned by the caller, serves the
 * trusted persisted report instead of accepting untrusted client data.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  const { reportId } = await context.params;
  if (reportId && isValidReportId(reportId) && !/^\d+$/.test(reportId)) {
    try {
      const organizationId = deriveOrganizationId(access.session);
      const repository = getPersistentReportRepository();
      const persisted = await repository.getReportById(organizationId, reportId);
      if (persisted) {
        const pdfBytes = await renderValidatedPdfForPayload(
          persisted.reportPayload,
          persisted.generationType === "automatic" ? "automatic" : "historical",
          {
            metadata: buildPdfMetadataFromRecord(persisted, access.session.projectName || organizationId),
            historicalContext: (persisted.reportPayload.historicalContext as HistoricalContextBundle | null | undefined) ?? null
          }
        );
        const filename = persisted.pdfFilename || buildReportPdfFilename(persisted);
        return access.applyCookie(new NextResponse(new Uint8Array(pdfBytes), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": String(pdfBytes.byteLength),
            "Cache-Control": "private, no-store"
          }
        }));
      }
    } catch {
      // Fall through to legacy preview rendering if durable repo is unavailable
    }
  }

  let report: AnalysisReport;
  try {
    report = await request.json() as AnalysisReport;
    if (!report || typeof report !== "object" || !report.current || !Array.isArray(report.dailyPerformance) || !report.periodStart || !report.periodEnd) {
      return NextResponse.json({ error: "A valid AnalysisReport payload is required." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "A valid AnalysisReport JSON payload is required." }, { status: 400 });
  }

  try {
    const pdf = await renderAnalysisReport(report);
    assertValidPdfBuffer(pdf);
    const filename = `querypilot-x-report-${report.reportKind}-${report.periodStart}-to-${report.periodEnd}.pdf`;
    return access.applyCookie(new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "private, no-store"
      }
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not generate the PDF." }, { status: 500 });
  }
}
