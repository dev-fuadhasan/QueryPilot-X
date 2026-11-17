import type { AnalysisResult, Figure } from "./types";

function escape(value: unknown) {
  return String(value === null || value === undefined ? "—" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function reportHtml(report: AnalysisResult, figures: Figure[] = [], fallbackSvgs: string[] = []) {
  const headers = report.columns.map(col => `<th>${escape(col.name.replace(/_/g, " "))}</th>`).join("");
  const cells = report.rows.map(row => "<tr>" + report.columns.map(col => "<td>" + escape(row[col.name]) + "</td>").join("") + "</tr>").join("");
  const charts = report.charts.map((chart, index) => {
    const figure = figures.find(item => item.type === chart.type && item.title === chart.title);
    const source = figure ? `<img src="${escape(figure.image)}" alt="${escape(chart.title)}">` : fallbackSvgs[index] || "<p>View this figure in the QueryPilot workspace.</p>";
    return `<article class="figure"><h3>${escape(chart.title)}</h3>${source}</article>`;
  }).join("");
  const metric = report.leadValue !== "—" ? `<div class="metric"><strong>${escape(report.leadValue)}</strong><span>${escape(report.leadLabel)}</span></div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(report.title)} — QueryPilot</title><style>
  *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;max-width:1050px;margin:35px auto;padding:0 27px;color:#253749;line-height:1.6}.brand{font-size:12px;font-weight:750;letter-spacing:2px;color:#536e84}h1{font-size:30px;margin:15px 0 5px}h2{font-size:18px;margin-top:32px}h3{font-size:14px}.meta{color:#8793a0;font-size:11px}.answer{border:1px solid #e3e9ef;background:#f9fbfc;border-radius:11px;padding:22px 24px;margin:18px 0}.metric{display:flex;align-items:baseline;gap:15px;margin:15px 0}.metric strong{font-size:40px;letter-spacing:-1px}.metric span{font-size:12px;color:#758493}.summary{font-size:15px;color:#455867;margin:13px 0}.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px}.figure{break-inside:avoid;border:1px solid #edf0f3;padding:12px;border-radius:9px}.figure img{display:block;width:100%;max-height:330px;object-fit:contain}.figure svg{width:100%;height:auto;max-height:310px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:11px}th,td{padding:9px 11px;border-bottom:1px solid #e9edf1;text-align:left;overflow-wrap:anywhere}th{background:#f5f7f9}pre{background:#f4f6f8;padding:13px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px}.actions{margin:24px 0}.actions button{padding:10px 16px;background:#243b51;color:white;border:0;border-radius:7px;cursor:pointer}@media print{body{margin:0;padding:0 7px}.actions{display:none}.figure{page-break-inside:avoid}thead{display:table-header-group}}@page{size:A4;margin:15mm}
  </style></head><body><div class="brand">QUERYPILOT</div><p class="meta">${escape(new Date(report.createdAt).toLocaleString())} · ${escape(report.tableName)}</p><div class="answer"><p class="meta">${escape(report.question)}</p><h1>${escape(report.title)}</h1>${metric}<p class="summary">${escape(report.interpretation)}</p></div>${charts ? `<section><h2>Figures</h2><div class="figures">${charts}</div></section>` : ""}<section><h2>Supporting data</h2><div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${cells}</tbody></table></div></section><section><h2>Executed SQL</h2><pre>${escape(report.sql)}</pre></section><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div></body></html>`;
}

export function downloadHtml(report: AnalysisResult, figures: Figure[] = [], fallbackSvgs: string[] = []) {
  const blob = new Blob([reportHtml(report, figures, fallbackSvgs)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "QueryPilot_Report_" + report.createdAt.slice(0, 10) + ".html";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function printReport(report: AnalysisResult, figures: Figure[] = [], fallbackSvgs: string[] = []) {
  const target = window.open("", "_blank");
  if (!target) throw new Error("Allow pop-ups for the printable report.");
  target.document.open();
  target.document.write(reportHtml(report, figures, fallbackSvgs));
  target.document.close();
  target.focus();
}
