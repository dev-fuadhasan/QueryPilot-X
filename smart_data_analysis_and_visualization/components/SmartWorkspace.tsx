"use client";

import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, BarChart3, CheckCircle2, Database, Download, FileDown, LoaderCircle, MessageSquare, Send, ShieldCheck } from "lucide-react";
import DatasetsPanel, { type Table } from "./DatasetsPanel";
import IntelligenceStudio from "./IntelligenceStudio";
import { CategoryTick, ChartCategoryLegend, FullCategoryLabels, ScrollableChart, categoryAxisWidth } from "./ReadableCharts";
import { downloadHtml, printReport } from "../lib/export";
import type { AnalysisResponse, AnalysisResult, ChartDetails, Clarification, Figure } from "../lib/types";

type Props = { tables: Table[]; loading: boolean; onRefresh: () => void; projectName: string; projectRef: string; aiEnabled: boolean };
type Message = { role: "user" | "assistant"; text: string };
const palette = ["#42627d", "#789cb3", "#9bbcc5", "#bd8e7d", "#769d8e", "#d1b17f"];

function asText(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChartPreview({ report, chart }: { report: AnalysisResult; chart: ChartDetails }) {
  if (!report.rows.length) return null;
  let data = report.rows.map(row => ({ ...row, [chart.y]: Number(row[chart.y]), ...(chart.type === "scatter" ? { [chart.x]: Number(row[chart.x]) } : {}) }));
  const view = chart.type;
  if (view === "histogram") {
    const values = data.map(row => Number(row[chart.y])).filter(Number.isFinite);
    if (!values.length) return null;
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const step = Math.max((maximum - minimum) / 8, 1e-9);
    data = Array.from({ length: 8 }, (_, i) => ({ ...data[0], bin: (minimum + i * step).toFixed(2), count: values.filter(v => i === 7 ? v >= minimum + i * step : v >= minimum + i * step && v < minimum + (i + 1) * step).length }));
  }
  const axis = <><CartesianGrid stroke="#e9edf0" strokeDasharray="3 3"/><XAxis dataKey={view === "histogram" ? "bin" : chart.x} tick={{ fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false}/><Tooltip/></>;
  if (view === "pie" || view === "donut") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={275}><PieChart><Pie data={data} dataKey={chart.y} nameKey={chart.x} cx="50%" cy="50%" outerRadius={94} innerRadius={view === "donut" ? 52 : 0}>{data.map((_, i) => <Cell key={i} fill={palette[i % palette.length]}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer><ChartCategoryLegend rows={data.map(row => ({label:String(row[chart.x] ?? "Unknown"),value:Number(row[chart.y]) || 0}))}/></div>;
  if (view === "scatter") return <ResponsiveContainer width="100%" height={290}><ScatterChart><CartesianGrid stroke="#eef1f4"/><XAxis type="number" dataKey={chart.x} name={chart.x}/><YAxis type="number" dataKey={chart.y} name={chart.y}/><Tooltip cursor={{ strokeDasharray: "3 3" }}/><Scatter data={data} fill={palette[1]}/></ScatterChart></ResponsiveContainer>;
  if (view === "line" || view === "area") return <ResponsiveContainer width="100%" height={290}>{view === "line" ? <LineChart data={data} margin={{ top: 15, right: 20, left: 0, bottom: 15 }}>{axis}<Line type="monotone" stroke={palette[0]} dataKey={chart.y} strokeWidth={2.5} dot={{ r: 3 }}/></LineChart> : <AreaChart data={data} margin={{ top: 15, right: 20, left: 0, bottom: 15 }}>{axis}<Area type="monotone" dataKey={chart.y} stroke={palette[0]} fill="#dceaf0" strokeWidth={2}/></AreaChart>}</ResponsiveContainer>;
  if (["bar", "horizontal_bar", "grouped_bar", "stacked_bar", "histogram", "lollipop"].includes(view)) {
    const horizontal = view === "horizontal_bar";
    const visibleData = data.slice(0, 24);
    const axisWidth = categoryAxisWidth(visibleData.map(row => String(row[chart.x] ?? "")));
    const fields = ["grouped_bar", "stacked_bar"].includes(view) ? chart.extra || [chart.y] : [view === "histogram" ? "count" : chart.y];
    const bars = fields.map((field, i) => <Bar key={field} dataKey={field} stackId={view === "stacked_bar" ? "stack" : undefined} fill={palette[i % palette.length]} radius={[3, 3, 0, 0]}/>);
    return <div className="qp-chart-wrap"><ScrollableChart minWidth={horizontal ? axisWidth + 340 : Math.max(560, Math.min(visibleData.length,24)*44)}><ResponsiveContainer width="100%" height={horizontal ? Math.max(260,visibleData.length*58) : 350}><BarChart data={visibleData} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 15, right: 22, left: 6, bottom: 25 }}><CartesianGrid stroke="#edf0f3" strokeDasharray="3 3"/>{horizontal ? <><XAxis type="number"/><YAxis width={axisWidth} type="category" dataKey={chart.x} interval={0} tickLine={false} tick={<CategoryTick width={axisWidth}/>} /></> : <><XAxis dataKey={view === "histogram" ? "bin" : chart.x} tick={{ fontSize: 10 }} angle={-34} height={85} textAnchor="end" interval={0}/><YAxis tick={{ fontSize: 10 }}/></>}<Tooltip/>{bars}</BarChart></ResponsiveContainer></ScrollableChart>{horizontal && <FullCategoryLabels labels={visibleData.map(row => String(row[chart.x] ?? ""))}/>} {data.length > 24 && <p className="qp-chart-caption">Chart shows the first 24 results; the supporting table contains the remaining values.</p>}</div>;
  }
  return <p className="figure-fallback-note">This figure needs the Matplotlib plotting service. The query values are available in the table below.</p>;
}

export default function SmartWorkspace({ tables, loading, onRefresh, projectName, projectRef, aiEnabled }: Props) {
  const [tab, setTab] = useState<"studio" | "analysis" | "datasets">("studio");
  const [selectedTable, setSelectedTable] = useState("all");
  const [scopeReady, setScopeReady] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [report, setReport] = useState<AnalysisResult | null>(null);
  const [clarification, setClarification] = useState<Clarification | null>(null);
  const [figures, setFigures] = useState<Figure[]>([]);
  const [plotStatus, setPlotStatus] = useState<"idle" | "loading" | "python" | "fallback">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);
  const chatBottom = useRef<HTMLDivElement>(null);

  function selectAnalysisTable(value: string) {
    if (value !== "all" && !tables.some(table => table.name === value)) return;
    setSelectedTable(value);
    window.sessionStorage.setItem("querypilot:selected-table:" + projectRef, value);
    setReport(null);
    setClarification(null);
    setFigures([]);
    setPlotStatus("idle");
    setError("");
  }

  useEffect(() => {
    if (loading) { setScopeReady(false); return; }
    const saved = window.sessionStorage.getItem("querypilot:selected-table:" + projectRef);
    const next = saved && (saved === "all" || tables.some(table => table.name === saved)) ? saved : tables[0]?.name || "all";
    setSelectedTable(next);
    setScopeReady(true);
  }, [loading, projectRef, tables]);

  useEffect(() => {
    if (!report?.charts.length) { setFigures([]); setPlotStatus("idle"); return; }
    const controller = new AbortController();
    setFigures([]);
    setPlotStatus("loading");
    fetch("/api/figures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: report.rows, charts: report.charts }),
      signal: controller.signal
    }).then(async response => {
      if (!response.ok) throw new Error("Plotting service unavailable");
      const data: { figures?: Figure[] } = await response.json();
      if (!data.figures?.length) throw new Error("No matching figures");
      setFigures(data.figures);
      setPlotStatus("python");
    }).catch(() => {
      if (!controller.signal.aborted) setPlotStatus("fallback");
    });
    return () => controller.abort();
  }, [report]);

  async function ask(text: string, silent = false, scopeOverride?: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    if (!silent) setMessages(current => [...current, { role: "user", text: prompt }]);
    setQuestion("");
    setBusy(true);
    setError("");
    setReport(null);
    setClarification(null);
    setTab("analysis");
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: prompt, table: scopeOverride || selectedTable }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Analysis failed.");
      const result = data as AnalysisResponse;
      if (result.type === "clarification") {
        setClarification(result);
        setMessages(current => [...current, { role: "assistant", text: "Choose a detail in the analysis workspace on the left." }]);
      } else {
        setReport(result);
        setMessages(current => [...current, { role: "assistant", text: "Analyzed " + result.tableName + ". " + result.interpretation }]);
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "Unable to complete the analysis.";
      setError(message);
      setMessages(current => [...current, { role: "assistant", text: "I couldn't complete that analysis. The error is shown in the workspace." }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => chatBottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  function selectOption(option: string) {
    if (!clarification || busy) return;
    if (clarification.kind === "table" && tables.some(table => table.name === option)) {
      const original = clarification.originalQuestion;
      selectAnalysisTable(option);
      void ask(original, true, option);
      return;
    }
    const index = clarification.options.indexOf(option);
    const selected = clarification.optionQueries?.[index] || clarification.originalQuestion + ". Clarification: " + option;
    void ask(selected, true);
  }

  function fallbackSvgs() {
    return Array.from(chartRef.current?.querySelectorAll("svg.recharts-surface") || []).map(item => item.outerHTML);
  }

  function download() {
    if (report) downloadHtml(report, figures, fallbackSvgs());
  }

  function print() {
    if (!report) return;
    try { printReport(report, figures, fallbackSvgs()); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Could not open the printable report."); }
  }

  return <div className={"smart-workspace intelligence-active qp-unified-shell" + (tab === "analysis" ? " qp-chat-mode" : "")}>
    <header className="canvas-top">
        <div className="canvas-heading"><h1>QueryPilot Studio</h1><p>{projectName}</p></div>
        <div className="canvas-controls">
          <div className="canvas-scope"><label htmlFor="analysis-scope">Analyze table</label><select id="analysis-scope" value={selectedTable} disabled={busy} onChange={event => selectAnalysisTable(event.target.value)}><option value="all">All tables</option>{tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}</select></div>
          <div className="canvas-tabs"><button type="button" className={tab === "studio" ? "selected" : ""} onClick={() => setTab("studio")}><BarChart3 size={15}/> Dashboard</button><button type="button" className={tab === "analysis" ? "selected" : ""} onClick={() => setTab("analysis")}><MessageSquare size={15}/> Ask AI</button><button type="button" className={tab === "datasets" ? "selected" : ""} onClick={() => setTab("datasets")}><Database size={15}/> Datasets</button></div>
        </div>
    </header>
    <div className="qp-studio-content">
      <main className="analysis-canvas">
      <div className="canvas-results qp-studio-host" style={{display:tab === "studio" ? "block":"none"}}>
        <IntelligenceStudio tables={tables} selectedTable={selectedTable} onSelectTable={selectAnalysisTable} projectRef={projectRef} projectName={projectName} ready={scopeReady && !loading}/>
      </div>
      {tab === "datasets" && <div className="canvas-datasets qp-unified-datasets">
        <DatasetsPanel tables={tables} loading={loading} onRefresh={onRefresh} selectedTable={selectedTable} onSelectTable={selectAnalysisTable} onOpenDashboard={() => setTab("studio")}/>
      </div>}
      {tab === "analysis" && <section className="canvas-results qp-chat-results" aria-label="AI analysis results">
        <header className="qp-chat-results-heading">
          <div className="qp-chat-heading-group">
            <span className="qp-chat-heading-eyebrow">ANALYSIS WORKSPACE</span>
            <div className="qp-chat-heading-row">
              <h2>Results</h2>
              <span className="qp-chat-source" title={selectedTable === "all" ? "All connected tables" : selectedTable}><Database size={14}/><span>{selectedTable === "all" ? "All connected tables" : selectedTable}</span></span>
            </div>
          </div>
        </header>
        {!busy && !report && !clarification && !error && <div className="qp-chat-empty">
          <div className="qp-chat-empty-content">
            <div className="qp-chat-empty-symbol"><BarChart3 size={26}/></div>
            <h3>Ready to analyze</h3>
            <p>Ask QueryPilot AI a question to explore insights from your selected data.</p>
            <div className="qp-chat-empty-highlights" aria-hidden="true"><span>Visual insights</span><span>Data tables</span><span>SQL evidence</span></div>
          </div>
        </div>}
        <div className="qp-chat-analysis-results">
        {error && <div className="analysis-error" role="alert">{error}</div>}
        {busy && <div className="work-status"><LoaderCircle className="spinning" size={25}/><div><strong>Analyzing the selected data</strong><p>Checking available columns and running a read-only query.</p></div></div>}
        {!busy && clarification && <div className="choice-card"><span className="choice-label">ONE MORE DETAIL</span><h2>{clarification.question}</h2><p>Choose the option that best matches your request.</p><div className="choice-list">{clarification.options.map(option => <button type="button" key={option} onClick={() => selectOption(option)}><span className="qp-choice-button-label">{option}</span><ArrowRight size={16} aria-hidden="true"/></button>)}</div></div>}
        {!busy && report && <div className="generated-report">
          <section className="answer-card">
            <div className="answer-top"><span className="report-eyebrow"><CheckCircle2 size={14}/> ANALYSIS COMPLETE</span><div className="export-actions"><button onClick={download} type="button" disabled={plotStatus === "loading"}><Download size={15}/> HTML</button><button onClick={print} type="button" disabled={plotStatus === "loading"}><FileDown size={15}/> PDF</button></div></div>
            <h2>{report.title}</h2><p className="report-dataset-source">Dataset: <strong>{report.tableName}</strong></p>
            {report.leadValue !== "—" && <div className="answer-metric"><strong>{report.leadValue}</strong><span>{report.leadLabel}</span></div>}
            <p className="answer-interpretation">{report.interpretation}</p>
          </section>
          {report.charts.length > 0 && <section className="report-section"><div className="report-section-head"><h3>Figures</h3><span>{plotStatus === "python" ? "Matplotlib & Seaborn" : plotStatus === "loading" ? "Generating figures" : "Data visualizations"}</span></div><div className="report-figures" ref={chartRef}>{report.charts.map((chart, index) => {
            const image = figures.find(item => item.type === chart.type && item.title === chart.title);
            return <article className="figure-card" key={chart.type + index}><h4>{chart.title}</h4>{plotStatus === "loading" ? <div className="figure-loading"><LoaderCircle className="spinning" size={22}/> Building the figure</div> : image && plotStatus === "python" ? <img src={image.image} alt={image.title}/> : <ChartPreview report={report} chart={chart}/>}</article>;
          })}</div></section>}
          <section className="report-section"><div className="report-section-head"><h3>Supporting data</h3><span>{new Date(report.createdAt).toLocaleString()}</span></div>{report.columns.length ? <div className="report-table-scroll"><table><thead><tr>{report.columns.map(column => <th key={column.name}>{column.name.replace(/_/g, " ")}</th>)}</tr></thead><tbody>{report.rows.map((row, i) => <tr key={i}>{report.columns.map(column => <td key={column.name}>{asText(row[column.name])}</td>)}</tr>)}</tbody></table></div> : <p className="report-subtext">No matching data.</p>}{report.truncated && <p className="report-subtext">Preview limited to the first 100 returned records.</p>}</section>
          <details className="sql-details"><summary>Executed read-only SQL</summary><pre>{report.sql}</pre></details>
        </div>}

      </div>
      </section>}
    </main>
    {tab === "analysis" && <aside className="ai-chat qp-chat-sidebar" aria-label="Ask AI chat panel"><header className="ai-chat-top"><div className="ai-avatar"><MessageSquare size={19}/></div><div><h2>QueryPilot AI</h2><p>Ask about your connected data</p></div><span className="qp-chat-presence" title="Chat available"/></header>
      <div className="ai-chat-history"><div className="chat-greeting"><div className="chat-greeting-icon"><BarChart3 size={19}/></div><h3>What would you like to know?</h3><p>Use the chat to explore your selected table. Results appear in the workspace.</p></div>{messages.map((message, i) => <div className={"chat-message " + message.role} key={i}><span>{message.text}</span></div>)}{busy && <div className="chat-loading"><LoaderCircle className="spinning" size={15}/> Checking your data...</div>}<div ref={chatBottom}/></div>
      <form className="ai-chat-form qp-chat-composer" onSubmit={event => { event.preventDefault(); void ask(question); }}>
        <div className="qp-chat-composer-box">
          <textarea aria-label="Ask QueryPilot AI a question" value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }} placeholder="Ask a question about your data..." rows={3} maxLength={900}/>
          <span className="qp-chat-composer-status"><ShieldCheck size={13}/> Read-only analysis</span>
          <button className="qp-chat-send-button" type="submit" disabled={busy || !question.trim()} aria-label="Send message"><Send size={17}/></button>
        </div>
        <p className="qp-chat-composer-hint">Enter to send · Shift + Enter for a new line</p>
      </form>
    </aside>}
    </div>
  </div>;
}
