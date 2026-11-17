import type { ChartDetails, ChartType, Column } from "./types";

const names: ChartType[] = ["bar", "horizontal_bar", "line", "area", "pie", "donut", "scatter", "histogram", "box", "violin", "heatmap", "stacked_bar", "grouped_bar", "kde", "lollipop", "waterfall"];

function isNumber(value: unknown) {
  return (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim() !== "" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()));
}

function isTime(name: string) {
  return /(?:date|month|year|week|quarter|period|time)/i.test(name);
}

export function suggestFigures(question: string, columns: Column[], rows: Record<string, unknown>[], preferred: string[] = []): ChartDetails[] {
  if (rows.length < 2) return [];
  const numeric = columns.filter(c => c.type === "number" && !/(?:^id$|_id$|uuid|postcode|postal|phone|zip|code)/i.test(c.name) && !isTime(c.name)).map(c => c.name);
  const dates = columns.filter(c => c.type === "date" || isTime(c.name)).map(c => c.name);
  const groups = columns.filter(c => c.type === "text" && !/(^id$|_id$|uuid)/i.test(c.name)).map(c => c.name);
  const category = dates[0] || groups[0] || "";
  const main = numeric.find(n => question.toLowerCase().includes(n.replace(/_/g, " ").toLowerCase())) || numeric[0] || "";
  const numericValues = (field: string) => rows.filter(r => isNumber(r[field])).length;
  const nonnegative = main && rows.every(row => isNumber(row[main]) && Number(row[main]) >= 0);
  const requested: ChartType[] = [];
  const rules: [RegExp, ChartType][] = [
    [/\b(horizontal\s+bar|ranking|ranked|top\s+\d+)\b/i, "horizontal_bar"],
    [/\b(stacked|stacked\s+bar)\b/i, "stacked_bar"],
    [/\b(grouped|side.by.side|clustered)\b/i, "grouped_bar"],
    [/\b(heatmap|heat\s+map|correlation\s+matrix)\b/i, "heatmap"],
    [/\b(histogram|frequency\s+distribution)\b/i, "histogram"],
    [/\b(violin)\b/i, "violin"],
    [/\b(box\s*plot|boxplot|quartile|outliers?)\b/i, "box"],
    [/\b(density|kde)\b/i, "kde"],
    [/\b(scatter|correlation|relationship\s+between)\b/i, "scatter"],
    [/\b(donut|doughnut)\b/i, "donut"],
    [/\b(pie|proportion|share\s+of)\b/i, "pie"],
    [/\b(area\s+chart)\b/i, "area"],
    [/\b(line\s+chart|trend|over\s+time|monthly|yearly|weekly)\b/i, "line"],
    [/\b(lollipop)\b/i, "lollipop"],
    [/\b(waterfall)\b/i, "waterfall"],
    [/\b(bar|column)\b/i, "bar"]
  ];
  for (const p of preferred) if (names.includes(p as ChartType) && !requested.includes(p as ChartType)) requested.push(p as ChartType);
  for (const [pattern, kind] of rules) if (pattern.test(question) && !requested.includes(kind)) requested.push(kind);
  if (!requested.length) {
    if (dates.length && main) requested.push("line");
    else if (category && main) requested.push(rows.length > 8 ? "horizontal_bar" : "bar");
    else if (numeric.length >= 2) requested.push("scatter");
    else if (main && rows.length >= 5) requested.push("histogram");
  }
  if (/\b(dashboard|multiple|several|different\s+charts|visualizations|figures)\b/i.test(question)) {
    for (const kind of dates.length ? ["area", "bar"] : category && numeric.length >= 2 ? ["grouped_bar", "heatmap"] : category ? ["horizontal_bar", "lollipop"] : ["box", "histogram"]) {
      if (requested.length >= 3) break;
      if (!requested.includes(kind as ChartType)) requested.push(kind as ChartType);
    }
  }
  const result: ChartDetails[] = [];
  for (const kind of requested) {
    if (result.length >= 3) break;
    let x = category;
    let y = main;
    let extra: string[] = [];
    if (["scatter", "heatmap"].includes(kind)) {
      if (numeric.length < 2 || rows.length < 3) continue;
      x = numeric[0]; y = numeric[1]; extra = numeric.slice(0, 6);
    } else if (["box", "violin", "histogram", "kde"].includes(kind)) {
      if (!main || numericValues(main) < 5) continue;
      x = groups[0] || "";
    } else if (["stacked_bar", "grouped_bar"].includes(kind)) {
      if (!category || numeric.length < 2) continue;
      extra = numeric.slice(0, 5);
    } else if (["pie", "donut"].includes(kind)) {
      if (!category || !nonnegative || rows.length > 10) continue;
    } else if (["line", "area", "waterfall"].includes(kind)) {
      if (!category || !main) continue;
      if (kind === "waterfall" && rows.length > 30) continue;
    } else if (!category || !main) continue;
    if (!y || numericValues(y) < 2) continue;
    const title = (kind === "heatmap" ? "Relationship between numeric measures" : kind === "histogram" ? "Distribution of " + y : kind === "box" ? "Spread of " + y : kind === "violin" ? "Distribution by group" : kind === "kde" ? "Density of " + y : y.replace(/_/g, " ") + (x ? " by " + x.replace(/_/g, " ") : ""));
    if (!result.some(c => c.type === kind)) result.push({ type: kind, title, x, y, extra });
  }
  return result;
}
