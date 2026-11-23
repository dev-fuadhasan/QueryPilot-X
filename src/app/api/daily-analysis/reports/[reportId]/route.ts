import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { getPersistentReportRepository } from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ reportId: string }> };

function isValidReportId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

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

    return access.applyCookie(NextResponse.json(
      {
        report: record,
        downloadUrl: `/api/daily-analysis/reports/${record.id}/pdf`
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load report.";
    const status = /development mode|not configured/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
