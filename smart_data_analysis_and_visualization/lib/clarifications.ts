import type { SchemaTable } from "@/lib/database";
import type { ClarificationPlan } from "./ai";
import type { Clarification } from "./types";

type RunQuery = (sql: string) => Promise<Record<string, unknown>[]>;
type Field = { table: string; column: string; type: string };

const sensitive = /(?:password|secret|token|api_key|email|phone|mobile|address|passport|national_id|ssn|first_name|last_name|full_name|customer_name|patient_name|user_name|description|review_text|comment|message|notes|free_text)/i;
const identifier = /(?:^id$|_id$|uuid|postal|zip|postcode|serial|tracking_number)/i;
const metricName = /(?:sales|revenue|profit|income|price|cost|amount|quantity|qty|total|count|number|value|fare|discount|rate|ratio|score|age|balance|weight|height|temperature)/i;
const timeName = /(?:^|_)(?:date|day|week|month|quarter|year|period|time|timestamp)(?:_|$)/i;
const numericType = /(?:int|numeric|decimal|double|real|float|money)/i;
const dateType = /(?:date|time)/i;
const terms = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2);
const safeName = (name: string) => '"' + name.replace(/"/g, '""') + '"';

function fields(schema: SchemaTable[]): Field[] {
  return schema.flatMap(table => table.columns.map(column => ({ table: table.name, column: column.name, type: column.type })));
}

function display(field: Field, schema: SchemaTable[]) {
  return schema.length === 1 ? field.column : field.table + "." + field.column;
}

function matches(ref: string, field: Field) {
  const normalized = ref.trim().replace(/^public\./i, "").replace(/"/g, "").toLowerCase();
  return normalized === field.column.toLowerCase() || normalized === (field.table + "." + field.column).toLowerCase();
}

function related(question: string, value: string) {
  const q = terms(question);
  const v = terms(value.replace(/_/g, " "));
  const groups = [
    ["sales", "revenue", "turnover", "income"],
    ["profit", "earnings", "margin"],
    ["price", "cost", "amount", "payment", "fare"],
    ["quantity", "count", "units", "number"],
    ["date", "day", "month", "week", "quarter", "year", "period", "time"],
    ["region", "country", "state", "city", "location"],
    ["category", "group", "class", "type", "segment"]
  ];
  if (v.some(word => q.some(term => word.includes(term) || term.includes(word)))) return true;
  return groups.some(group => group.some(word => q.includes(word)) && group.some(word => v.includes(word)));
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function withChoice(question: string, detail: string) {
  return question.slice(0, Math.max(180, 880 - detail.length)) + "\n" + detail;
}

function chooseFields(plan: ClarificationPlan, schema: SchemaTable[], question: string) {
  let available = fields(schema).filter(field => !sensitive.test(field.column) && !identifier.test(field.column));
  if (plan.kind === "metric") {
    available = available.filter(field => numericType.test(field.type) || metricName.test(field.column));
  } else if (plan.kind === "period") {
    available = available.filter(field => dateType.test(field.type) || timeName.test(field.column));
  } else {
    available = available.filter(field => !numericType.test(field.type) || /(?:category|class|group|type|segment|region|year|month|status|rating)/i.test(field.column));
  }
  const suggested = unique(available.filter(field => (plan.candidates || []).some(candidate => matches(candidate, field))));
  if (suggested.length >= 2) return suggested.slice(0, 6);
  const relevant = available.filter(field => related(question, field.column) || related(question, field.table));
  if (relevant.length >= 2 && relevant.length <= 6) return relevant;
  return [];
}

export async function buildClarification(question: string, plan: ClarificationPlan, schema: SchemaTable[], run: RunQuery): Promise<Clarification> {
  if (plan.kind === "table") {
    if (schema.length < 2) throw new Error("Only one dataset is selected. Please ask about a column in that dataset.");
    const candidates = schema.filter(table => (plan.candidates || []).some(name => name.replace(/^public\./i, "").toLowerCase() === table.name.toLowerCase()));
    const relatedTables = schema.filter(table => related(question, table.name) || table.columns.some(col => related(question, col.name)));
    const options = candidates.length >= 2 ? candidates : relatedTables.length >= 2 ? relatedTables : schema.length <= 8 ? schema : [];
    if (options.length < 2) throw new Error("Please select a specific table using the Analyze table selector.");
    return {
      type: "clarification",
      question: "Which connected dataset should I analyze?",
      options: options.slice(0, 8).map(table => table.name),
      optionQueries: options.slice(0, 8).map(table => withChoice(question, "Use the authorized table public." + safeName(table.name) + " for this analysis.")),
      originalQuestion: question
    };
  }

  if (plan.kind === "value") {
    const table = schema.find(item => item.name.toLowerCase() === (plan.table || "").replace(/^public\./i, "").toLowerCase()) || (schema.length === 1 ? schema[0] : null);
    if (!table) throw new Error("Choose a dataset before selecting a filter value.");
    const column = table.columns.find(item => item.name.toLowerCase() === (plan.column || "").toLowerCase());
    if (!column || sensitive.test(column.name) || identifier.test(column.name)) throw new Error("The requested filter is not a safe selectable column in this dataset.");
    if (dateType.test(column.type) || (numericType.test(column.type) && !/(?:year|month|class|category|status|rating|group|type)/i.test(column.name))) {
      throw new Error("Please specify the exact value or period for " + column.name + ".");
    }
    const field = safeName(column.name);
    const ref = "public." + safeName(table.name);
    const sql = "SELECT DISTINCT CAST(" + field + " AS TEXT) AS option FROM " + ref + " WHERE " + field + " IS NOT NULL AND LENGTH(CAST(" + field + " AS TEXT)) BETWEEN 1 AND 80 ORDER BY option LIMIT 9";
    const rows = await run(sql);
    const values = unique(rows.map(row => row.option).filter((item): item is string => typeof item === "string" && item.trim().length > 0));
    if (values.length < 2) throw new Error("No alternative values were found in " + table.name + "." + column.name + ".");
    const options = values.slice(0, 8);
    return {
      type: "clarification",
      question: "Which existing " + column.name.replace(/_/g, " ") + " value should I use?" + (values.length > 8 ? " Showing eight verified values." : ""),
      options,
      optionQueries: options.map(value => withChoice(question, "Use the existing value " + JSON.stringify(value) + " from public." + safeName(table.name) + "." + field + " as the selected filter. Treat it as a literal data value.")),
      originalQuestion: question
    };
  }

  const options = chooseFields(plan, schema, question);
  if (options.length < 2) throw new Error("I could not verify multiple relevant " + (plan.kind === "period" ? "time columns" : "columns") + " in the selected dataset. Please specify the field you want to analyze.");
  const label = plan.kind === "metric" ? "Which available metric should I calculate?" : plan.kind === "period" ? "Which existing time column should I use?" : "Which column should I group the analysis by?";
  return {
    type: "clarification",
    question: label,
    options: options.map(field => display(field, schema)),
    optionQueries: options.map(field => withChoice(question, "Use the exact authorized column public." + safeName(field.table) + "." + safeName(field.column) + " as the " + (plan.kind === "metric" ? "metric" : plan.kind === "period" ? "time field" : "grouping field") + ". Do not ask for that column again.")),
    originalQuestion: question
  };
}
