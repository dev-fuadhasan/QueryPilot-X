import { NextRequest, NextResponse } from "next/server";
import { readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import type { AnalysisReport } from "@/../daily_data_analysis_and_notification/types";
import type { DynamicAnalysisResult } from "@/../daily_data_analysis_and_notification/metrics";
import {
  compareArchivedReports,
  toArchivedReportFromDynamic,
  toArchivedReportFromLegacySales,
  type ArchivedReportRecord
} from "@/../daily_data_analysis_and_notification/intelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeReportInput(raw: unknown): ArchivedReportRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Already an ArchivedReportRecord
  if (typeof obj.id === "string" && typeof obj.domainId === "string" && Array.isArray(obj.metrics) && typeof obj.periodStart === "string") {
    return obj as unknown as ArchivedReportRecord;
  }

  // Stage 2 DynamicAnalysisResult
  if (typeof obj.domainId === "string" && obj.reportingPeriod && Array.isArray(obj.metrics)) {
    return toArchivedReportFromDynamic(obj as unknown as DynamicAnalysisResult);
  }

  // Legacy Sales AnalysisReport
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

  const leftReport = normalizeReportInput(body.leftReport);
  const rightReport = normalizeReportInput(body.rightReport);

  if (!leftReport || !rightReport) {
    return NextResponse.json(
      { error: "Both leftReport and rightReport must be valid report payloads." },
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
  return NextResponse.json({ error: "Use POST with leftReport and rightReport to compare archived reports." }, { status: 405 });
}
