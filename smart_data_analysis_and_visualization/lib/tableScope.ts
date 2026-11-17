import type { SchemaTable } from "@/lib/database";

export type ResolvedScope =
  | { kind: "selected"; table: SchemaTable }
  | { kind: "clarify"; options: string[] };

const unrelated = new Set(["what", "which", "when", "where", "with", "from", "that", "this", "there", "about", "show", "give", "make", "data", "table", "tables", "dataset", "datasets", "total", "all", "the", "and", "for", "any", "each", "many", "much", "have", "been", "were", "will", "does", "did", "are", "is", "was", "over", "time", "report", "chart", "graph", "analysis", "compare", "comparison", "count", "number", "value", "values", "top", "bottom", "highest", "lowest", "average", "mean", "sum", "change", "changed", "increase", "decrease", "drop", "dropped", "trend"]);

const synonyms = [
  ["revenue", "sales", "turnover", "income"],
  ["profit", "earnings", "margin"],
  ["quantity", "units", "sold", "qty"],
  ["passenger", "passengers", "survived", "survival", "titanic"],
  ["fare", "ticket"],
  ["product", "products", "item", "items"],
  ["customer", "customers", "client", "clients"],
  ["region", "country", "state", "city", "location"],
  ["date", "year", "month", "week", "quarter", "period"],
  ["discount", "promotion"],
  ["category", "segment", "class", "type"],
  ["order", "orders", "transaction", "transactions"]
];

function words(text: string) {
  return text.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/).filter(Boolean);
}

function matchingTable(question: string, name: string) {
  const normalized = " " + words(question).join(" ") + " ";
  const full = words(name).join(" ");
  return full.length > 2 && normalized.includes(" " + full + " ");
}

function relevantTokens(question: string) {
  return [...new Set(words(question).filter(word => word.length > 2 && !unrelated.has(word)))];
}

function relevance(question: string, table: SchemaTable) {
  const queryTokens = relevantTokens(question);
  if (!queryTokens.length) return 0;
  const columnTokens = new Set(table.columns.flatMap(column => words(column.name)));
  const nameTokens = new Set(words(table.name));
  let score = 0;
  for (const token of queryTokens) {
    if (columnTokens.has(token)) { score += 3; continue; }
    if (nameTokens.has(token)) { score += 2; continue; }
    const family = synonyms.find(group => group.includes(token));
    if (family && family.some(word => columnTokens.has(word))) score += 1;
  }
  return score;
}

export function resolveTableScope(question: string, schema: SchemaTable[], requestedTable: string): ResolvedScope {
  if (!schema.length) throw new Error("No readable public tables were found.");
  if (requestedTable !== "all") {
    const selected = schema.find(table => table.name === requestedTable);
    if (!selected) throw new Error("The selected table is not available. Refresh the datasets and choose again.");
    const named = schema.filter(table => matchingTable(question, table.name));
    if (named.length && !named.some(table => table.name === selected.name)) {
      throw new Error("Your question names a different dataset. Switch the Analyze table selection to that dataset first.");
    }
    return { kind: "selected", table: selected };
  }
  if (schema.length === 1) return { kind: "selected", table: schema[0] };

  const named = schema.filter(table => matchingTable(question, table.name));
  if (named.length === 1) return { kind: "selected", table: named[0] };
  if (named.length > 1) return { kind: "clarify", options: named.map(table => table.name).slice(0, 12) };

  const matching = schema.filter(table => relevance(question, table) > 0);
  if (matching.length === 1) return { kind: "selected", table: matching[0] };
  return { kind: "clarify", options: (matching.length > 1 ? matching : schema).slice(0, 12).map(table => table.name) };
}
