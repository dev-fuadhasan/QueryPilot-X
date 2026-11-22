import type { AnalysisDimension, AnalysisReport } from "./types";

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Neutralize spreadsheet formula injection for string labels starting with formula characters
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function row(cells: unknown[]): string {
  return cells.map(escapeCsvCell).join(",");
}

function isAvailable(report: AnalysisReport, key: string): boolean {
  return !report.availableMetrics || report.availableMetrics.includes(key);
}

function formatMetric(report: AnalysisReport, key: string, value: number | null, decimals = 2): string {
  if (!isAvailable(report, key)) return "Unavailable";
  if (value === null || !Number.isFinite(value)) return "";
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

function appendDimensionSection(lines: string[], title: string, items: AnalysisDimension[]) {
  if (!items.length) return;
  lines.push("");
  lines.push(row([title]));
  lines.push(row(["Label", "Revenue", "Orders", "Units", "Product Lines", "Gross Profit", "Discounts", "Average Rating"]));
  for (const item of items) {
    lines.push(row([
      item.label,
      item.revenue.toFixed(2),
      item.orders,
      item.units,
      item.productLines,
      item.grossProfit.toFixed(2),
      item.discounts.toFixed(2),
      item.averageRating === null ? "" : item.averageRating.toFixed(2)
    ]));
  }
}

export function csvFilename(report: AnalysisReport): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  return `querypilot-x-report-${safe(report.reportKind)}-${safe(report.periodStart)}-to-${safe(report.periodEnd)}.csv`;
}

export function buildReportCsv(report: AnalysisReport): string {
  const lines: string[] = [];

  lines.push(row(["QueryPilot X - Daily Analysis Report"]));
  lines.push(row(["Report Kind", report.reportKind]));
  lines.push(row(["Reporting Date", report.reportingDate]));
  lines.push(row(["Period Start", report.periodStart]));
  lines.push(row(["Period End", report.periodEnd]));
  lines.push(row(["Comparison Period", report.comparisonStart && report.comparisonEnd ? `${report.comparisonStart} to ${report.comparisonEnd}` : "N/A"]));
  lines.push(row(["Dataset Table", report.dataset?.table || "N/A"]));
  lines.push(row(["Generated At", report.generatedAt]));

  lines.push("");
  lines.push(row(["Summary KPIs"]));
  lines.push(row(["Metric", "Current Period", "Comparison Daily Average"]));

  const comp = report.comparisonDailyAverage;
  const kpiRows: Array<[string, string, number | null, number | null, number]> = [
    ["Total Revenue", "totalRevenue", report.current.totalRevenue, comp ? comp.totalRevenue : null, 2],
    ["Total Orders", "totalOrders", report.current.totalOrders, comp ? comp.totalOrders : null, 0],
    ["Units Sold", "totalUnitsSold", report.current.totalUnitsSold, comp ? comp.totalUnitsSold : null, 0],
    ["Product Lines", "totalProductLines", report.current.totalProductLines, comp ? comp.totalProductLines : null, 0],
    ["Gross Profit", "grossProfit", report.current.grossProfit, comp ? comp.grossProfit : null, 2],
    ["Profit Margin (%)", "grossProfitMargin", report.current.grossProfitMargin, comp ? comp.grossProfitMargin : null, 2],
    ["Total Discounts", "totalDiscounts", report.current.totalDiscounts, comp ? comp.totalDiscounts : null, 2],
    ["Average Order Value", "averageOrderValue", report.current.averageOrderValue, comp ? comp.averageOrderValue : null, 2],
    ["Average Customer Rating", "averageCustomerRating", report.current.averageCustomerRating, comp ? comp.averageCustomerRating : null, 2]
  ];

  for (const [label, key, currentValue, comparisonValue, decimals] of kpiRows) {
    lines.push(row([
      label,
      formatMetric(report, key, currentValue, decimals),
      comp ? formatMetric(report, key, comparisonValue, 2) : "N/A"
    ]));
  }

  lines.push("");
  lines.push(row(["Order Status Distribution"]));
  lines.push(row(["Status", "Orders"]));
  for (const [status, count] of Object.entries(report.current.statusDistribution || {})) {
    lines.push(row([status, count]));
  }

  if (report.dailyPerformance.length) {
    lines.push("");
    lines.push(row(["Daily Performance"]));
    lines.push(row(["Date", "Revenue", "Orders", "Units Sold", "Gross Profit", "Profit Margin (%)", "Average Order Value", "Average Rating"]));
    for (const day of report.dailyPerformance) {
      lines.push(row([
        day.date,
        formatMetric(report, "totalRevenue", day.totalRevenue, 2),
        formatMetric(report, "totalOrders", day.totalOrders, 0),
        formatMetric(report, "totalUnitsSold", day.totalUnitsSold, 0),
        formatMetric(report, "grossProfit", day.grossProfit, 2),
        formatMetric(report, "grossProfitMargin", day.grossProfitMargin, 2),
        formatMetric(report, "averageOrderValue", day.averageOrderValue, 2),
        formatMetric(report, "averageCustomerRating", day.averageCustomerRating, 2)
      ]));
    }
  }

  appendDimensionSection(lines, "Product Performance", report.productPerformance);
  appendDimensionSection(lines, "Category Performance", report.categoryPerformance);
  appendDimensionSection(lines, "Region Performance", report.regionPerformance);
  appendDimensionSection(lines, "Gender Performance", report.genderPerformance);

  return lines.join("\r\n");
}
