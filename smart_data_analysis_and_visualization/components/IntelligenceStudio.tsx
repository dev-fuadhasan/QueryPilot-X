"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, CheckCircle2, LayoutDashboard, LoaderCircle, Play, RotateCcw, Sparkles, XCircle } from "lucide-react";
import DashboardBuilder from "./DashboardBuilder";
import type { DataResponse, GroupPoint, InvestigationBundle, InvestigationPlan, InvestigationStage, OverviewData, QualityData, TrendPoint } from "../lib/intelligence";

type Table={name:string;columns:string[]};
type Props={tables:Table[];selectedTable:string;onSelectTable:(value:string)=>void;projectRef:string;projectName:string};
type Status="pending"|"running"|"done"|"skipped"|"failed";
type Progress=Record<InvestigationStage,Status>;
const initial=():Progress=>({plan:"pending",profile:"pending",overview:"pending",drivers:"pending",trend:"pending"});
const steps:{key:InvestigationStage;label:string;detail:string}[]=[
  {key:"plan",label:"Understanding your data",detail:"Reading columns and selecting valid fields"},
  {key:"profile",label:"Checking dataset quality",detail:"Inspecting rows and missing values"},
  {key:"overview",label:"Calculating key metrics",detail:"Computing real database aggregates"},
  {key:"drivers",label:"Finding category patterns",detail:"Comparing meaningful groups"},
  {key:"trend",label:"Exploring time trends",detail:"Analyzing available dated records"}
];
async function requestStage<T>(stage:InvestigationStage,table:string,goal:string,plan?:InvestigationPlan,filterValue?:string,signal?:AbortSignal):Promise<DataResponse<T>>{
  const response=await fetch("/api/smart-investigation",{
    method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({stage,table,goal,metric:plan?.metric,dimension:plan?.dimension,time:plan?.time,filterValue}),
    signal
  });
  const data:unknown=await response.json();
  if(!response.ok){
    const detail=data && typeof data==="object" && "error" in data && typeof data.error==="string" ? data.error : "Database analysis failed.";
    throw new Error(detail);
  }
  return data as DataResponse<T>;
}
export default function IntelligenceStudio({tables,selectedTable,projectRef,projectName}:Props){
  const selected=selectedTable!=="all" ? selectedTable : tables[0]?.name||"";
  const [focus,setFocus]=useState("");
  const [bundle,setBundle]=useState<InvestigationBundle|null>(null);
  const [progress,setProgress]=useState<Progress>(initial);
  const [running,setRunning]=useState(false);
  const [error,setError]=useState("");
  const [warnings,setWarnings]=useState<string[]>([]);
  const [selectedGroup,setSelectedGroup]=useState<string|null>(null);
  const [filtered,setFiltered]=useState<{overview:OverviewData;drivers:GroupPoint[];trend:TrendPoint[]}|null>(null);
  const [filterBusy,setFilterBusy]=useState(false);
  const [filterError,setFilterError]=useState("");
  const controller=useRef<AbortController|null>(null);
  const lastAutoRun=useRef("");

  async function buildDashboard(){
    if(!selected) return;
    controller.current?.abort();
    const abort=new AbortController();
    controller.current=abort;
    setRunning(true);
    setProgress(initial());
    setError("");
    setWarnings([]);
    setBundle(null);
    setFiltered(null);
    setSelectedGroup(null);
    const mark=(key:InvestigationStage,status:Status)=>setProgress(current=>({...current,[key]:status}));
    const goal=focus.trim()||"Identify useful KPIs, category comparisons and observed time trends";
    try{
      mark("plan","running");
      const planned=await requestStage<InvestigationPlan>("plan",selected,goal,undefined,undefined,abort.signal);
      if(abort.signal.aborted)return;
      mark("plan","done");
      let next:InvestigationBundle={plan:planned.data,goal,evidence:[]};
      for(const stage of ["profile","overview","drivers","trend"] as const){
        if(abort.signal.aborted)return;
        if(stage==="drivers"&&!next.plan.dimension||stage==="trend"&&!next.plan.time){mark(stage,"skipped");continue;}
        mark(stage,"running");
        try{
          const result=await requestStage<QualityData|OverviewData|GroupPoint[]|TrendPoint[]>(stage,selected,goal,next.plan,undefined,abort.signal);
          if(abort.signal.aborted)return;
          if(stage==="profile")next={...next,quality:result.data as QualityData};
          if(stage==="overview")next={...next,overview:result.data as OverviewData};
          if(stage==="drivers")next={...next,drivers:result.data as GroupPoint[]};
          if(stage==="trend")next={...next,trend:result.data as TrendPoint[]};
          mark(stage,"done");
        }catch(problem){
          if(abort.signal.aborted)return;
          mark(stage,"failed");
          setWarnings(items=>[...items,stage+": "+(problem instanceof Error ? problem.message : "Unavailable")]);
        }
      }
      if(abort.signal.aborted)return;
      if(!next.overview)throw new Error("Unable to calculate dataset metrics. Check the selected table's access permissions.");
      setBundle(next);
      setFiltered({overview:next.overview,drivers:next.drivers||[],trend:next.trend||[]});
    }catch(problem){
      if(!abort.signal.aborted)setError(problem instanceof Error ? problem.message : "Dashboard generation failed.");
    }finally{
      if(!abort.signal.aborted)setRunning(false);
    }
  }

  useEffect(()=>{
    if(!selected)return;
    const key=projectRef+":"+selected;
    const timer=window.setTimeout(()=>{
      if(lastAutoRun.current!==key){
        lastAutoRun.current=key;
        void buildDashboard();
      }
    },0);
    return ()=>window.clearTimeout(timer);
  },[projectRef,selected]);

  useEffect(()=>()=>controller.current?.abort(),[]);

  useEffect(()=>{
    if(!bundle?.overview)return;
    if(!selectedGroup){
      setFiltered({overview:bundle.overview,drivers:bundle.drivers||[],trend:bundle.trend||[]});
      setFilterError("");
      setFilterBusy(false);
      return;
    }
    const abort=new AbortController();
    setFilterBusy(true);
    setFilterError("");
    Promise.all([
      requestStage<OverviewData>("overview",bundle.plan.table,bundle.goal,bundle.plan,selectedGroup,abort.signal),
      requestStage<GroupPoint[]>("drivers",bundle.plan.table,bundle.goal,bundle.plan,selectedGroup,abort.signal),
      bundle.plan.time ? requestStage<TrendPoint[]>("trend",bundle.plan.table,bundle.goal,bundle.plan,selectedGroup,abort.signal):Promise.resolve(null)
    ]).then(([overview,drivers,trend])=>{
      if(!abort.signal.aborted)setFiltered({overview:overview.data,drivers:drivers.data,trend:trend?.data||[]});
    }).catch(problem=>{
      if(!abort.signal.aborted)setFilterError(problem instanceof Error?problem.message:"Could not apply filter. Last results preserved.");
    }).finally(()=>{if(!abort.signal.aborted)setFilterBusy(false);});
    return ()=>abort.abort();
  },[bundle,selectedGroup]);

  const completed=steps.filter(step=>progress[step.key]==="done"||progress[step.key]==="skipped").length;
  return <section className="qp-intelligence qp-unified-studio">
    <header className="qp-studio-compact">
      <div>
        <div className="qp-studio-context"><LayoutDashboard size={16}/> DASHBOARD BUILDER</div>
        {(!bundle||running)&&<h2>Building your dashboard</h2>}
        <p>{projectName} <span>·</span> {selected||"No connected table"}</p>
      </div>
      <div className="qp-studio-compact-controls">
        <input aria-label="Dashboard focus" placeholder="Analysis focus (optional)" maxLength={300} value={focus} onChange={e=>setFocus(e.target.value)} disabled={running}/>
        <button type="button" onClick={()=>void buildDashboard()} disabled={!selected||running}>
          {running?<LoaderCircle size={16} className="spinning"/>:bundle?<RotateCcw size={16}/>:<Play size={16}/>}
          {running?"Building…":bundle?"Rebuild":"Generate"}
        </button>
      </div>
    </header>
    {running && <div className="qp-build-progress" role="status" aria-live="polite">
      <div className="qp-build-progress-head">
        <div className="qp-progress-spinner"><Sparkles size={23}/></div>
        <div><h3>Preparing your dashboard</h3><p>Checking your connected data and building supported views.</p></div>
        <strong>{Math.round(completed/steps.length*100)}%</strong>
      </div>
      <div className="qp-progress-track"><div style={{width:completed/steps.length*100+"%"}}/></div>
      <div className="qp-build-steps">{steps.map(step=><div key={step.key} className={"qp-build-step "+progress[step.key]}>
        <span>{progress[step.key]==="done"?<CheckCircle2 size={17}/>:progress[step.key]==="running"?<LoaderCircle className="spinning" size={17}/>:progress[step.key]==="failed"?<XCircle size={17}/>:<span className="qp-progress-dot"/>}</span>
        <div><strong>{step.label}</strong><small>{progress[step.key]==="skipped"?"Not applicable":progress[step.key]==="done"?"Complete":step.detail}</small></div>
      </div>)}</div>
    </div>}
    {!running&&bundle&&filtered&&<DashboardBuilder
      key={projectRef+":"+bundle.plan.table}
      bundle={bundle} projectRef={projectRef}
      overview={filtered.overview} drivers={filtered.drivers} trend={filtered.trend}
      selectedGroup={selectedGroup} onSelectGroup={setSelectedGroup}
      filterBusy={filterBusy} filterError={filterError}/>}
    {!running&&!bundle&&!error&&<div className="qp-dashboard-empty">
      <BarChart3 size={39}/><h3>{selected?"Dashboard ready to generate":"Connect a dataset"}</h3>
      <p>{selected?"Your dashboard is built automatically from available dataset fields.":"Choose a connected table to get started."}</p>
      {selected&&<button type="button" onClick={()=>void buildDashboard()}><Play size={15}/> Generate dashboard</button>}
    </div>}
    {error&&<div className="qp-build-error" role="alert"><Activity size={18}/><span>{error}</span><button onClick={()=>void buildDashboard()}>Retry</button></div>}
    {!running&&warnings.length>0&&<details className="qp-build-warnings"><summary>Some optional analyses were unavailable</summary><p>{warnings.join(" · ")}</p></details>}
  </section>;
}
