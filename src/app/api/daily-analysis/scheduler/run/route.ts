import { NextRequest, NextResponse } from "next/server";
import { queryPostgres } from "@/lib/database";
import { verifySchedulerSecret } from "@/../daily_data_analysis_and_notification/api-helpers";
import type { ReadOnlyQueryExecutor } from "@/../daily_data_analysis_and_notification/profiler";
import {
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  inspectSchedulerOrgDbMap,
  isValidPostgresConnectionUri,
  runScheduledReports
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves a read-only source database executor for background scheduled runs using
 * server-side environment configuration (`QUERYPILOT_SCHEDULER_ORG_DB_MAP` JSON mapping
 * organizationId -> read-only Postgres URI). Never logs or returns connection strings.
 */
async function resolveBackgroundSourceExecutor(organizationId: string): Promise<ReadOnlyQueryExecutor | null> {
  const inspection = inspectSchedulerOrgDbMap(process.env.QUERYPILOT_SCHEDULER_ORG_DB_MAP, organizationId);
  if (inspection.status !== "valid" || !inspection.organizationMapped) return null;
  const rawMap = process.env.QUERYPILOT_SCHEDULER_ORG_DB_MAP?.trim();
  if (!rawMap) return null;
  try {
    const parsed = JSON.parse(rawMap) as Record<string, unknown>;
    const uri = parsed[organizationId];
    if (!isValidPostgresConnectionUri(uri)) {
      return null;
    }
    const connectionString = String(uri).trim();
    return (sql: string) => queryPostgres(connectionString, sql);
  } catch {
    return null;
  }
}

async function handleSchedulerTrigger(request: NextRequest) {
  const auth = verifySchedulerSecret(request);
  if (!auth.ok) return auth.response;

  let forceDue = false;
  let organizationIdFilter: string | undefined;

  if (request.method === "POST") {
    try {
      const body = await request.json() as Record<string, unknown>;
      if (typeof body?.forceDue === "boolean") forceDue = body.forceDue;
      if (typeof body?.organizationId === "string" && body.organizationId.trim()) {
        organizationIdFilter = body.organizationId.trim();
      }
    } catch {
      // Empty POST body is valid for cron invocations
    }
  }

  const storageStatus = getStorageCapabilityStatus(organizationIdFilter);
  if (storageStatus.schedulerOrgDbMapStatus !== "valid") {
    return NextResponse.json(
      {
        error: storageStatus.schedulerOrgDbMapError || "Scheduler organisation database mapping is missing or invalid.",
        storageStatus
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const repository = getPersistentReportRepository();
    const result = await runScheduledReports({
      repository,
      resolveSourceExecutor: resolveBackgroundSourceExecutor,
      forceDue,
      organizationIdFilter
    });

    return NextResponse.json(
      {
        scheduler: result,
        storageStatus
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Scheduled execution failed.",
        storageStatus
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/** Vercel Cron triggers GET with `Authorization: Bearer <CRON_SECRET>`. */
export async function GET(request: NextRequest) {
  return handleSchedulerTrigger(request);
}

/** Allows authorised server-side / external cron POST invocations with optional filter. */
export async function POST(request: NextRequest) {
  return handleSchedulerTrigger(request);
}
