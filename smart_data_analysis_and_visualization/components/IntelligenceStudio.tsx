"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, BarChart3, BrainCircuit, CheckCircle2, ChevronRight, Circle, ClipboardList, Database, FileCode2, Layers, LayoutDashboard, LoaderCircle, Play, ShieldCheck, Sparkles, Square, WandSparkles } from "lucide-react";
import DashboardBuilder from "./DashboardBuilder";
import type { DataResponse, GroupPoint, InvestigationBundle, InvestigationPlan, InvestigationStage, OverviewData, QualityData, TrendPoint } from "../lib/intelligence";

type Table = { name: string; columns: string[] };
type Props = { tables: Table[]; selectedTable: string; onSelectTable: (table: string) => void; projectRef: string; projectName: string };
type Status = "pending" | "running" | "done" | "skipped" | "failed";
type StageStatus = Record<InvestigationStage, Status>;
const stages: { stage: InvestigationStage; label: string; description: string }[] = [
  { stage: "plan", label: "Investigation plan", description: "Understand the schema and select verified metrics" },
  { stage: "profile", label: "Data quality", description: "Inspect missing values in a bounded sample" },
  { stage: "overview", label: "Metric calculation", description: "Compute factual database aggregates" },
  { stage: "drivers", label: "Segment investigation", description: "Compare ranked category contributions" },
  { stage: "trend", label: "Temporal analysis", description: "Explore real monthly observations" }
];
const initialProgress = (): StageStatus => ({ plan:"pending", profile:"pending", overview:"pending", drivers:"pending", trend:"pending" });
const numeric = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" :
  new Intl.NumberFormat("en-US", {maximumFractionDigits:2}).format(value);
const fieldLabel = (value: string | null) => value ? value.replace(/_/g, " ") : "Record count";

async function requestStage<T>(
  stage: InvestigationStage,
  table: string,
  goal: string,
  plan?: InvestigationPlan,
  filterValue?: string,
  signal?: AbortSignal
): Promise<DataResponse<T>> {
  const response = await fetch("/api/smart-investigation", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({stage, table, goal, metric:plan?.metric, dimension:plan?.dimension, time:plan?.time, filterValue}),
    signal
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const reason = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The analysis request failed.";
    throw new Error(reason);
  }
  return data as DataResponse<T>;
}

export default function IntelligenceStudio({ tables, selectedTable, onSelectTable, projectRef, projectName }: Props) {
  const selected = selectedTable !== "all" ? selectedTable : tables[0]?.name || "";
  const [view, setView] = useState<"investigation" | "dashboard">("investigation");
  const [goal, setGoal] = useState("Discover the most important patterns and compare meaningful groups in this dataset");
  const [bundle, setBundle] = useState<InvestigationBundle | null>(null);
  const [progress, setProgress] = useState<StageStatus>(initialProgress);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [stageErrors, setStageErrors] = useState<string[]>([]);
  const [activeStep, setActiveStep] = useState<InvestigationStage | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [filtered, setFiltered] = useState<{overview:OverviewData;drivers:GroupPoint[];trend:TrendPoint[]} | null>(null);
  const [filterBusy, setFilterBusy] = useState(false);
  const [filterError, setFilterError] = useState("");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    setBundle(null);
    setProgress(initialProgress());
    setRunning(false);
    setError("");
    setSelectedGroup(null);
    setFiltered(null);
    setFilterError("");
    return () => controller.current?.abort();
  }, [projectRef, selected]);

  async function runInvestigation(destination: "investigation" | "dashboard") {
    if (!selected || running) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setView(destination);
    setProgress(initialProgress());
    setError("");
    setStageErrors([]);
    setBundle(null);
    setSelectedGroup(null);
    setFiltered(null);
    const mark = (stage: InvestigationStage, status: Status) => setProgress(current => ({...current,[stage]:status}));
    let next: InvestigationBundle;
    try {
      setActiveStep("plan");
      mark("plan", "running");
      const planned = await requestStage<InvestigationPlan>("plan", selected, goal, undefined, undefined, abort.signal);
      if (abort.signal.aborted) return;
      next = {plan:planned.data, evidence:[], goal};
      setBundle(next);
      mark("plan", "done");
      const order = ["profile","overview","drivers","trend"] as const;
      for (const stage of order) {
        if (abort.signal.aborted) return;
        if (stage === "drivers" && !next.plan.dimension || stage === "trend" && !next.plan.time) {
          mark(stage, "skipped");
          continue;
        }
        setActiveStep(stage);
        mark(stage, "running");
        try {
          const result = await requestStage<QualityData | OverviewData | GroupPoint[] | TrendPoint[]>(stage, selected, goal, next.plan, undefined, abort.signal);
          if (abort.signal.aborted) return;
          const evidence = result.sql ? [...next.evidence, {stage, sql:result.sql, completedAt:result.completedAt}] : next.evidence;
          if (stage === "profile") next = {...next, quality:result.data as QualityData, evidence};
          if (stage === "overview") next = {...next, overview:result.data as OverviewData, evidence};
          if (stage === "drivers") next = {...next, drivers:result.data as GroupPoint[], evidence};
          if (stage === "trend") next = {...next, trend:result.data as TrendPoint[], evidence};
          setBundle(next);
          mark(stage,"done");
        } catch (problem) {
          if (abort.signal.aborted) return;
          mark(stage,"failed");
          setStageErrors(items => [...items, stage + ": " + (problem instanceof Error ? problem.message : "Analysis unavailable")]);
        }
      }
      if (!abort.signal.aborted && !next.overview) setError("Metric aggregation did not complete. Review the Supabase project permissions and retry.");
    } catch (problem) {
      if (!abort.signal.aborted) {
        mark("plan", "failed");
        setError(problem instanceof Error ? problem.message : "Unable to create a verified investigation plan.");
      }
    } finally {
      if (!abort.signal.aborted) {
        setActiveStep(null);
        setRunning(false);
      }
    }
  }

  useEffect(() => {
    if (!bundle?.overview || view !== "dashboard") return;
    if (!selectedGroup) {
      setFiltered({overview:bundle.overview, drivers:bundle.drivers || [], trend:bundle.trend || []});
      setFilterBusy(false);
      setFilterError("");
      return;
    }
    const abort = new AbortController();
    setFilterBusy(true);
    setFilterError("");
    Promise.all([
      requestStage<OverviewData>("overview", bundle.plan.table, bundle.goal, bundle.plan, selectedGroup, abort.signal),
      requestStage<GroupPoint[]>("drivers", bundle.plan.table, bundle.goal, bundle.plan, selectedGroup, abort.signal),
      bundle.plan.time
        ? requestStage<TrendPoint[]>("trend", bundle.plan.table, bundle.goal, bundle.plan, selectedGroup, abort.signal)
        : Promise.resolve(null)
    ]).then(([overview, drivers, trend]) => {
      if (abort.signal.aborted) return;
      setFiltered({overview:overview.data, drivers:drivers.data, trend:trend ? trend.data : []});
    }).catch(problem => {
      if (!abort.signal.aborted) {
        setFilterError((problem instanceof Error ? problem.message : "Could not apply the segment filter.") + " Showing the last successful result.");
      }
    }).finally(() => {if (!abort.signal.aborted) setFilterBusy(false);});
    return () => abort.abort();
  }, [bundle, view, selectedGroup]);

  function insights(result: InvestigationBundle) {
    const findings: string[] = [];
    const metric = fieldLabel(result.plan.metric);
    if (result.overview) findings.push(
      result.plan.metric
        ? "Observed " + numeric(result.overview.total) + " total " + metric + " across " + numeric(result.overview.records) + " records."
        : "The selected dataset contains " + numeric(result.overview.records) + " records."
    );
    if (result.drivers?.length) {
      const first = result.drivers[0];
      findings.push("Largest displayed " + fieldLabel(result.plan.dimension) + " group: " + first.label + " (" + numeric(first.value) + " " + metric + ").");
    }
    if (result.trend && result.trend.length > 1) {
      const previous = result.trend[result.trend.length-2];
      const latest = result.trend[result.trend.length-1];
      const difference = latest.value - previous.value;
      findings.push("From " + previous.period + " to " + latest.period + ", " + metric + " " + (difference > 0 ? "increased by " : difference < 0 ? "decreased by " : "changed by ") + numeric(Math.abs(difference)) + ".");
    }
    if (result.quality?.fields.length) {
      const mostMissing = [...result.quality.fields].sort((a,b)=>b.missingPercent-a.missingPercent)[0];
      findings.push("In a sample of " + numeric(result.quality.sampledRecords) + " rows, " + mostMissing.column + " has " + mostMissing.missingPercent + "% missing values.");
    }
    return findings;
  }

  const ready = Boolean(bundle?.overview);
  return <div className="qp-intelligence">
    <div className="qp-studio-banner">
      <div>
        <div className="qp-eyebrow"><Sparkles size={15}/> QUERYPILOT · AI INTELLIGENCE STUDIO</div>
        <h2>Discover the story behind your data.</h2>
        <p>Autonomous, auditable investigations and interactive decision dashboards—grounded in your connected Supabase data.</p>
      </div>
      <div className="qp-studio-switch" role="tablist" aria-label="Intelligence features">
        <button role="tab" aria-selected={view==="investigation"} className={view==="investigation"?"active":""} onClick={() => setView("investigation")}><BrainCircuit size={17}/> Investigation</button>
        <button role="tab" aria-selected={view==="dashboard"} className={view==="dashboard"?"active":""} onClick={() => setView("dashboard")}><LayoutDashboard size={17}/> Dashboard builder</button>
      </div>
    </div>

    <div className="qp-studio-setup">
      <label>Connected dataset
        <select value={selected} onChange={event=>onSelectTable(event.target.value)} disabled={running}>
          {!tables.length && <option value="">No tables connected</option>}
          {tables.map(table=><option key={table.name} value={table.name}>{table.name}</option>)}
        </select>
      </label>
      <label className="qp-goal-field">Investigation goal
        <input maxLength={300} value={goal} onChange={event=>setGoal(event.target.value)} placeholder="What should the system investigate?" disabled={running}/>
      </label>
      {running
        ? <button type="button" className="qp-run-button secondary" onClick={() => {controller.current?.abort();setRunning(false);setActiveStep(null);setProgress(current => Object.fromEntries(Object.entries(current).map(([key,value]) => [key, value === "running" ? "skipped" : value])) as StageStatus);setError("Investigation stopped by user.");}}><Square size={15}/> Stop</button>
        : <button type="button" className="qp-run-button" disabled={!selected} onClick={() => void runInvestigation(view)}><Play size={16}/> {bundle ? "Run again" : view==="dashboard" ? "Generate dashboard" : "Start investigation"}</button>}
    </div>

    {view==="investigation" && <div className="qp-investigation-view">
      <div className="qp-investigation-summary">
        <div className="qp-summary-lead">
          <div className="qp-summary-icon"><WandSparkles size={24}/></div>
          <div><strong>Autonomous investigation engine</strong><p>Five transparent stages. One click. Every computation runs against real data using validated, read-only queries.</p></div>
        </div>
        <div className="qp-summary-features"><span><ShieldCheck size={14}/> Read-only SQL</span><span><FileCode2 size={14}/> Traceable evidence</span><span><Layers size={14}/> Dataset-adaptive</span></div>
      </div>
      <div className="qp-investigation-layout">
        <section className="qp-workflow-card">
          <div className="qp-section-heading"><span>INVESTIGATION WORKFLOW</span><small>{running ? "IN PROGRESS" : bundle ? "RESULTS AVAILABLE" : "READY TO RUN"}</small></div>
          <div className="qp-step-list">
            {stages.map((item,index) => <div key={item.stage} className={"qp-step "+progress[item.stage]}>
              <div className="qp-step-icon">{progress[item.stage]==="done"?<CheckCircle2 size={19}/>:progress[item.stage]==="running"?<LoaderCircle size={19} className="spinning"/>:<span>{index+1}</span>}</div>
              <div><strong>{item.label}</strong><p>{item.description}</p></div>
              <small>{progress[item.stage]==="done"?"Complete":progress[item.stage]==="running"?"Running":progress[item.stage]==="skipped"?"Not applicable":progress[item.stage]==="failed"?"Failed":"Queued"}</small>
            </div>)}
          </div>
          {bundle && <div className="qp-plan-meta"><BrainCircuit size={17}/><span>{bundle.plan.planner} plan</span><strong>{bundle.plan.table}</strong></div>}
        </section>
        <section className="qp-findings-card">
          <div className="qp-section-heading"><span>VERIFIED FINDINGS</span><Activity size={17}/></div>
          {!bundle && !running && <div className="qp-empty-stage"><BrainCircuit size={38}/><h3>Ready to investigate</h3><p>Choose a dataset and start an autonomous investigation. Results are never fabricated.</p></div>}
          {!bundle && running && <div className="qp-empty-stage"><LoaderCircle size={33} className="spinning"/><h3>Reading dataset schema</h3><p>Preparing a safe investigation plan.</p></div>}
          {bundle && <div className="qp-findings-body">
            <div className="qp-field-chips"><span>Metric: <b>{fieldLabel(bundle.plan.metric)}</b></span><span>Group: <b>{fieldLabel(bundle.plan.dimension)}</b></span><span>Time: <b>{fieldLabel(bundle.plan.time)}</b></span></div>
            <p className="qp-plan-rationale">{bundle.plan.rationale}</p>
            {bundle.overview && <div className="qp-mini-metrics">
              <div><small>RECORDS</small><strong>{numeric(bundle.overview.records)}</strong></div>
              <div><small>{bundle.plan.metric?"METRIC TOTAL":"ROWS"}</small><strong>{numeric(bundle.plan.metric?bundle.overview.total:bundle.overview.records)}</strong></div>
            </div>}
            {insights(bundle).map((finding,index)=><div className="qp-insight-line" key={index}><CheckCircle2 size={17}/><p>{finding}</p></div>)}
            {running && <div className="qp-running-note"><LoaderCircle size={16} className="spinning"/> Working on {activeStep?.replace(/_/g," ")}…</div>}
            {ready && <button type="button" className="qp-build-link" onClick={()=>setView("dashboard")}><LayoutDashboard size={17}/> Turn findings into an interactive dashboard <ChevronRight size={17}/></button>}
          </div>}
        </section>
      </div>
      {bundle?.quality && <section className="qp-quality-card">
        <div className="qp-section-heading"><span>DATA QUALITY SNAPSHOT</span><small>UP TO {bundle.quality.sampleLimit.toLocaleString()} SAMPLED ROWS</small></div>
        <div className="qp-quality-grid">
          {bundle.quality.fields.length ? bundle.quality.fields.map(field=><div key={field.column} className="qp-quality-item"><div><strong>{field.column}</strong><span>{field.missingPercent}% missing</span></div><div className="qp-quality-track"><i style={{width:Math.min(100,field.missingPercent)+"%"}}/></div></div>) : <p>No selected analysis fields. The dataset can still be counted.</p>}
        </div>
      </section>}
      {bundle?.evidence.length ? <section className="qp-evidence-card"><div className="qp-section-heading"><span><ClipboardList size={15}/> COMPUTATIONAL EVIDENCE</span><small>{bundle.evidence.length} QUERIES</small></div>
        {bundle.evidence.map((item,index)=><details className="qp-evidence-entry" key={item.stage+index}><summary><FileCode2 size={16}/>{item.stage.toUpperCase()}<span>{new Date(item.completedAt).toLocaleTimeString()}</span><ChevronRight size={15}/></summary><pre>{item.sql}</pre></details>)}
      </section>:null}
      {stageErrors.length>0 && <div className="qp-alert" role="status">{stageErrors.join(" · ")}</div>}
    </div>}

    {view==="dashboard" && (bundle && ready && filtered && !running
      ? <DashboardBuilder key={projectRef+":"+bundle.plan.table} bundle={bundle} projectRef={projectRef} overview={filtered.overview} drivers={filtered.drivers} trend={filtered.trend} selectedGroup={selectedGroup} onSelectGroup={setSelectedGroup} filterBusy={filterBusy} filterError={filterError}/>
      : <div className="qp-dashboard-empty">
          <LayoutDashboard size={43}/>
          <h3>{running ? "Building your interactive dashboard…" : "Build a dashboard from your actual data"}</h3>
          <p>{running ? "Gathering metrics, category comparisons, and available time trends." : "Select a dataset above and click Generate dashboard. KPI cards and charts are created only when the selected dataset supports them."}</p>
          {!running && bundle?.overview && <button onClick={()=>setFiltered({overview:bundle.overview!,drivers:bundle.drivers||[],trend:bundle.trend||[]})}>Open dashboard <ArrowRight size={15}/></button>}
        </div>
    )}

    {error && <div className="qp-alert" role="alert">{error}</div>}
    <div className="qp-studio-footer"><Database size={13}/> {projectName} <Circle size={5} fill="currentColor"/> Only authorized Supabase data is queried <Circle size={5} fill="currentColor"/> Findings are descriptive, not causal.</div>
  </div>;
}
