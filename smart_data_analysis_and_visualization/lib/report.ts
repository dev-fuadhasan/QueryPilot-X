import type { AnalysisResult, Column } from "./types";
import { suggestFigures } from "./figures";

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function fmt(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function label(name: string) {
  return name.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());
}

function periodColumn(col: Column) {
  return col.type === "date" || /(?:^|_)(date|month|year|week|quarter|period|time)(?:_|$)/i.test(col.name);
}

export function createReport(question: string, sql: string, allRows: Record<string, unknown>[], tableName: string): AnalysisResult {
  const truncated = allRows.length > 100;
  const rows = allRows.slice(0, 100);
  const keys = rows.length ? Object.keys(rows[0]).slice(0, 30) : [];
  const columns: Column[] = keys.map(name => {
    const values = rows.map(row => row[name]).filter(v => v !== null && v !== undefined);
    const isDate = values.length > 0 && values.every(v => typeof v === "string" && /^\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?/.test(v));
    const isNum = values.length > 0 && values.every(v => numeric(v) !== null);
    return { name, type: isDate ? "date" : isNum ? "number" : "text" };
  });
  const nums = columns.filter(c => c.type === "number" && !/(?:^id$|_id$|uuid|postal|zip|phone|code|year|month)/i.test(c.name));
  const metric = nums.find(c => question.toLowerCase().includes(c.name.replace(/_/g, " ").toLowerCase())) ||
    nums.find(c => /revenue|sales|profit|total|amount|quantity|price|count|rate|average|metric|value/i.test(c.name)) || nums[0];
  const time = columns.find(periodColumn);
  const category = columns.find(c => c.type === "text" && !/(^id$|_id$|uuid)/i.test(c.name));
  let title = "Analysis result";
  let leadValue = "—";
  let leadLabel = "Result";
  let interpretation = "The requested calculation did not return a usable numeric value.";
  let facts: string[] = [];
  if (!rows.length) {
    title = "No matching data";
    leadLabel = "No matching records";
    interpretation = "No records matched the requested filters. Try another period, metric or table.";
  } else if (metric) {
    const measure = label(metric.name);
    if (rows.length === 1) {
      const currentColumn = nums.find(c => /(^|_)(current|latest|new|this_period)(_|$)/i.test(c.name));
      const earlierColumn = nums.find(c => /(^|_)(previous|prior|earlier|old|last_period)(_|$)/i.test(c.name));
      const currentValue = currentColumn ? numeric(rows[0][currentColumn.name]) : null;
      const previousValue = earlierColumn ? numeric(rows[0][earlierColumn.name]) : null;
      if (currentValue !== null && previousValue !== null && currentColumn && earlierColumn) {
        const delta = currentValue - previousValue;
        const direction = delta < 0 ? "decreased" : delta > 0 ? "increased" : "remained unchanged";
        const pct = previousValue !== 0 ? ` by ${fmt(Math.abs(delta / previousValue) * 100)}%` : "";
        const target = /\b(drop\w*|decreas\w*|declin\w*|fall\w*|fell|down)\b/i.test(question) ? "drop" : /\b(increas\w*|ris\w*|grow\w*|rose|up)\b/i.test(question) ? "increase" : "";
        const yesNo = target === "drop" ? delta < 0 ? "Yes. " : "No. " : target === "increase" ? delta > 0 ? "Yes. " : "No. " : "";
        leadValue = fmt(currentValue);
        leadLabel = label(currentColumn.name);
        title = "Revenue and performance comparison";
        interpretation = `${yesNo}${label(currentColumn.name)} ${direction}${pct}, from ${fmt(previousValue)} to ${fmt(currentValue)}.`;
        facts = [`${label(earlierColumn.name)}: ${fmt(previousValue)}.`, `${label(currentColumn.name)}: ${fmt(currentValue)}.`, `The measure ${direction}${pct}.`];
      } else {
        const value = numeric(rows[0][metric.name]);
        if (value !== null) {
          leadValue = fmt(value);
          leadLabel = measure;
          title = measure;
          interpretation = `The calculated ${measure.toLowerCase()} is ${fmt(value)} for the requested data.`;
          facts = [`${measure}: ${fmt(value)}.`];
          if (/drop|decreas|declin|fall|ris|increas|grow|chang/i.test(question)) {
            interpretation += " A change cannot be confirmed without a comparable earlier period.";
          }
        }
      }
    } else if (time && rows.every(row => row[time.name] !== null && row[time.name] !== undefined)) {
      const comparableDates = rows.every(row => /^\d{4}(?:[-/]\d{1,2})?/.test(String(row[time.name])));
      const ordered = comparableDates ? [...rows].sort((a, b) => String(a[time.name]).localeCompare(String(b[time.name]), undefined, { numeric: true })) : [...rows];
      const valid = ordered.filter(row => numeric(row[metric.name]) !== null);
      if (valid.length >= 2) {
        const previous = valid[valid.length - 2];
        const current = valid[valid.length - 1];
        const oldValue = numeric(previous[metric.name]) || 0;
        const newValue = numeric(current[metric.name]) || 0;
        const delta = newValue - oldValue;
        const relative = oldValue !== 0 ? Math.abs(delta / oldValue * 100) : null;
        const direction = delta < 0 ? "decreased" : delta > 0 ? "increased" : "remained unchanged";
        const target = /\b(drop\w*|decreas\w*|declin\w*|fall\w*|fell|down)\b/i.test(question) ? "drop" : /\b(increas\w*|ris\w*|grow\w*|rose|up)\b/i.test(question) ? "increase" : "";
        const judgement = target === "drop" ? delta < 0 ? "Yes. " : "No. " : target === "increase" ? delta > 0 ? "Yes. " : "No. " : "";
        leadValue = fmt(newValue);
        leadLabel = measure + " · " + String(current[time.name]);
        title = measure + " trend";
        const comparison = relative !== null ? ` by ${fmt(relative)}%` : "";
        interpretation = judgement + `${measure} ${direction}${comparison}, from ${fmt(oldValue)} in ${String(previous[time.name])} to ${fmt(newValue)} in ${String(current[time.name])}.`;
        facts = [`Latest ${measure}: ${fmt(newValue)} (${String(current[time.name])}).`, `Previous ${measure}: ${fmt(oldValue)} (${String(previous[time.name])}).`, `${measure} ${direction}${comparison} between these two periods.`];
      }
    }
    if (!facts.length) {
      const valid = rows.filter(row => numeric(row[metric.name]) !== null);
      const byValue = [...valid].sort((a, b) => (numeric(b[metric.name]) || 0) - (numeric(a[metric.name]) || 0));
      if (byValue.length) {
        const highest = byValue[0];
        const lowest = byValue[byValue.length - 1];
        const who = category && highest[category.name] != null ? String(highest[category.name]) : "the highest result";
        leadValue = fmt(numeric(highest[metric.name]) || 0);
        leadLabel = "Highest " + measure;
        title = measure + (category ? " comparison" : " analysis");
        interpretation = `${who} has the highest displayed ${measure.toLowerCase()} at ${leadValue}.`;
        facts = [`Highest ${measure}: ${leadValue}${category ? " (" + who + ")" : ""}.`];
        if (byValue.length > 1 && lowest !== highest) {
          const low = fmt(numeric(lowest[metric.name]) || 0);
          const group = category && lowest[category.name] != null ? String(lowest[category.name]) : "the lowest result";
          interpretation += ` ${group} is lowest at ${low}.`;
          facts.push(`Lowest ${measure}: ${low}${category ? " (" + group + ")" : ""}.`);
        }
      }
    }
  } else {
    leadValue = String(rows[0][keys[0]] ?? "—");
    title = "Query result";
    leadLabel = label(keys[0] || "Result");
    interpretation = "The matching data is shown in the supporting table below.";
    facts = [interpretation];
  }
  return {
    type: "result", question, title, leadValue, leadLabel, interpretation, facts,
    sql, columns, rows, truncated,
    charts: suggestFigures(question, columns, rows), tableName, createdAt: new Date().toISOString()
  };
}
