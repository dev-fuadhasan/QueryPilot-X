import { NextRequest, NextResponse } from "next/server";
import { readSession, sameOrigin, saveSession } from "@/lib/session";
import { groupSchema, queryPostgres, type SchemaTable } from "@/lib/database";
import { queryOAuth, refreshSession } from "@/lib/supabase";
import { proposeDashboardPanel, type ProposedDashboardPanel } from "@features/smart_data_analysis_and_visualization/lib/ai";
import type { CustomPanelSpec, CustomPanelData, CustomPanelPoint } from "@features/smart_data_analysis_and_visualization/lib/intelligence";
import { DEFAULT_CATEGORY_RESULTS, DEFAULT_MONTHLY_RESULTS, parseRequestedResultCount, verifiedResultCount, verifiedSortDirection } from "@features/smart_data_analysis_and_visualization/lib/panelRanking";

export const runtime = "nodejs";
export const maxDuration = 60;

type Input = {
  action?: unknown;
  table?: unknown;
  prompt?: unknown;
  title?: unknown;
  spec?: unknown;
  filterDimension?: unknown;
  filterValue?: unknown;
};
const numberType = /(?:int|numeric|decimal|double|real|float|money)/i;
const dateType = /(?:date|timestamp)/i;
const categoryType = /(?:char|text|uuid|enum)/i;
const privateField = /(?:password|secret|token|api_?key|phone|mobile|email|ssn|address|passport|national_id|first_name|last_name|full_name|notes|message|comment|description|review|free_text|text_body)/i;
const identifier = /(?:^id$|_id$|uuid|postcode|postal|zip|serial|tracking_number)/i;
const allowedCharts = new Set(["kpi", "bar", "line", "area", "pie", "table"]);
const allowedAggregates = new Set(["count", "sum", "average", "min", "max"]);
const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
const text = (value: unknown) => typeof value === "string" ? value : "";
const numeric = (value: unknown) => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const source = (table: SchemaTable) => "public." + quote(table.name);

function available(table: SchemaTable) {
  return {
    metrics: table.columns.filter(column => numberType.test(column.type) && !privateField.test(column.name) && !identifier.test(column.name)).map(column => column.name).slice(0, 35),
    dimensions: table.columns.filter(column => categoryType.test(column.type) && !privateField.test(column.name) && !identifier.test(column.name)).map(column => column.name).slice(0, 35),
    times: table.columns.filter(column => dateType.test(column.type) && !privateField.test(column.name)).map(column => column.name).slice(0, 12)
  };
}
function namedMatch(request: string, names: string[], aliases: Record<string,string[]>) {
  const words = " " + normalize(request) + " ";
  const matches = names.filter(name => {
    const normalized = normalize(name);
    return normalized.length > 1 && words.includes(" " + normalized + " ");
  });
  if (matches.length) return matches.sort((a,b)=>b.length-a.length)[0];
  for (const [key, alternatives] of Object.entries(aliases)) {
    if (alternatives.some(alias => words.includes(" " + alias + " "))) {
      const match = names.find(name => normalize(name).includes(key));
      if (match) return match;
    }
  }
  return null;
}
const metricAliases: Record<string,string[]> = {
  revenue:["revenue","turnover","sales amount","income"], sales:["sales","sold"],
  profit:["profit","earnings"], quantity:["quantity","units sold","volume"],
  price:["price","unit price"], amount:["amount","total amount"],
  cost:["cost","expense"], fare:["fare","ticket price"],
  score:["score","rating"], age:["age"]
};
const dimensionAliases: Record<string,string[]> = {
  region:["region","area","territory"], category:["category","segment","group"],
  product:["product","products","item","items","product name","product names"], country:["country","nation"], city:["city"],
  gender:["gender","sex"], department:["department","team"], status:["status"],
  class:["class"], channel:["channel"], type:["type"]
};
function fallback(request: string, columns: ReturnType<typeof available>): ProposedDashboardPanel | null {
  const prompt = normalize(request);
  const metric = namedMatch(request, columns.metrics, metricAliases);
  const dimension = namedMatch(request, columns.dimensions, dimensionAliases);
  const time = namedMatch(request, columns.times, {date:["date","monthly","month","time","over time"], created:["created","created at"]});
  if (/\b(forecast|predict|prediction|causality|cause|root cause|anomaly|map|geospatial|scatter|correlation|regression|machine learning|join)\b/i.test(prompt)) return null;
  const wantsTime = /\b(trend|monthly|over time|time series|timeline|weekly|yearly|line chart|area chart|by month|per month|by year|per year)\b/.test(prompt);
  const wantsKpi = /\b(kpi|single number|total|overall|summary|average|mean|minimum|maximum|count|number of|how many)\b/.test(prompt) && !/\b(by|per|group|breakdown|trend|monthly|distribution)\b/.test(prompt);
  const wantsPie = /\b(pie|donut|share|proportion|percentage)\b/.test(prompt);
  const wantsTable = /\b(table|ranking|ranked|list)\b/.test(prompt);
  const explicitAggregate = /\b(average|mean|avg|sum|total|count|how many|number of|minimum|maximum|min|max)\b/.test(prompt);
  if (metric && /(?:price|cost|age|rate|score|salary)/i.test(metric) && !explicitAggregate) return null;
  const aggregate = /\b(average|mean|avg)\b/.test(prompt) ? "average"
    : /\b(minimum|smallest|lowest)\b/.test(prompt) ? "min"
    : /\b(maximum|largest|highest)\b/.test(prompt) ? "max"
    : /\b(count|how many|number of|frequency)\b/.test(prompt) ? "count"
    : metric ? "sum" : "count";
  const chart = wantsTime ? /\barea\b/.test(prompt) ? "area" : "line"
    : wantsKpi ? "kpi"
    : wantsPie ? "pie"
    : wantsTable ? "table" : "bar";
  if (wantsTime && !(time || columns.times.length === 1)) return null;
  if (!wantsTime && chart !== "kpi" && !(dimension || columns.dimensions.length === 1)) return null;
  if (aggregate !== "count" && !metric) return null;
  // Without an identified measure, do not silently reinterpret a sum request as a record count.
  if (!metric && !dimension && !/\b(count|how many|number of|frequency|records|rows|customers|orders|transactions|products|items)\b/.test(prompt)) return null;
  return {
    chart,
    aggregation: aggregate,
    metric: aggregate === "count" ? null : metric,
    dimension: wantsTime || chart === "kpi" ? null : dimension || columns.dimensions[0] || null,
    time: wantsTime ? time || columns.times[0] || null : null,
    title: request.slice(0, 70)
  };
}
function validate(spec: ProposedDashboardPanel, table: SchemaTable, userTitle?: string): CustomPanelSpec {
  const columns = available(table);
  if (!allowedCharts.has(spec.chart) || !allowedAggregates.has(spec.aggregation)) throw new Error("Requested chart or calculation is not supported.");
  const field = (name: unknown, candidates: string[]) => typeof name === "string" && candidates.includes(name) ? name : null;
  const metric = field(spec.metric, columns.metrics);
  const dimension = field(spec.dimension, columns.dimensions);
  const time = field(spec.time, columns.times);
  if (spec.aggregation !== "count" && !metric) throw new Error("No compatible numeric metric exists for this calculation.");
  if (["bar","pie","table"].includes(spec.chart) && !dimension) throw new Error("This panel needs a suitable categorical field in the selected dataset.");
  if (["line","area"].includes(spec.chart) && !time) throw new Error("This panel needs a real date or timestamp column in the selected dataset.");
  if (spec.chart === "pie" && !["sum","count"].includes(spec.aggregation)) throw new Error("Share charts require additive totals or counts. Use a bar chart for averages or minima.");
  return {
    chart: spec.chart, aggregation: spec.aggregation, metric, dimension, time,
    title: (userTitle || spec.title || "Custom panel").trim().slice(0, 65),
    description: spec.aggregation + (metric ? " of " + metric : " of records") +
      (time ? " over " + time : dimension ? " by " + dimension : ""),
    resultLimit: verifiedResultCount(spec.resultLimit,
      ["line","area"].includes(spec.chart) ? DEFAULT_MONTHLY_RESULTS : DEFAULT_CATEGORY_RESULTS),
    sortDirection: verifiedSortDirection(spec.sortDirection)
  };
}
function filter(input: Input, table: SchemaTable) {
  if (input.filterValue === null || input.filterValue === undefined) return "";
  const dimension = text(input.filterDimension);
  if (!available(table).dimensions.includes(dimension) || typeof input.filterValue !== "string" || input.filterValue.length > 110) {
    throw new Error("The requested linked filter is not valid for this dataset.");
  }
  return input.filterValue === "(missing)" ? quote(dimension) + " IS NULL" :
    "LEFT(CAST(" + quote(dimension) + " AS text), 110) = " + literal(input.filterValue);
}
function expr(spec: CustomPanelSpec) {
  if (spec.aggregation === "count") return "COUNT(*)::double precision";
  const column = quote(spec.metric || "");
  const numericCol = column + "::numeric";
  if (spec.aggregation === "sum") return "SUM(" + numericCol + ")::double precision";
  if (spec.aggregation === "average") return "AVG(" + numericCol + ")::double precision";
  if (spec.aggregation === "min") return "MIN(" + numericCol + ")::double precision";
  return "MAX(" + numericCol + ")::double precision";
}
async function execute(spec: CustomPanelSpec, table: SchemaTable, input: Input, run: (sql:string)=>Promise<Record<string,unknown>[]>):Promise<CustomPanelData> {
  const condition = filter(input, table);
  const constraints = [condition].filter(Boolean);
  let sql = "";
  if (spec.chart === "kpi") {
    sql = "SELECT COUNT(*)::bigint AS records, " + expr(spec) + " AS value FROM " + source(table) +
      (constraints.length ? " WHERE " + constraints.join(" AND ") : "");
  } else if (spec.chart === "line" || spec.chart === "area") {
    const col = quote(spec.time || "");
    constraints.push(col + " IS NOT NULL");
    sql = "SELECT TO_CHAR(DATE_TRUNC('month', " + col + "), 'YYYY-MM') AS label, COUNT(*)::bigint AS records, " +
      expr(spec) + " AS value FROM " + source(table) + " WHERE " + constraints.join(" AND ") +
      " GROUP BY 1 ORDER BY 1 " + (spec.sortDirection === "asc" ? "ASC" : "DESC") +
      " LIMIT " + spec.resultLimit;
  } else {
    const col = quote(spec.dimension || "");
    const group = "LEFT(CAST(" + col + " AS text), 110)";
    sql = "SELECT COALESCE(" + group + ", '(missing)') AS label, COUNT(*)::bigint AS records, " +
      expr(spec) + " AS value FROM " + source(table) +
      (constraints.length ? " WHERE " + constraints.join(" AND ") : "") +
      " GROUP BY 1 ORDER BY value " + (spec.sortDirection === "asc" ? "ASC" : "DESC") +
      " NULLS LAST, records DESC, label ASC LIMIT " + spec.resultLimit;
  }
  const rows = await run(sql);
  if (!rows.length || (spec.chart === "kpi" && Number(rows[0].records) === 0)) {
    throw new Error("No matching records were found for this requested panel.");
  }
  const points: CustomPanelPoint[] = rows.filter(row => row.value !== null && row.value !== undefined && Number.isFinite(Number(row.value))).map((row,index) => ({
    label: String(row.label || (index === 0 ? "All records" : "Other")),
    records: numeric(row.records),
    value: numeric(row.value)
  }));
  if (!points.length) throw new Error("The requested metric has no usable numeric values in this dataset.");
  if ((spec.chart === "line" || spec.chart === "area") && spec.sortDirection !== "asc") points.reverse();
  if (spec.chart === "pie" && (points.some(point => point.value < 0) || !points.some(point => point.value > 0))) {
    throw new Error("A share chart needs non-negative values and a positive total. Try a bar chart instead.");
  }
  return {points, total:spec.chart === "kpi" ? points[0].value : ["sum","count"].includes(spec.aggregation) ? points.reduce((sum,point)=>sum+point.value,0) : null, sql};
}
function failure(message: string, status=422) {
  return NextResponse.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return failure("Invalid request origin.",403);
  const current = await readSession();
  if (!current || (!current.dbUrl && !(current.mode === "oauth" && current.projectRef))) return failure("Connect to Supabase first.",401);
  try {
    const raw:unknown = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure("Invalid panel request.");
    const input = raw as Input;
    if (!["create","refresh"].includes(text(input.action)) || typeof input.table !== "string" ||
        input.table.length > 120 || input.table.includes("\u0000")) return failure("Select an authorized dataset.");
    const action = input.action as "create" | "refresh";
    if (action === "create" && (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 300)) {
      return failure("Describe the panel you want in 300 characters or fewer.");
    }
    const access = current.mode === "oauth" ? await refreshSession(current) : {session:current,refreshed:false};
    const session = access.session;
    const run = (sql:string) => session.mode === "oauth" ? queryOAuth(session,sql) : queryPostgres(session.dbUrl||"",sql);
    const sqlSchema = "SELECT c.table_name,c.column_name,c.data_type FROM information_schema.columns c " +
      "JOIN information_schema.tables t ON c.table_schema=t.table_schema AND c.table_name=t.table_name " +
      "WHERE c.table_schema='public' AND t.table_type IN ('BASE TABLE','VIEW') AND c.table_name=" +
      literal(input.table) + " ORDER BY c.ordinal_position LIMIT 100";
    const schema = groupSchema(await run(sqlSchema));
    const table = schema.find(item => item.name === input.table);
    if (!table) return failure("The selected dataset is not available in this Supabase project.",404);
    let spec:CustomPanelSpec;
    if (action === "create") {
      const prompt = (input.prompt as string).trim();
      if (/\b(forecast|prediction|predict|root cause|causality|anomaly|map|geospatial|scatter|correlation|regression|machine learning|join|median|percentile|variance|standard deviation|moving average|growth rate|growth percentage)\b/i.test(prompt)) {
        return failure("This custom builder supports factual KPI, category and time-series aggregations only. The requested analysis is not available.");
      }
      const cols = available(table);
      const requested = parseRequestedResultCount(prompt);
      const explicitMetric = namedMatch(prompt,cols.metrics,metricAliases);
      const explicitGroup = namedMatch(prompt,cols.dimensions,dimensionAliases);
      const explicitTime = namedMatch(prompt,cols.times,{date:["date","dates","time","month","months"],created:["created","creation"]});
      if (requested && (requested.mode === "top" || requested.mode === "bottom" || requested.mode === "first")) {
        // Ranking is enforced by the server. An LLM is not allowed to ignore "top five".
        if (/\b(month|months|year|years|date|dates)\b/i.test(prompt)) {
          return failure("Ranking months by a metric is not supported. Try 'latest 5 months' for a time-series chart.");
        }
        const isProductRequest = /\b(?:products?|items?)\b/i.test(prompt) && !/\b(?:categories|category|types)\b/i.test(prompt);
        const productName = isProductRequest ? cols.dimensions.find(name =>
          /^(?:product_?name|product_?title|item_?name|item_?title|product|item)$/i.test(name)) : null;
        const group = productName || explicitGroup || (cols.dimensions.length === 1 ? cols.dimensions[0] : null);
        if (!group) return failure("To rank " + requested.count + " items, specify a category column that exists in this dataset (for example, product or region).");
        const wantsAverage = /\b(average|mean|avg)\b/i.test(prompt);
        const wantsMin = /\b(minimum|min|smallest)\b/i.test(prompt);
        const wantsMax = /\b(maximum|max|largest)\b/i.test(prompt);
        const wantsCount = /\b(count|number of|how many|frequency|records)\b/i.test(prompt);
        const aggregation: ProposedDashboardPanel["aggregation"] = wantsAverage ? "average" : wantsMin ? "min" : wantsMax ? "max" : wantsCount || !explicitMetric ? "count"
          : /\b(price|rate|score|age)\b/i.test(explicitMetric) && !/\b(total|sum)\b/i.test(prompt) ? "average" : "sum";
        const forced: ProposedDashboardPanel = {
          chart: /\b(pie|donut|share)\b/i.test(prompt) ? "pie" : /\b(table|list)\b/i.test(prompt) ? "table" : "bar",
          aggregation, metric: aggregation === "count" ? null : explicitMetric,
          dimension: group, time: null, title: prompt.slice(0,70),
          resultLimit: requested.count,
          sortDirection: requested.mode === "bottom" || requested.mode === "first" ? "asc" : "desc"
        };
        spec = validate(forced,table,typeof input.title==="string" ? input.title : undefined);
      } else if (requested && requested.mode === "recent") {
        if (!/\b(month|months|year|years|date|dates|period|periods)\b/i.test(prompt)) {
          return failure("Use 'latest " + requested.count + " months' for a time-series panel. This dataset view has no general chronological ranking.");
        }
        const time = explicitTime || (cols.times.length === 1 ? cols.times[0] : null);
        if (!time) return failure("This dataset has no matching date column for the requested latest " + requested.count + " periods.");
        const aggregate: ProposedDashboardPanel["aggregation"] = explicitMetric ? /\b(average|mean|avg)\b/i.test(prompt) ? "average" : "sum" : "count";
        spec = validate({
          chart:/\barea\b/i.test(prompt) ? "area" : "line",
          aggregation:aggregate, metric:aggregate === "count" ? null : explicitMetric,
          dimension:null,time,title:prompt.slice(0,70),
          resultLimit:requested.count,sortDirection:"desc"
        },table,typeof input.title==="string" ? input.title : undefined);
      } else {
        const ai = await proposeDashboardPanel(prompt,cols.metrics,cols.dimensions,cols.times);
        const deterministic = fallback(prompt,cols);
        const proposed = ai || deterministic;
        if (!proposed) return failure("I couldn't match that request to supported fields in this dataset. Try a metric and grouping, e.g. 'Average price by category' or 'Monthly order count'.");
        try { spec = validate(proposed,table,typeof input.title==="string" ? input.title : undefined); }
        catch (problem) {
          if (!deterministic || proposed===deterministic) throw problem;
          spec = validate(deterministic,table,typeof input.title==="string" ? input.title : undefined);
        }
      }
    } else {
      const existing = input.spec;
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) return failure("Saved panel configuration is missing.");
      const candidate = existing as ProposedDashboardPanel;
      spec = validate(candidate,table,typeof (existing as CustomPanelSpec).title==="string" ? (existing as CustomPanelSpec).title : undefined);
    }
    const data = await execute(spec,table,input,run);
    const response = NextResponse.json({spec,data},{headers:{"Cache-Control":"no-store"}});
    if (access.refreshed) {
      const {issuedAt,...saved}=session;
      saveSession(response,saved);
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/requested|no matching|not available|not valid|unsupported|compatible|suitable|needs|saved panel|no usable|chart|aggregation|limit|rank|category|date column|period/i.test(message)) return failure(message.slice(0,250));
    console.error("Dashboard panel generation failed",err);
    return failure("Could not build this panel from the selected dataset. Check its fields and permissions.");
  }
}
