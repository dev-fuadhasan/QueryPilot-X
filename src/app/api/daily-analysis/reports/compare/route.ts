import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import type { AnalysisReport } from "@/../daily_data_analysis_and_notification/types";
import type { DynamicAnalysisResult } from "@/../daily_data_analysis_and_notification/metrics";
import {
  compareArchivedReports,
  toArchivedReportFromDynamic,
  toArchivedReportFromLegacySales,
  type ArchivedReportRecord
} from "@/../daily_data_analysis_and_notification/intelligence";
import {
  getPersistentReportRepository,
  toArchivedReportFromPersistent
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidReportId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function normalizeReportInput(raw: unknown): ArchivedReportRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id === "string" && typeof obj.domainId === "string" && Array.isArray(obj.metrics) && typeof obj.periodStart === "string") {
    return obj as unknown as ArchivedReportRecord;
  }
  if (typeof obj.domainId === "string" && obj.reportingPeriod && Array.isArray(obj.metrics)) {
    return toArchivedReportFromDynamic(obj as unknown as DynamicAnalysisResult);
  }
  if (obj.current && typeof obj.reportingDate === "string" && typeof obj.periodStart === "string" && typeof obj.periodEnd === "string") {
    return toArchivedReportFromLegacySales(obj as unknown as AnalysisReport);
  }
  return null;
}

export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "A valid JSON payload is required." }, { status: 400 });
  }

  let leftReport: ArchivedReportRecord | null = null;
  let rightReport: ArchivedReportRecord | null = null;

  // Preferred server-side path: compare two persisted reports by ID with strict tenant isolation
  if (body.leftReportId !== undefined || body.rightReportId !== undefined) {
    if (!isValidReportId(body.leftReportId) || !isValidReportId(body.rightReportId)) {
      return NextResponse.json({ error: "Both leftReportId and rightReportId must be valid report identifiers." }, { status: 400 });
    }
    try {
      const organizationId = deriveOrganizationId(access.session);
      const repository = getPersistentReportRepository();
      const [leftRecord, rightRecord] = await Promise.all([
        repository.getReportById(organizationId, body.leftReportId),
        repository.getReportById(organizationId, body.rightReportId)
      ]);
      if (!leftRecord || !rightRecord) {
        return NextResponse.json({ error: "One or both reports were not found for this organisation." }, { status: 404 });
      }
      leftReport = toArchivedReportFromPersistent(leftRecord);
      rightReport = toArchivedReportFromPersistent(rightRecord);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load persisted reports for comparison.";
      const status = /development mode|not configured/i.test(message) ? 503 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  } else {
    leftReport = normalizeReportInput(body.leftReport);
    rightReport = normalizeReportInput(body.rightReport);
  }

  if (!leftReport || !rightReport) {
    return NextResponse.json(
      { error: "Provide either valid leftReportId/rightReportId or valid leftReport/rightReport payloads." },
      { status: 400 }
    );
  }

  const comparison = compareArchivedReports(leftReport, rightReport);
  return access.applyCookie(NextResponse.json(
    { comparison },
    { headers: { "Cache-Control": "no-store" } }
  ));
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ error: "Use POST with leftReportId/rightReportId or report payloads to compare reports." }, { status: 405 });
}
