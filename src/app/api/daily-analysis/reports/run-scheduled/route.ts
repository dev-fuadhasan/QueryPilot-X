import { NextRequest, NextResponse } from "next/server";
import { deriveUserIdFromSession } from "@/lib/storage/session-auth";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { createSessionQueryExecutor } from "@/../daily_data_analysis_and_notification/profiler";
import {
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  runScheduledReports
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated session-backed runner for due automatic reports.
 * Evaluates the organisation's saved schedule in its configured timezone, generates any
 * due completed-period report using the caller's read-only database session, stores the
 * verified PDF in shared private cloud storage (`{userId}/reports/...`), and persists
 * metadata in PostgreSQL with durable deduplication (never creates duplicate reports).
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

  try {
    const repository = getPersistentReportRepository();
    const executor = createSessionQueryExecutor(access.session);

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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not execute scheduled report.";
    return NextResponse.json(
      { error: message, storageStatus },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
