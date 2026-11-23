import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { renderAnalysisReport } from "@/../daily_data_analysis_and_notification/pdf/report-pdf";
import type { AnalysisReport } from "@/../daily_data_analysis_and_notification/types";
import {
  assertValidPdfBuffer,
  buildReportPdfFilename,
  createDefaultPdfStorage,
  getPersistentReportRepository,
  renderValidatedPdfForPayload
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ reportId: string }> };

function isValidReportId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

/**
 * Authorized private PDF download for a persisted report owned by the caller's organisation.
 * Never trusts client-submitted report payloads for official persisted reports.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const { reportId } = await context.params;
  if (!reportId || !isValidReportId(reportId)) {
    return NextResponse.json({ error: "Invalid report identifier." }, { status: 400 });
  }

  try {
    const organizationId = deriveOrganizationId(access.session);
    const repository = getPersistentReportRepository();
    const record = await repository.getReportById(organizationId, reportId);
    if (!record) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    const pdfStorage = createDefaultPdfStorage();
    let pdfBytes: Buffer | null = null;
    if (record.pdfStatus === "generated" && record.pdfStorageKey) {
      pdfBytes = await pdfStorage.readPdf(record.pdfStorageKey);
    }

    if (!pdfBytes) {
      // Regenerate server-side from the trusted persisted report payload
      pdfBytes = await renderValidatedPdfForPayload(
        record.reportPayload,
        record.generationType === "automatic" ? "automatic" : "historical"
      );
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
          persisted.generationType === "automatic" ? "automatic" : "historical"
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
