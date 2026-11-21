import { NextRequest, NextResponse } from "next/server";
import { readSession, sameOrigin, saveSession } from "@/lib/session";
import { groupSchema, queryPostgres, type SchemaTable } from "@/lib/database";
import { queryOAuth, refreshSession } from "@/lib/supabase";
import { suggestInvestigationFocus } from "@features/smart_data_analysis_and_visualization/lib/ai";
import type { InvestigationPlan, InvestigationStage, QualityData, OverviewData, GroupPoint, TrendPoint } from "@features/smart_data_analysis_and_visualization/lib/intelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

type Input = {
  stage?: unknown;
  table?: unknown;
  goal?: unknown;
  metric?: unknown;
  dimension?: unknown;
  time?: unknown;
  filterValue?: unknown;
  filters?: unknown;
  filterDimension?: unknown;
  filterSearch?: unknown;
};
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const metricType = /(?:int|numeric|decimal|double|real|float|money)/i;
const dateType = /(?:date|timestamp)/i;
const groupType = /(?:char|text|uuid|enum)/i;
const excluded = /(?:^id$|_id$|uuid|postal|postcode|phone|zip|code|serial|password|secret|token|age|ssn|year|month|week|quarter)/i;
const privateColumn = /(?:email|phone|address|password|secret|token|ssn|full_name|first_name|last_name|customer_name|patient_name|notes|description|message|comment)/i;
function ident(name: string) { return '"' + name.replace(/"/g, '""') + '"'; }
function str(value: string) { return "'" + value.replace(/'/g, "''") + "'"; }
function n(value: unknown) { const valueNumber = Number(value); return Number.isFinite(valueNumber) ? valueNumber : 0; }
function nullable(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}
function names(table: SchemaTable) {
  const metrics = table.columns
    .filter(col => metricType.test(col.type) && !excluded.test(col.name) && !privateColumn.test(col.name))
    .map(col => col.name).slice(0, 35);
  const dimensions = table.columns
    .filter(col => groupType.test(col.type) && !excluded.test(col.name) && !privateColumn.test(col.name))
    .map(col => col.name).slice(0, 35);
  const times = table.columns
    .filter(col => dateType.test(col.type) && !privateColumn.test(col.name))
    .map(col => col.name).slice(0, 15);
  return { metrics, dimensions, times };
}
function bestMetric(options: string[], goal: string) {
  const query = goal.toLowerCase();
  return options.find(name => query.includes(name.toLowerCase().replace(/_/g, " "))) ||
    options.find(name => /(?:revenue|sales|profit|amount|quantity|value|cost|price|score)/i.test(name)) ||
    options[0] || null;
}
function selectVerified(input: unknown, choices: string[]) {
  return typeof input === "string" && choices.includes(input) ? input : null;
}
function selectedFields(input: Input, table: SchemaTable) {
  const choices = names(table);
  for (const [key, options] of [
    ["metric", choices.metrics], ["dimension", choices.dimensions], ["time", choices.times]
  ] as const) {
    const field = input[key];
    if (field !== null && field !== undefined && (typeof field !== "string" || !options.includes(field))) {
      throw new Error("Selected " + key + " is not an approved dataset field.");
    }
  }
  return {
    metric: selectVerified(input.metric, choices.metrics),
    dimension: selectVerified(input.dimension, choices.dimensions),
    time: selectVerified(input.time, choices.times)
  };
}
function filter(input: Input, table: SchemaTable, defaultDimension: string | null) {
  const approved = names(table).dimensions;
  const raw: unknown = input.filters === undefined
    ? (input.filterValue === undefined || input.filterValue === null
        ? [] : [{ column: defaultDimension, value: input.filterValue }])
    : input.filters;
  if (!Array.isArray(raw) || raw.length > 3) throw new Error("Choose up to three valid dashboard filters.");
  const seen = new Set<string>();
  const constraints: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid dashboard filter.");
    const candidate = item as { column?: unknown; value?: unknown };
    if (typeof candidate.column !== "string" || !approved.includes(candidate.column) ||
        typeof candidate.value !== "string" || candidate.value.length > 110 || seen.has(candidate.column)) {
      throw new Error("Choose an approved field and category for each dashboard filter.");
    }
    seen.add(candidate.column);
    constraints.push(candidate.value === "(missing)"
      ? ident(candidate.column) + " IS NULL"
      : "LEFT(CAST(" + ident(candidate.column) + " AS text), 110) = " + str(candidate.value));
  }
  return constraints.join(" AND ");
}
async function filterOptions(table: SchemaTable, input: Input, run: Query) {
  const column = input.filterDimension;
  if (typeof column !== "string" || !names(table).dimensions.includes(column)) {
    throw new Error("Choose an approved category field.");
  }
  const search = typeof input.filterSearch === "string" ? input.filterSearch.trim().slice(0,80) : "";
  const expression = "LEFT(CAST(" + ident(column) + " AS text), 110)";
  const searchConstraint = search ? " WHERE " + expression + " ILIKE " + str("%" + search + "%") : "";
  const sql = "SELECT COALESCE(" + expression + ", '(missing)') AS label, COUNT(*)::bigint AS records FROM " +
    source(table) + searchConstraint + " GROUP BY 1 ORDER BY records DESC, label ASC LIMIT 75";
  const rows = await run(sql);
  return NextResponse.json({
    data: { values: rows.map(row => String(row.label ?? "(missing)")), column },
    completedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
function where(...parts: string[]) {
  const conditions = parts.filter(Boolean);
  return conditions.length ? " WHERE " + conditions.join(" AND ") : "";
}
function totalExpr(metric: string | null) {
  return metric ? "SUM(" + ident(metric) + "::numeric)::double precision" : "COUNT(*)::double precision";
}
function source(table: SchemaTable) { return "public." + ident(table.name); }
function response(stage: InvestigationStage, data: unknown, sql: string | null) {
  return NextResponse.json({ stage, data, sql: sql || "", completedAt: new Date().toISOString() }, {
    headers: { "Cache-Control": "no-store" }
  });
}
async function plan(table: SchemaTable, goal: string): Promise<InvestigationPlan> {
  const choices = names(table);
  const suggestion = await suggestInvestigationFocus(goal, table.name, choices.metrics, choices.dimensions, choices.times);
  const metric = suggestion?.metric || bestMetric(choices.metrics, goal);
  const dimension = suggestion?.dimension || choices.dimensions[0] || null;
  const time = suggestion?.time || choices.times[0] || null;
  return {
    table: table.name, metric, dimension, time,
    metrics: choices.metrics, dimensions: choices.dimensions, times: choices.times,
    columnCount: table.columns.length,
    planner: suggestion ? "AI-assisted" : "Schema-guided",
    rationale: suggestion?.rationale || "A verified metric, category and date were selected from this dataset's schema."
  };
}
async function profile(table: SchemaTable, input: Input, run: Query) {
  const fields = selectedFields(input, table);
  const cols = [...new Set([fields.metric, fields.dimension, fields.time].filter((v): v is string => Boolean(v)))].slice(0, 3);
  const projection = cols.length ? cols.map(ident).join(", ") : "1";
  const missing = cols.map((col, i) =>
    "COUNT(*) FILTER (WHERE " + ident(col) + " IS NULL)::bigint AS missing_" + i);
  const sql = "SELECT COUNT(*)::bigint AS sampled_records" +
    (missing.length ? ", " + missing.join(", ") : "") +
    " FROM (SELECT " + projection + " FROM " + source(table) + " LIMIT 5000) AS sample";
  const [row] = await run(sql);
  const sampledRecords = n(row?.sampled_records);
  const data: QualityData = {
    sampledRecords, sampleLimit: 5000,
    fields: cols.map((col, i) => {
      const missingCount = n(row?.["missing_" + i]);
      return { column: col, missing: missingCount, missingPercent: sampledRecords ? Math.round(missingCount / sampledRecords * 1000) / 10 : 0 };
    })
  };
  return response("profile", data, sql);
}
async function overview(table: SchemaTable, input: Input, run: Query) {
  const fields = selectedFields(input, table);
  const constraint = filter(input, table, fields.dimension);
  const metric = fields.metric;
  const expressions = [
    "COUNT(*)::bigint AS records",
    metric ? totalExpr(metric) + " AS total" : "NULL::double precision AS total",
    metric ? "AVG(" + ident(metric) + "::numeric)::double precision AS average" : "NULL::double precision AS average",
    metric ? "MIN(" + ident(metric) + "::numeric)::double precision AS minimum" : "NULL::double precision AS minimum",
    metric ? "MAX(" + ident(metric) + "::numeric)::double precision AS maximum" : "NULL::double precision AS maximum"
  ];
  const sql = "SELECT " + expressions.join(", ") + " FROM " + source(table) + where(constraint);
  const [row] = await run(sql);
  const data: OverviewData = {
    records: n(row?.records),
    total: nullable(row?.total),
    average: nullable(row?.average),
    minimum: nullable(row?.minimum),
    maximum: nullable(row?.maximum)
  };
  return response("overview", data, sql);
}
async function drivers(table: SchemaTable, input: Input, run: Query) {
  const fields = selectedFields(input, table);
  if (!fields.dimension) return response("drivers", [], "");
  const dim = ident(fields.dimension);
  const constraint = filter(input, table, fields.dimension);
  const group = "LEFT(CAST(" + dim + " AS text), 110)";
  const sql = "SELECT COALESCE(" + group + ", '(missing)') AS label, " +
    "COUNT(*)::bigint AS records, " + totalExpr(fields.metric) + " AS value FROM " +
    source(table) + where(constraint) + " GROUP BY " + group +
    " ORDER BY value DESC NULLS LAST, records DESC LIMIT 12";
  const rows = await run(sql);
  const data: GroupPoint[] = rows.map(row => ({
    label: String(row.label ?? "(missing)"), records: n(row.records), value: n(row.value)
  }));
  return response("drivers", data, sql);
}
async function trend(table: SchemaTable, input: Input, run: Query) {
  const fields = selectedFields(input, table);
  if (!fields.time) return response("trend", [], "");
  const field = ident(fields.time);
  const constraint = filter(input, table, fields.dimension);
  const sql = "SELECT TO_CHAR(DATE_TRUNC('month', " + field + "), 'YYYY-MM') AS period, " +
    "COUNT(*)::bigint AS records, " + totalExpr(fields.metric) + " AS value FROM " +
    source(table) + where(constraint, field + " IS NOT NULL") +
    " GROUP BY 1 ORDER BY 1 DESC LIMIT 24";
  const rows = await run(sql);
  const data: TrendPoint[] = rows.map(row => ({
    period: String(row.period || ""), records: n(row.records), value: n(row.value)
  })).filter(point => Boolean(point.period)).reverse();
  return response("trend", data, sql);
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const current = await readSession();
  if (!current || (!current.dbUrl && !(current.mode === "oauth" && current.projectRef))) {
    return NextResponse.json({ error: "Connect to Supabase before investigating data." }, { status: 401 });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid investigation request." }, { status: 400 });
    }
    const input = body as Input;
    const stage = input.stage;
    if (!["plan", "profile", "overview", "drivers", "trend", "filter-options"].includes(String(stage))) {
      return NextResponse.json({ error: "Unknown investigation stage." }, { status: 400 });
    }
    if (typeof input.table !== "string" || input.table.length > 120) {
      return NextResponse.json({ error: "Choose a dataset first." }, { status: 400 });
    }
    const access = current.mode === "oauth" ? await refreshSession(current) : { session: current, refreshed: false };
    const session = access.session;
    const run = (sql: string) => session.mode === "oauth"
      ? queryOAuth(session, sql) : queryPostgres(session.dbUrl || "", sql);
    const schemaQuery = "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c " +
      "JOIN information_schema.tables t ON c.table_schema = t.table_schema AND c.table_name = t.table_name " +
      "WHERE c.table_schema = 'public' AND t.table_type IN ('BASE TABLE', 'VIEW') AND c.table_name = " + str(input.table) +
      " ORDER BY c.ordinal_position LIMIT 100";
    const schema = groupSchema(await run(schemaQuery));
    const table = schema.find(item => item.name === input.table);
    if (!table) return NextResponse.json({ error: "Dataset not found in your authorized Supabase schema." }, { status: 404 });
    const goal = typeof input.goal === "string" ? input.goal.trim().slice(0, 300) : "Explore patterns in this dataset";
    let result: NextResponse;
    switch (stage) {
      case "plan": result = response("plan", await plan(table, goal), ""); break;
      case "profile": result = await profile(table, input, run); break;
      case "overview": result = await overview(table, input, run); break;
      case "drivers": result = await drivers(table, input, run); break;
      case "trend": result = await trend(table, input, run); break;
      case "filter-options": result = await filterOptions(table, input, run); break;
      default: throw new Error("Unknown investigation stage.");
    }
    if (access.refreshed) {
      const { issuedAt, ...saved } = session;
      saveSession(result, saved);
    }
    return result;
  } catch (problem) {
    console.error("Investigation stage failed:", problem);
    return NextResponse.json({
      error: problem instanceof Error && /approved|valid category|dataset|dashboard filter|category field/i.test(problem.message)
        ? problem.message : "Investigation could not complete. Confirm your database permissions and try again."
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
