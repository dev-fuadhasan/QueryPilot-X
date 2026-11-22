import { NextRequest, NextResponse } from "next/server";
import { readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import {
  BUSINESS_DOMAIN_IDS,
  isValidIdentifier,
  listDomainProfiles,
  profileConnectedDatabase,
  type BusinessDomainId
} from "@/../daily_data_analysis_and_notification/profiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDomain(value: string | null): BusinessDomainId | null | "invalid" {
  if (!value) return null;
  if ((BUSINESS_DOMAIN_IDS as readonly string[]).includes(value)) {
    return value as BusinessDomainId;
  }
  return "invalid";
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const domainParam = parseDomain(request.nextUrl.searchParams.get("domain"));
  if (domainParam === "invalid") {
    return NextResponse.json(
      { error: `Unsupported business domain. Expected one of: ${BUSINESS_DOMAIN_IDS.join(", ")}` },
      { status: 400 }
    );
  }

  const rawTables = request.nextUrl.searchParams.getAll("table").map(v => v.trim()).filter(Boolean);
  for (const table of rawTables) {
    if (!isValidIdentifier(table)) {
      return NextResponse.json({ error: "Invalid table identifier." }, { status: 400 });
    }
  }

  try {
    const profile = await profileConnectedDatabase(access.session, {
      selectedDomain: domainParam,
      tableNames: rawTables.length ? rawTables : undefined
    });

    return access.applyCookie(NextResponse.json(
      {
        profile,
        domains: listDomainProfiles().map(domain => ({
          id: domain.id,
          name: domain.name,
          shortName: domain.shortName,
          description: domain.description,
          requiredRoles: domain.fields.filter(f => f.required).map(f => f.role),
          metrics: domain.metrics.map(m => ({ id: m.id, label: m.label }))
        }))
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not profile the connected database." },
      { status: 400 }
    );
  }
}

export async function POST(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;
  return NextResponse.json({ error: "Database profiling is strictly read-only." }, { status: 405 });
}
