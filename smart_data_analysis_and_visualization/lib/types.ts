export type Column = { name: string; type: "number" | "date" | "text" };
export type ChartType = "bar" | "horizontal_bar" | "line" | "area" | "pie" | "donut" | "scatter" | "histogram" | "box" | "violin" | "heatmap" | "stacked_bar" | "grouped_bar" | "kde" | "lollipop" | "waterfall";
export type ChartDetails = { type: ChartType; title: string; x: string; y: string; extra?: string[] };
export type Figure = { title: string; type: ChartType; image: string };
export type AnalysisResult = {
  type: "result";
  question: string;
  title: string;
  leadValue: string;
  leadLabel: string;
  interpretation: string;
  facts: string[];
  sql: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  charts: ChartDetails[];
  tableName: string;
  createdAt: string;
};
export type Clarification = {
  type: "clarification";
  kind?: "table" | "metric" | "dimension" | "period" | "value";
  question: string;
  options: string[];
  optionQueries?: string[];
  originalQuestion: string;
};
export type AnalysisResponse = AnalysisResult | Clarification;
