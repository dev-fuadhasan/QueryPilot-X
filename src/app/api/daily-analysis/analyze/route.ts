import { NextRequest, NextResponse } from "next/server";
import { readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { BUSINESS_DOMAIN_IDS, isValidIdentifier, type BusinessDomainId } from "@/../daily_data_analysis_and_notification/profiler";
import {
  addDaysToDate,
  isValidIsoDate,
  runDynamicAnalysisForSession,
  todayInTimezone,
  type ComparisonPreset
} from "@/../daily_data_analysis_and_notification/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PRESETS = new Set<ComparisonPreset>([
  "previous_day",
  "previous_week",
  "previous_month",
  "previous_7_days",
  "previous_30_days",
  "previous_90_days",
  "previous_365_days",
  "same_weekday_previous_weeks",
  "custom",
  "none"
]);

export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "A valid JSON payload is required." }, { status: 400 });
  }

  const table = typeof body.table === "string" ? body.table.trim() : "";
  if (!table || !isValidIdentifier(table)) {
    return NextResponse.json({ error: "A valid Supabase table name is required." }, { status: 400 });
  }

  let domainId: BusinessDomainId | undefined;
  if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
    if (typeof body.domain !== "string" || !(BUSINESS_DOMAIN_IDS as readonly string[]).includes(body.domain)) {
      return NextResponse.json({ error: `Unsupported domain. Expected one of: ${BUSINESS_DOMAIN_IDS.join(", ")}` }, { status: 400 });
    }
    domainId = body.domain as BusinessDomainId;
  }

  const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Dhaka";
  const defaultEnd = addDaysToDate(todayInTimezone(timezone), -1);
  const periodStart = typeof body.periodStart === "string" && body.periodStart.trim() ? body.periodStart.trim() : defaultEnd;
  const periodEnd = typeof body.periodEnd === "string" && body.periodEnd.trim() ? body.periodEnd.trim() : periodStart;

  if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd) || periodStart > periodEnd) {
    return NextResponse.json({ error: "periodStart and periodEnd must be valid YYYY-MM-DD dates with periodStart <= periodEnd." }, { status: 400 });
  }

  const comparisonPreset: ComparisonPreset = typeof body.comparisonPreset === "string" && ALLOWED_PRESETS.has(body.comparisonPreset as ComparisonPreset)
    ? body.comparisonPreset as ComparisonPreset
    : "previous_30_days";

  const overrides: Record<string, string> = {};
  if (body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)) {
    for (const [role, col] of Object.entries(body.overrides as Record<string, unknown>)) {
      if (typeof col === "string" && col.trim() && isValidIdentifier(col.trim())) {
        overrides[role] = col.trim();
      }
    }
  }

  try {
    const { analysis, tableProfile, understanding } = await runDynamicAnalysisForSession(access.session, table, {
      domainId,
      periodStart,
      periodEnd,
      timezone,
      comparisonPreset,
      comparisonStart: typeof body.comparisonStart === "string" ? body.comparisonStart.trim() : undefined,
      comparisonEnd: typeof body.comparisonEnd === "string" ? body.comparisonEnd.trim() : undefined,
      overrides: Object.keys(overrides).length ? overrides : undefined,
      allowMediumConfidence: typeof body.allowMediumConfidence === "boolean" ? body.allowMediumConfidence : true,
      activationEventName: typeof body.activationEventName === "string" ? body.activationEventName.trim() : undefined
    });

    return access.applyCookie(NextResponse.json(
      {
        analysis,
        profileSummary: {
          tableName: tableProfile.name,
          tableType: tableProfile.tableType,
          rowCount: tableProfile.rowCount,
          freshness: tableProfile.freshness,
          duplicates: tableProfile.duplicates,
          domainFitScore: understanding.domainFitScore,
          domainFitConfidence: understanding.domainFitConfidence,
          missingRequiredRoles: understanding.missingRequiredRoles,
          ambiguousColumns: understanding.ambiguousColumns
        }
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not run dynamic analysis." },
      { status: 400 }
    );
  }
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ error: "Use POST with table, domain, and reporting period parameters." }, { status: 405 });
}
