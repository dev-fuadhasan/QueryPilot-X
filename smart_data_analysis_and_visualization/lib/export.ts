import type { AnalysisResult } from "./types";

const escape = (value: unknown) => String(value === null || value === undefined ? "—" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function reportHtml(report: AnalysisResult, chartSvg = "") {
  const headers = report.columns.map(col => "<th>" + escape(col.name.replace(/_/g, " ")) + "</th>").join("");
  const cells = report.rows.map(row => "<tr>" + report.columns.map(col => "<td>" + escape(row[col.name]) + "</td>").join("") + "</tr>").join("");
  const findings = report.findings.map(finding => "<li>" + escape(finding) + "</li>").join("");
  const figure = chartSvg ? "<section><h2>Visualization</h2><div class='chart'>" + chartSvg + "</div></section>" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>QueryPilot Report</title><style>
  *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;max-width:1000px;margin:44px auto;padding:0 30px;color:#20232a;line-height:1.6}h1{font-size:30px;letter-spacing:-.5px;margin-bottom:7px}h2{font-size:17px;margin-top:34px}h3{margin-top:28px}.brand{font-size:12px;font-weight:bold;letter-spacing:1.8px;color:#4b6488}.muted{color:#76808c;font-size:12px}.intro{padding:16px 18px;background:#f5f7f9;border:1px solid #e6eaee;border-radius:9px;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:11px;min-width:580px}td,th{padding:10px;border-bottom:1px solid #e7eaf0;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f3f5f8}table{break-inside:auto}tr{break-inside:avoid}pre{padding:16px;background:#f4f6f8;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;font-size:11px}.chart svg{width:100%;max-height:310px}.table-wrap{overflow:auto}.actions{margin-top:20px}.actions button{padding:10px 15px;border:0;background:#1c2430;color:#fff;border-radius:6px;cursor:pointer}@media print{body{margin:0;padding:0 10px;max-width:none}.actions{display:none}h2{break-after:avoid}thead{display:table-header-group}}@page{size:A4;margin:15mm}
  </style></head><body><div class="brand">QUERYPILOT</div><h1>${escape(report.title)}</h1><p class="muted">Generated ${escape(new Date(report.createdAt).toLocaleString())} · Source: ${escape(report.tableName)}</p><p><strong>Question:</strong> ${escape(report.question)}</p><div class="intro">${escape(report.summary)}</div><section><h2>Key findings</h2><ul>${findings || "<li>No numerical findings were available for these results.</li>"}</ul></section>${figure}<section><h2>Query results</h2><div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${cells}</tbody></table></div></section><section><h2>Executed SQL</h2><pre>${escape(report.sql)}</pre></section><p class="muted">This report summarizes the displayed results only. Check filters, units and data quality before making decisions.</p><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div></body></html>`;
}

export function downloadHtml(report: AnalysisResult, chartSvg = "") {
  const file = new Blob([reportHtml(report, chartSvg)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "QueryPilot_Report_" + new Date(report.createdAt).toISOString().slice(0, 10) + ".html";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function printReport(report: AnalysisResult, chartSvg = "") {
  const target = window.open("", "_blank");
  if (!target) throw new Error("Allow pop-ups to open the printable report.");
  target.document.open();
  target.document.write(reportHtml(report, chartSvg));
  target.document.close();
  target.focus();
}
