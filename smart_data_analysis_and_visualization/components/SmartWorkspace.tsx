"use client";

import { useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, BarChart3, CheckCircle2, Database, Download, FileDown, FileText, LoaderCircle, MessageSquare, RefreshCw, Send, ShieldCheck, Table2 } from "lucide-react";
import DatasetsPanel, { type Table } from "./DatasetsPanel";
import { downloadHtml, printReport } from "../lib/export";
import type { AnalysisResponse, AnalysisResult, Clarification } from "../lib/types";

type Props = { tables: Table[]; loading: boolean; onRefresh: () => void; projectName: string; aiEnabled: boolean };
type Message = { role: "user" | "assistant"; text: string };
const colors = ["#26394d", "#577c9d", "#99bacd", "#ccd8e1", "#879aab", "#b6c6d3"];

function asText(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChartView({ report }: { report: AnalysisResult }) {
  const chart = report.chart;
  if (chart.type === "none") return null;
  const data = report.rows.map(row => ({ ...row, [chart.y]: Number(row[chart.y]), ...(chart.type === "scatter" ? { [chart.x]: Number(row[chart.x]) } : {}) }));
  if (!data.length) return null;
  if (chart.type === "pie") return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart><Tooltip/><Pie data={data} dataKey={chart.y} nameKey={chart.x} cx="50%" cy="50%" outerRadius={94} label>
        {data.map((_, index) => <Cell key={index} fill={colors[index % colors.length]}/>)}
      </Pie><Legend/></PieChart>
    </ResponsiveContainer>
  );
  if (chart.type === "scatter") return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ left: 4, right: 16, top: 12, bottom: 12 }}><CartesianGrid stroke="#eef0f3"/><XAxis dataKey={chart.x} type="number" name={chart.x}/><YAxis dataKey={chart.y} type="number" name={chart.y}/><Tooltip cursor={{ strokeDasharray: "3 3" }}/><Scatter data={data} fill={colors[1]}/></ScatterChart>
    </ResponsiveContainer>
  );
  const axis = <><CartesianGrid stroke="#eef0f3" strokeDasharray="3 3"/><XAxis dataKey={chart.x} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={14}/><YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={52}/><Tooltip/></>;
  if (chart.type === "line") return (
    <ResponsiveContainer width="100%" height={280}><LineChart data={data} margin={{ left: 4, right: 16, top: 12, bottom: 14 }}>{axis}<Line type="monotone" dataKey={chart.y} stroke={colors[1]} strokeWidth={2.5} dot={{ r: 3 }}/></LineChart></ResponsiveContainer>
  );
  if (chart.type === "area") return (
    <ResponsiveContainer width="100%" height={280}><AreaChart data={data} margin={{ left: 4, right: 16, top: 12, bottom: 14 }}>{axis}<Area type="monotone" dataKey={chart.y} fill="#d7e3ea" stroke={colors[1]} strokeWidth={2}/></AreaChart></ResponsiveContainer>
  );
  return (
    <ResponsiveContainer width="100%" height={280}><BarChart data={data} margin={{ left: 4, right: 16, top: 12, bottom: 14 }}>{axis}<Bar dataKey={chart.y} fill={colors[1]} radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer>
  );
}

export default function SmartWorkspace({ tables, loading, onRefresh, projectName, aiEnabled }: Props) {
  const [tab, setTab] = useState<"analysis" | "datasets">("analysis");
  const [selectedTable, setSelectedTable] = useState("all");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [report, setReport] = useState<AnalysisResult | null>(null);
  const [clarification, setClarification] = useState<Clarification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);
  const chatBottom = useRef<HTMLDivElement>(null);

  async function ask(text: string, silent = false) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    if (!silent) setMessages(current => [...current, { role: "user", text: prompt }]);
    setQuestion("");
    setBusy(true);
    setError("");
    setClarification(null);
    setTab("analysis");
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: prompt, table: selectedTable }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Analysis failed.");
      const result = data as AnalysisResponse;
      if (result.type === "clarification") {
        setReport(null);
        setClarification(result);
        setMessages(current => [...current, { role: "assistant", text: "Please choose an option in the left workspace." }]);
      } else {
        setReport(result);
        setMessages(current => [...current, { role: "assistant", text: "Your report is ready on the left. I found " + result.rows.length + (result.truncated ? "+" : "") + " matching result rows." }]);
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "Unable to complete the analysis.";
      setError(message);
      setMessages(current => [...current, { role: "assistant", text: "I couldn't complete the report. Please check the error shown on the left." }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => chatBottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  function selectOption(option: string) {
    if (!clarification || busy) return;
    void ask(clarification.originalQuestion + ". My clarification: " + option, true);
  }

  function chartSvg() {
    return chartRef.current?.querySelector("svg.recharts-surface")?.outerHTML || "";
  }

  function download() {
    if (!report) return;
    downloadHtml(report, chartSvg());
  }

  function print() {
    if (!report) return;
    try { printReport(report, chartSvg()); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to open printable report."); }
  }

  return (
    <div className="smart-workspace">
      <main className="analysis-canvas">
        <header className="canvas-top">
          <div><div className="canvas-kicker">SMART DATA ANALYSIS & VISUALIZATION</div><h1>Analysis workspace</h1><p>Connected to {projectName}</p></div>
          <div className="canvas-tabs"><button type="button" className={tab === "analysis" ? "selected" : ""} onClick={() => setTab("analysis")}><BarChart3 size={15}/> Analysis</button><button type="button" className={tab === "datasets" ? "selected" : ""} onClick={() => setTab("datasets")}><Database size={15}/> Datasets</button></div>
        </header>

        {tab === "datasets" ? <div className="canvas-datasets"><DatasetsPanel tables={tables} loading={loading} onRefresh={onRefresh}/></div> : (
          <div className="canvas-results">
            <div className="scope-control"><label htmlFor="analysis-scope">Analyze table</label><select id="analysis-scope" value={selectedTable} disabled={busy} onChange={event => { setSelectedTable(event.target.value); setReport(null); setClarification(null); setError(""); }}><option value="all">All available tables</option>{tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}</select><span><ShieldCheck size={14}/> Read only</span></div>

            {error && <div className="analysis-error" role="alert">{error}</div>}
            {busy && <div className="work-status"><LoaderCircle className="spinning" size={25}/><div><strong>Preparing your report</strong><p>Checking the schema, planning SQL, and reading authorized data.</p></div></div>}

            {!busy && clarification && <div className="choice-card"><span className="choice-label">ONE MORE DETAIL</span><h2>{clarification.question}</h2><p>Select the interpretation you want. The choices stay here, outside the chatbox.</p><div className="choice-list">{clarification.options.map(option => <button type="button" key={option} onClick={() => selectOption(option)}>{option}<ArrowRight size={16}/></button>)}</div></div>}

            {!busy && !clarification && !report && <div className="analysis-placeholder"><div className="placeholder-icon"><BarChart3 size={29}/></div><h2>Ask a question about your data</h2><p>Your analysis, tables and report will appear here. Use the chatbox on the right to ask a question.</p><div className="placeholder-pills"><span><Database size={14}/> {tables.length} connected tables</span><span><FileText size={14}/> HTML & PDF reports</span></div>{!aiEnabled && <div className="ai-setup">Add <strong>GROQ_API_KEY</strong> in Vercel to enable AI analysis.</div>}</div>}

            {!busy && report && <div className="generated-report">
              <div className="report-heading"><div><span className="report-eyebrow"><CheckCircle2 size={14}/> REPORT GENERATED</span><h2>{report.title}</h2><p>{report.summary}</p></div><div className="export-actions"><button type="button" onClick={download}><Download size={15}/> HTML</button><button type="button" onClick={print}><FileDown size={15}/> PDF</button></div></div>
              <div className="report-section"><div className="report-section-head"><h3>Key findings</h3><span>{new Date(report.createdAt).toLocaleString()}</span></div>{report.findings.length ? <ul className="report-findings">{report.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul> : <p className="report-subtext">No numerical findings were identified from this result.</p>}</div>
              {report.chart.type !== "none" && <div className="report-section"><div className="report-section-head"><h3>Visualization</h3><span>{report.chart.y.replace(/_/g, " ")} by {report.chart.x.replace(/_/g, " ")}</span></div><div className="analysis-chart" ref={chartRef}><ChartView report={report}/></div></div>}
              <div className="report-section"><div className="report-section-head"><h3>Query results</h3><span>{report.rows.length}{report.truncated ? "+" : ""} rows</span></div><div className="report-table-scroll"><table><thead><tr>{report.columns.map(column => <th key={column.name}>{column.name.replace(/_/g, " ")}</th>)}</tr></thead><tbody>{report.rows.map((row, i) => <tr key={i}>{report.columns.map(column => <td key={column.name}>{asText(row[column.name])}</td>)}</tr>)}</tbody></table>{!report.rows.length && <p className="report-subtext">No matching records were returned.</p>}</div></div>
              <details className="sql-details"><summary>View executed SQL</summary><pre>{report.sql}</pre></details><p className="report-notice">Results are read-only. Verify the data and interpretation before making decisions.</p>
            </div>}
          </div>
        )}
      </main>

      <aside className="ai-chat"><header className="ai-chat-top"><div className="ai-avatar"><MessageSquare size={19}/></div><div><h2>QueryPilot AI</h2><p>Ask questions about your connected data</p></div><span className="ai-online"/></header>
        <div className="ai-chat-history"><div className="chat-greeting"><div className="chat-greeting-icon"><BarChart3 size={19}/></div><h3>What would you like to know?</h3><p>Ask about counts, comparisons, patterns, charts or reports. Results appear in the analysis workspace.</p></div>
          {messages.map((message, index) => <div className={"chat-message " + message.role} key={index}><span>{message.text}</span></div>)}
          {busy && <div className="chat-loading"><LoaderCircle className="spinning" size={15}/> Analyzing your question...</div>}
          <div ref={chatBottom}/>
        </div>
        <form className="ai-chat-form" onSubmit={event => { event.preventDefault(); void ask(question); }}><textarea value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }} placeholder="Ask a question about your data..." rows={3} maxLength={900}/><div className="ai-chat-form-bottom"><small>Enter to send · Shift + Enter for a new line</small><button type="submit" disabled={busy || !question.trim()} aria-label="Send message"><Send size={17}/></button></div></form>
      </aside>
    </div>
  );
}
