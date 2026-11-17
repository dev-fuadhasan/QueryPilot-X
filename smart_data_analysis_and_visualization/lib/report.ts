import type { AnalysisResult, ChartDetails, Column } from "./types";

function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

export function createReport(question: string, sql: string, allRows: Record<string, unknown>[], tableName: string): AnalysisResult {
  const truncated = allRows.length > 100;
  const rows = allRows.slice(0, 100);
  const keys = rows.length ? Object.keys(rows[0]).slice(0, 30) : [];
  const columns: Column[] = keys.map(name => {
    const values = rows.map(row => row[name]).filter(value => value !== null && value !== undefined);
    const date = values.length > 0 && values.every(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value));
    const number = values.length > 0 && values.every(value => numeric(value) !== null);
    return { name, type: date ? "date" : number ? "number" : "text" };
  });
  const measures = columns.filter(col => col.type === "number" && !/(^id$|_id$|uuid|postal|zip|phone|code)/i.test(col.name));
  const categories = columns.filter(col => col.type !== "number" && !/(^id$|_id$|uuid)/i.test(col.name));
  const trend = /\b(line|trend|over time|time series|area)\b/i.test(question);
  const pie = /\b(pie|donut|share|proportion)\b/i.test(question);
  const scatter = /\b(scatter|correlation)\b/i.test(question);
  const x = categories.find(col => col.type === "date")?.name || categories[0]?.name || measures[0]?.name || "";
  const y = measures.find(col => col.name !== x)?.name || "";
  let type: ChartDetails["type"] = "none";
  if (rows.length > 1 && x && y) {
    if (scatter && columns.find(col => col.name === x)?.type === "number") type = "scatter";
    else if (trend && categories.find(col => col.name === x)?.type === "date") type = /area/i.test(question) ? "area" : "line";
    else if (pie && rows.length <= 8 && !truncated && rows.every(row => (numeric(row[y]) ?? -1) >= 0)) type = "pie";
    else type = categories.find(col => col.name === x)?.type === "date" ? "line" : "bar";
  }
  const findings: string[] = [];
  if (!rows.length) findings.push("The query returned no matching records.");
  if (rows.length === 1) {
    for (const measure of measures.slice(0, 3)) findings.push(measure.name.replace(/_/g, " ") + ": " + String(rows[0][measure.name]));
  } else if (rows.length > 1 && x && y) {
    const ranked = rows.filter(row => numeric(row[y]) !== null).sort((a, b) => Number(b[y]) - Number(a[y]));
    if (ranked.length) findings.push("Highest displayed " + y.replace(/_/g, " ") + ": " + String(ranked[0][y]) + " for " + String(ranked[0][x]) + ".");
    if (ranked.length > 1) findings.push("Lowest displayed " + y.replace(/_/g, " ") + ": " + String(ranked[ranked.length - 1][y]) + " for " + String(ranked[ranked.length - 1][x]) + ".");
  }
  if (truncated) findings.push("Only the first 100 result rows are included in this report.");
  return {
    type: "result",
    question,
    title: "Data analysis report",
    summary: rows.length + (truncated ? "+" : "") + " result rows from " + tableName + ". The figures below describe the returned results, not the entire database.",
    findings,
    sql,
    columns,
    rows,
    truncated,
    chart: { type, x, y },
    tableName,
    createdAt: new Date().toISOString()
  };
}
