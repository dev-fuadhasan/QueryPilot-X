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

export type CustomChart = "kpi" | "bar" | "line" | "area" | "pie" | "table";
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
};
export type CustomPanelPoint = { label: string; value: number; records: number };
export type CustomPanelData = { points: CustomPanelPoint[]; total: number | null; sql: string };
\nexport type DashboardFilter = { column: string; value: string };\n