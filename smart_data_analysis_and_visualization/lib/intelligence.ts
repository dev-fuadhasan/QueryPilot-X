export type InvestigationStage = "plan" | "profile" | "overview" | "drivers" | "trend";
export type InvestigationPlan = {
  table: string;
  metric: string | null;
  dimension: string | null;
  time: string | null;
  metrics: string[];
  dimensions: string[];
  times: string[];
  columnCount: number;
  planner: "AI-assisted" | "Schema-guided";
  rationale: string;
};
export type QualityField = { column: string; missing: number; missingPercent: number };
export type QualityData = { sampledRecords: number; sampleLimit: number; fields: QualityField[] };
export type OverviewData = {
  records: number;
  total: number | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
};
export type GroupPoint = { label: string; records: number; value: number };
export type TrendPoint = { period: string; records: number; value: number };
export type Evidence = { stage: InvestigationStage; sql: string; completedAt: string };
export type InvestigationBundle = {
  plan: InvestigationPlan;
  quality?: QualityData;
  overview?: OverviewData;
  drivers?: GroupPoint[];
  trend?: TrendPoint[];
  evidence: Evidence[];
  goal: string;
};
export type DataResponse<T> = { stage: InvestigationStage; data: T; sql: string; completedAt: string };
export type DashboardPanelKind = "kpi" | "trend" | "drivers" | "mix" | "table" | "custom";
export type DashboardPanel = {
  id: string;
  kind: DashboardPanelKind;
  title: string;
  wide: boolean;
  chart: "bar" | "line" | "area" | "pie";
  spec?: CustomPanelSpec;
};

export type CustomChart = "kpi" | "gauge" | "bullet" | "progress" | "thermometer" | "bar" | "column" | "grouped_bar" | "stacked_bar" | "stacked_100" | "lollipop" | "line" | "area" | "stacked_area" | "sparkline" | "combo" | "pie" | "donut" | "treemap" | "waffle" | "radar" | "histogram" | "box" | "density" | "violin" | "scatter" | "bubble" | "heatmap" | "correlation" | "funnel" | "waterfall" | "slope" | "bump" | "parallel" | "network" | "sankey" | "table" | "pivot";
export type CustomAggregation = "count" | "sum" | "average" | "min" | "max";
export type CustomPanelSpec = {
  chart: CustomChart;
  aggregation: CustomAggregation;
  metric: string | null;
  dimension: string | null;
  time: string | null;
  title: string;
  description: string;
  resultLimit?: number;
  sortDirection?: "asc" | "desc";
  gaugeMin?: number;
  gaugeMax?: number;
  secondDimension?: string | null;
  secondaryMetric?: string | null;
  xMetric?: string | null;
  sizeMetric?: string | null;
  metrics?: string[];
};
export type CustomPanelPoint = { label: string; value: number; records: number; secondValue?: number };
export type VisualCell = { label: string; series: string; value: number; records: number };
export type VisualSample = { x: number; y?: number; size?: number; values?: number[] };
export type CustomPanelData = {
  points: CustomPanelPoint[];
  total: number | null;
  sql: string;
  cells?: VisualCell[];
  samples?: VisualSample[];
  columns?: string[];
};

export type DashboardFilter = { column: string; value: string };
