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
  filters?: unknown;
};
const numberType = /(?:int|numeric|decimal|double|real|float|money)/i;
const dateType = /(?:date|timestamp)/i;
const categoryType = /(?:char|text|uuid|enum)/i;
const privateField = /(?:password|secret|token|api_?key|phone|mobile|email|ssn|address|passport|national_id|first_name|last_name|full_name|notes|message|comment|description|review|free_text|text_body)/i;
const identifier = /(?:^id$|_id$|uuid|postcode|postal|zip|serial|tracking_number)/i;
const singleCharts = new Set(["kpi","gauge","bullet","progress","thermometer"]);
const timeCharts = new Set(["line","area","sparkline","combo"]);
const seriesCharts = new Set(["grouped_bar","stacked_bar","stacked_100","stacked_area","slope","bump","heatmap","pivot","network","sankey"]);
const timeSeriesCharts = new Set(["stacked_area","slope","bump"]);
const sampleCharts = new Set(["histogram","box","density","violin"]);
const scatterCharts = new Set(["scatter","bubble"]);
const multiCharts = new Set(["correlation","parallel"]);
const additiveCharts = new Set(["pie","donut","treemap","waffle","funnel"]);
const allowedCharts = new Set(["kpi","gauge","bullet","progress","thermometer","bar","column","grouped_bar","stacked_bar","stacked_100","lollipop","line","area","stacked_area","sparkline","combo","pie","donut","treemap","waffle","radar","histogram","box","density","violin","scatter","bubble","heatmap","correlation","funnel","waterfall","slope","bump","parallel","network","sankey","table","pivot"]);
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
function validate(spec: ProposedDashboardPanel | CustomPanelSpec, table: SchemaTable, userTitle?: string): CustomPanelSpec {
  const columns = available(table);
  if (!allowedCharts.has(spec.chart) || !allowedAggregates.has(spec.aggregation)) throw new Error("Chart or calculation is not supported.");
  const field = (name: unknown, candidates: string[]) => typeof name === "string" && candidates.includes(name) ? name : null;
  const configured = spec as CustomPanelSpec;
  const metric = field(spec.metric, columns.metrics);
  const dimension = field(spec.dimension, columns.dimensions);
  const time = field(spec.time, columns.times);
  const secondDimension = field(configured.secondDimension, columns.dimensions);
  const secondaryMetric = field(configured.secondaryMetric, columns.metrics);
  const xMetric = field(configured.xMetric, columns.metrics);
  const sizeMetric = field(configured.sizeMetric, columns.metrics);
  const selectedMetrics = Array.isArray(configured.metrics) && configured.metrics.length <= 6
    ? configured.metrics.filter((name): name is string => typeof name === "string" && columns.metrics.includes(name))
    : [];
  if (spec.aggregation !== "count" && !metric && !multiCharts.has(spec.chart)) throw new Error("Select a numeric Y-axis field or use record count.");
  if (sampleCharts.has(spec.chart) && !metric) throw new Error("This distribution requires a numeric field.");
  if (scatterCharts.has(spec.chart) && (!metric || !xMetric || (spec.chart === "bubble" && !sizeMetric))) {
    throw new Error("Scatter requires numeric X and Y fields; bubble also requires a numeric size field.");
  }
  if (multiCharts.has(spec.chart) && (selectedMetrics.length < (spec.chart === "parallel" ? 3 : 2) || new Set(selectedMetrics).size !== selectedMetrics.length)) {
    throw new Error("Choose " + (spec.chart === "parallel" ? "three" : "two") + " or more distinct numeric fields.");
  }
  if (timeCharts.has(spec.chart) && !time) throw new Error("This trend needs an existing date or timestamp column.");
  if (spec.chart === "combo" && (!metric || !secondaryMetric || secondaryMetric === metric)) {
    throw new Error("Combo charts require two distinct numeric measures for bars and line.");
  }
  if (seriesCharts.has(spec.chart)) {
    if (timeSeriesCharts.has(spec.chart)) {
      if (!time || !dimension) throw new Error("This trend needs a date field and a category series field.");
    } else if (!dimension || !secondDimension || dimension === secondDimension) {
      throw new Error("This comparison needs two different categorical fields.");
    }
  }
  const ordinaryCategory = !singleCharts.has(spec.chart) && !timeCharts.has(spec.chart) &&
    !seriesCharts.has(spec.chart) && !sampleCharts.has(spec.chart) && !scatterCharts.has(spec.chart) &&
    !multiCharts.has(spec.chart);
  if (ordinaryCategory && !dimension) throw new Error("This visualization requires a categorical X-axis field.");
  if (additiveCharts.has(spec.chart) && !["sum","count"].includes(spec.aggregation)) {
    throw new Error("Share and funnel charts require additive totals or record counts.");
  }
  if (spec.chart === "radar" && !["sum","count"].includes(spec.aggregation)) {
    throw new Error("Radar charts require comparable summed values or counts.");
  }
  if (["stacked_100","stacked_area","sankey","network"].includes(spec.chart) &&
      !["sum","count"].includes(spec.aggregation)) {
    throw new Error("This visual requires additive totals or counts, not averages or extrema.");
  }
  const gaugeMin = configured.gaugeMin === undefined ? 0 : configured.gaugeMin;
  const gaugeMax = configured.gaugeMax === undefined ? 100 : configured.gaugeMax;
  if (["gauge","bullet","progress","thermometer"].includes(spec.chart) && (
    typeof gaugeMin !== "number" || !Number.isFinite(gaugeMin) ||
    typeof gaugeMax !== "number" || !Number.isFinite(gaugeMax) ||
    gaugeMax <= gaugeMin || Math.abs(gaugeMax) > 1e15 || Math.abs(gaugeMin) > 1e15
  )) throw new Error("Set a valid target range where maximum is greater than minimum.");
  if (spec.chart === "progress" && (gaugeMin !== 0 || gaugeMax <= 0)) {
    throw new Error("Progress bars use a zero baseline and a positive target.");
  }
  return {
    chart: spec.chart, aggregation: spec.aggregation,
    metric: multiCharts.has(spec.chart) ? null : metric,
    dimension, time,
    title: (userTitle || spec.title || "Custom panel").trim().slice(0, 65),
    description: spec.aggregation + (metric ? " of " + metric : " of records") +
      (time ? " over " + time : dimension ? " by " + dimension : ""),
    resultLimit: verifiedResultCount(spec.resultLimit,
      (timeCharts.has(spec.chart) || timeSeriesCharts.has(spec.chart)) ? DEFAULT_MONTHLY_RESULTS : DEFAULT_CATEGORY_RESULTS),
    sortDirection: verifiedSortDirection(spec.sortDirection),
    ...(singleCharts.has(spec.chart) ? { gaugeMin, gaugeMax } : {}),
    ...(seriesCharts.has(spec.chart) ? { secondDimension: timeSeriesCharts.has(spec.chart) ? null : secondDimension } : {}),
    ...(spec.chart === "combo" ? { secondaryMetric } : {}),
    ...(scatterCharts.has(spec.chart) ? { xMetric, sizeMetric:spec.chart === "bubble" ? sizeMetric : null } : {}),
    ...(multiCharts.has(spec.chart) ? { metrics:selectedMetrics } : {})
  };
}
function filter(input: Input, table: SchemaTable) {
  const raw: unknown = input.filters === undefined
    ? (input.filterValue === null || input.filterValue === undefined
      ? [] : [{ column: input.filterDimension, value: input.filterValue }])
    : input.filters;
  if (!Array.isArray(raw) || raw.length > 3) throw new Error("Invalid dashboard filters.");
  const approved = available(table).dimensions;
  const seen = new Set<string>();
  const constraints: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid dashboard filter.");
    const selected = item as { column?: unknown; value?: unknown };
    if (typeof selected.column !== "string" || !approved.includes(selected.column) ||
        typeof selected.value !== "string" || selected.value.length > 110 || seen.has(selected.column)) {
      throw new Error("Selected dashboard filters are not valid for this dataset.");
    }
    seen.add(selected.column);
    constraints.push(selected.value === "(missing)" ? quote(selected.column) + " IS NULL" :
      "LEFT(CAST(" + quote(selected.column) + " AS text), 110) = " + literal(selected.value));
  }
  return constraints.join(" AND ");
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
async function execute(spec: CustomPanelSpec, table: SchemaTable, input: Input,
  run: (sql:string)=>Promise<Record<string,unknown>[]>): Promise<CustomPanelData> {
  const condition = filter(input,table);
  const conditions = [condition].filter(Boolean);
  const from = source(table);
  const where = (xs: string[]) => xs.length ? " WHERE " + xs.join(" AND ") : "";
  const category = (name:string) => "COALESCE(LEFT(CAST(" + quote(name) + " AS text), 90), '(missing)')";
  const dateLabel = (name:string) => "TO_CHAR(DATE_TRUNC('month', " + quote(name) + "), 'YYYY-MM')";
  const finite = (v:unknown) => v !== null && v !== undefined && Number.isFinite(Number(v));
  const currentChart = spec.chart;
  const limit = spec.resultLimit || DEFAULT_CATEGORY_RESULTS;
  let sql = "";
  let rows:Record<string,unknown>[] = [];

  if (sampleCharts.has(currentChart)) {
    const col = quote(spec.metric || "");
    sql = "SELECT ("+col+")::double precision AS x FROM "+from+
      where([...conditions,col+" IS NOT NULL"])+" LIMIT 1500";
    rows = await run(sql);
    const samples = rows.filter(row=>finite(row.x)).map(row=>({x:numeric(row.x)}));
    if(samples.length<5) throw new Error("This distribution needs at least five finite numeric observations.");
    return {points:[],total:null,samples,sql};
  }

  if (scatterCharts.has(currentChart)) {
    const x=quote(spec.xMetric||""),y=quote(spec.metric||""),z=quote(spec.sizeMetric||"");
    const whereParts=[...conditions,x+" IS NOT NULL",y+" IS NOT NULL"];
    if(currentChart==="bubble") whereParts.push(z+" IS NOT NULL");
    sql = "SELECT ("+x+")::double precision AS x, ("+y+")::double precision AS y"+
      (currentChart==="bubble"?", ("+z+")::double precision AS size":"")+
      " FROM "+from+where(whereParts)+" LIMIT 800";
    rows = await run(sql);
    const samples=rows.filter(row=>finite(row.x)&&finite(row.y)&&
        (currentChart!=="bubble" || (finite(row.size)&&numeric(row.size)>=0)))
      .map(row=>({x:numeric(row.x),y:numeric(row.y),
        ...(currentChart==="bubble"?{size:numeric(row.size)}:{})}));
    if(samples.length<2) throw new Error("No usable paired numeric observations exist for these fields.");
    return {points:[],total:null,samples,sql};
  }

  if (multiCharts.has(currentChart)) {
    const metrics=spec.metrics||[];
    const projections=metrics.map((name,i)=>"("+quote(name)+")::double precision AS m"+i);
    sql="SELECT "+projections.join(", ")+" FROM "+from+where(conditions)+" LIMIT 800";
    rows=await run(sql);
    const samples=rows.map(row=>metrics.map((_,i)=>row["m"+i]))
      .filter(values=>values.every(finite)).map(values=>({x:numeric(values[0]),values:values.map(numeric)}));
    if(samples.length<5)throw new Error("At least five rows with valid values across the selected numeric fields are required.");
    return {points:[],total:null,samples,columns:metrics,sql};
  }

  if (seriesCharts.has(currentChart)) {
    const primary=timeSeriesCharts.has(currentChart)?dateLabel(spec.time||""):category(spec.dimension||"");
    const secondary=category(timeSeriesCharts.has(currentChart)?spec.dimension||"":spec.secondDimension||"");
    const parts=[...conditions];
    if(timeSeriesCharts.has(currentChart))parts.push(quote(spec.time||"")+" IS NOT NULL");
    sql="SELECT "+primary+" AS label, "+secondary+" AS series, COUNT(*)::bigint AS records, "+
      expr(spec)+" AS value FROM "+from+where(parts)+
      " GROUP BY 1,2 ORDER BY value DESC NULLS LAST, label ASC LIMIT 240";
    rows=await run(sql);
    const cells=rows.filter(row=>finite(row.value)).map(row=>({
      label:String(row.label??""),series:String(row.series??""),records:numeric(row.records),value:numeric(row.value)
    }));
    if(!cells.length)throw new Error("No compatible grouped values were found for these fields.");
    if(["sankey","network","stacked_100","stacked_area"].includes(currentChart) &&
       (cells.some(c=>c.value<0)||!cells.some(c=>c.value>0))) {
      throw new Error("This visualization requires non-negative values and a positive total.");
    }
    if((currentChart==="slope"||currentChart==="bump")&&
        new Set(cells.map(c=>c.label)).size<2)throw new Error("At least two distinct time periods are needed.");
    return {points:[],total:null,cells,sql};
  }

  const scalar = singleCharts.has(currentChart);
  const timed=timeCharts.has(currentChart);
  if(scalar) {
    sql="SELECT COUNT(*)::bigint AS records, "+expr(spec)+" AS value FROM "+from+where(conditions);
  } else if(timed) {
    const col=quote(spec.time||"");
    const second=spec.chart==="combo"? ", "+expr({...spec,metric:spec.secondaryMetric||null})+" AS second_value":"";
    sql="SELECT "+dateLabel(spec.time||"")+" AS label, COUNT(*)::bigint AS records, "+
      expr(spec)+" AS value"+second+" FROM "+from+
      where([...conditions,col+" IS NOT NULL"])+" GROUP BY 1 ORDER BY 1 "+
      (spec.sortDirection==="asc"?"ASC":"DESC")+" LIMIT "+limit;
  } else {
    sql="SELECT "+category(spec.dimension||"")+" AS label, COUNT(*)::bigint AS records, "+
      expr(spec)+" AS value FROM "+from+where(conditions)+
      " GROUP BY 1 ORDER BY value "+(spec.sortDirection==="asc"?"ASC":"DESC")+
      " NULLS LAST, records DESC, label ASC LIMIT "+limit;
  }
  rows=await run(sql);
  if(!rows.length||(scalar&&Number(rows[0].records)===0))throw new Error("No matching records were found.");
  const points:CustomPanelPoint[]=rows.filter(row=>finite(row.value)).map((row,i)=>({
    label:String(row.label||(i===0?"All records":"Other")),
    records:numeric(row.records),value:numeric(row.value),
    ...(spec.chart==="combo"&&finite(row.second_value)?{secondValue:numeric(row.second_value)}:{})
  }));
  if(!points.length)throw new Error("The selected metric contains no usable numeric values.");
  if(timed&&spec.sortDirection!=="asc")points.reverse();
  if(currentChart==="radar"&&points.length<3)throw new Error("Radar charts require three or more categories.");
  if(currentChart==="combo"&&points.some(row=>row.secondValue===undefined))throw new Error("The second metric contains missing or invalid values.");
  if(["pie","donut","treemap","waffle","funnel","radar"].includes(currentChart)&&
     (points.some(row=>row.value<0)||!points.some(row=>row.value>0))) {
    throw new Error("This visualization requires non-negative values with at least one positive total.");
  }
  return {
    points,total:scalar?points[0].value:["sum","count"].includes(spec.aggregation)?
      points.reduce((sum,point)=>sum+point.value,0):null,sql
  };
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
    if (!["create","refresh","schema"].includes(text(input.action)) || typeof input.table !== "string" ||
        input.table.length > 120 || input.table.includes("\u0000")) return failure("Select an authorized dataset.");
    const action = input.action as "create" | "refresh" | "schema";
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
    if (action === "schema") {
      const response = NextResponse.json({table:table.name,fields:available(table)}, {headers:{"Cache-Control":"no-store"}});
      if (access.refreshed) {
        const {issuedAt,...saved}=session;
        saveSession(response,saved);
      }
      return response;
    }
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
    if (/requested|no matching|not available|not valid|unsupported|compatible|suitable|needs|saved panel|no usable|chart|aggregation|limit|rank|category|date column|period|gauge|minimum|maximum|scale|numeric|rows|finite|fields|target|values/i.test(message)) return failure(message.slice(0,250));
    console.error("Dashboard panel generation failed",err);
    return failure("Could not build this panel from the selected dataset. Check its fields and permissions.");
  }
}
