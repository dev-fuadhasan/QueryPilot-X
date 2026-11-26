import { NextRequest, NextResponse } from "next/server";
import { readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { BUSINESS_DOMAIN_IDS, isValidIdentifier, type BusinessDomainId } from "@/../daily_data_analysis_and_notification/profiler";
import {
  addDaysToDate,
  isValidIsoDate,
  todayInTimezone,
  type ComparisonPreset
} from "@/../daily_data_analysis_and_notification/metrics";
import {
  runUnifiedDailyAnalysisForSession,
  type DailyAnalysisToolName,
  type ExpectedReportingCadence
} from "@/../daily_data_analysis_and_notification/intelligence";
import type { AlertRules } from "@/../daily_data_analysis_and_notification/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PRESETS = new Set<ComparisonPreset>([
  "previous_day",
  "previous_week",
  "previous_month",
  "previous_7_days",
  "previous_30_days",
  "previous_90_days",
  "previous_180_days",
  "previous_365_days",
  "same_weekday_previous_weeks",
  "custom",
  "none"
]);

const ALLOWED_TOOLS = new Set<DailyAnalysisToolName>([
  "intelligenceBrief",
  "smartComparison",
  "alerts",
  "rootCause",
  "recommendations",
  "dataHealth",
  "reportArchive"
]);

const ALLOWED_CADENCES = new Set<ExpectedReportingCadence>(["daily", "weekdays", "weekly", "irregular"]);

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
  const hasExplicitPeriod = Boolean(
    (typeof body.periodStart === "string" && body.periodStart.trim())
    || (typeof body.periodEnd === "string" && body.periodEnd.trim())
  );
  const periodStart = typeof body.periodStart === "string" && body.periodStart.trim() ? body.periodStart.trim() : defaultEnd;
  const periodEnd = typeof body.periodEnd === "string" && body.periodEnd.trim() ? body.periodEnd.trim() : periodStart;

  if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd) || periodStart > periodEnd) {
    return NextResponse.json({ error: "periodStart and periodEnd must be valid YYYY-MM-DD dates with periodStart <= periodEnd." }, { status: 400 });
  }

  const comparisonPreset: ComparisonPreset = typeof body.comparisonPreset === "string" && ALLOWED_PRESETS.has(body.comparisonPreset as ComparisonPreset)
    ? body.comparisonPreset as ComparisonPreset
    : "previous_day";

  const expectedCadence: ExpectedReportingCadence = typeof body.expectedCadence === "string" && ALLOWED_CADENCES.has(body.expectedCadence as ExpectedReportingCadence)
    ? body.expectedCadence as ExpectedReportingCadence
    : "irregular";

  let enabledTools: DailyAnalysisToolName[] | undefined;
  if (Array.isArray(body.tools)) {
    const valid = body.tools.filter((t): t is DailyAnalysisToolName => typeof t === "string" && ALLOWED_TOOLS.has(t as DailyAnalysisToolName));
    if (valid.length > 0) enabledTools = valid;
  }

  const overrides: Record<string, string> = {};
  if (body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)) {
    for (const [role, col] of Object.entries(body.overrides as Record<string, unknown>)) {
      if (typeof col === "string" && col.trim() && isValidIdentifier(col.trim())) {
        overrides[role] = col.trim();
      }
    }
  }

  const alertRules = body.alertRules && typeof body.alertRules === "object" && !Array.isArray(body.alertRules)
    ? body.alertRules as Partial<AlertRules>
    : undefined;

  try {
    const result = await runUnifiedDailyAnalysisForSession(access.session, table, {
      domainId,
      periodStart,
      periodEnd,
      timezone,
      comparisonPreset,
      comparisonStart: typeof body.comparisonStart === "string" ? body.comparisonStart.trim() : undefined,
      comparisonEnd: typeof body.comparisonEnd === "string" ? body.comparisonEnd.trim() : undefined,
      overrides: Object.keys(overrides).length ? overrides : undefined,
      allowMediumConfidence: typeof body.allowMediumConfidence === "boolean" ? body.allowMediumConfidence : true,
      includeAllDatasetColumns: body.includeAllDatasetColumns !== false,
      anchorToDatasetDates: typeof body.anchorToDatasetDates === "boolean" ? body.anchorToDatasetDates : !hasExplicitPeriod,
      forceRefresh: body.fresh === true,
      activationEventName: typeof body.activationEventName === "string" ? body.activationEventName.trim() : undefined,
      expectedCadence,
      enabledTools,
      alertRules
    });

    return access.applyCookie(NextResponse.json(
      { intelligence: result },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not generate daily intelligence analysis." },
      { status: 400 }
    );
  }
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ error: "Use POST with table, domain, and reporting period parameters." }, { status: 405 });
}
