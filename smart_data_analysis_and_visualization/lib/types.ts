export type Column = { name: string; type: "number" | "date" | "text" };
export type ChartType = "bar" | "line" | "pie" | "area" | "scatter" | "none";
export type ChartDetails = { type: ChartType; x: string; y: string };
export type AnalysisResult = {
  type: "result";
  question: string;
  title: string;
  summary: string;
  findings: string[];
  sql: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  chart: ChartDetails;
  tableName: string;
  createdAt: string;
};
export type Clarification = {
  type: "clarification";
  question: string;
  options: string[];
  originalQuestion: string;
};
export type AnalysisResponse = AnalysisResult | Clarification;
