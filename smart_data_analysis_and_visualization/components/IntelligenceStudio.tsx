"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, CheckCircle2, LoaderCircle, RotateCcw, Sparkles, XCircle } from "lucide-react";
import DashboardBuilder from "./DashboardBuilder";
import type { DashboardFilter, DataResponse, GroupPoint, InvestigationBundle, InvestigationPlan, InvestigationStage, OverviewData, QualityData, TrendPoint } from "../lib/intelligence";

type Table={name:string;columns:string[]};
type Props={tables:Table[];selectedTable:string;onSelectTable:(value:string)=>void;projectRef:string;projectName:string;ready:boolean};
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
async function requestStage<T>(stage:InvestigationStage,table:string,goal:string,plan?:InvestigationPlan,filters?:DashboardFilter[],signal?:AbortSignal):Promise<DataResponse<T>>{
  const response=await fetch("/api/smart-investigation",{
    method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({stage,table,goal,metric:plan?.metric,dimension:plan?.dimension,time:plan?.time,filters}),
    signal
  });
  const data:unknown=await response.json();
  if(!response.ok){
    const detail=data && typeof data==="object" && "error" in data && typeof data.error==="string" ? data.error : "Database analysis failed.";
    throw new Error(detail);
  }
  return data as DataResponse<T>;
}
export default function IntelligenceStudio({tables,selectedTable,projectRef,ready}:Props){
  const selected=selectedTable!=="all" ? selectedTable : tables[0]?.name||"";
  const [bundle,setBundle]=useState<InvestigationBundle|null>(null);
  const [progress,setProgress]=useState<Progress>(initial);
  const [running,setRunning]=useState(false);
  const [loadingDataset,setLoadingDataset]=useState(false);
  const [error,setError]=useState("");
  const [warnings,setWarnings]=useState<string[]>([]);
  const [filters,setFilters]=useState<DashboardFilter[]>([]);
  const [lastUpdated,setLastUpdated]=useState<number|null>(null);
  const [refreshVersion,setRefreshVersion]=useState(0);
  const [filtered,setFiltered]=useState<{overview:OverviewData;drivers:GroupPoint[];trend:TrendPoint[]}|null>(null);
  const [filterBusy,setFilterBusy]=useState(false);
  const [filterError,setFilterError]=useState("");
  const controller=useRef<AbortController|null>(null);
  const completedDashboards=useRef(new Map<string,InvestigationBundle>());
  const initialScanStarted=useRef(false);
  const previousFilterKey=useRef<string|null>(null);

  async function buildDashboard(showProgress=true){
    if(!selected) return;
    initialScanStarted.current=true;
    controller.current?.abort();
    const abort=new AbortController();
    controller.current=abort;
    setRunning(showProgress);
    setLoadingDataset(!showProgress);
    setProgress(initial());
    setError("");
    setWarnings([]);
    setBundle(null);
    setFiltered(null);
    setFilters([]);
    const mark=(key:InvestigationStage,status:Status)=>setProgress(current=>({...current,[key]:status}));
    const goal="Identify useful KPIs, category comparisons and observed time trends";
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
      completedDashboards.current.set(projectRef+":"+selected,next);
      setBundle(next);
      setFiltered({overview:next.overview,drivers:next.drivers||[],trend:next.trend||[]});
      setLastUpdated(Date.now());
    }catch(problem){
      if(!abort.signal.aborted)setError(problem instanceof Error ? problem.message : "Dashboard generation failed.");
    }finally{
      if(!abort.signal.aborted){setRunning(false);setLoadingDataset(false);}
    }
  }

  // The dashboard stays mounted when navigating to other modules. A per-session
  // in-memory cache restores results after dataset/tab changes, without a full scan.
  // The cache and initial-scan guard reset naturally on a real browser reload.
  useEffect(()=>{
    if(!ready) return;
    controller.current?.abort();
    setRunning(false);
    setLoadingDataset(false);
    setError("");
    setWarnings([]);
    setProgress(initial());
    setFilters([]);
    setFilterError("");
    const key=projectRef+":"+selected;
    const cached=completedDashboards.current.get(key);
    if(cached?.overview){
      setBundle(cached);
      setFiltered({overview:cached.overview,drivers:cached.drivers||[],trend:cached.trend||[]});
      return;
    }
    setBundle(null);
    setFiltered(null);
    if(!selected) return;
    const timer=window.setTimeout(()=>{
      if(initialScanStarted.current) void buildDashboard(false);
      else {
        initialScanStarted.current=true;
        void buildDashboard(true);
      }
    },0);
    return ()=>window.clearTimeout(timer);
  },[projectRef,selected,ready]);

  useEffect(()=>()=>controller.current?.abort(),[]);

  // Remember filter preferences without storing database values or results.
  const filterKey=JSON.stringify(filters);
  useEffect(()=>{
    if(!bundle?.overview || !ready || bundle.plan.table!==selected) return;
    const key="querypilot:dashboard-filters:"+projectRef+":"+selected;
    try {
      const saved=window.localStorage.getItem(key);
      if(!saved) return;
      const raw:unknown=JSON.parse(saved);
      if(Array.isArray(raw)) {
        const valid=raw.filter(item=>item && typeof item.column==="string" &&
          bundle.plan.dimensions.includes(item.column) &&
          typeof item.value==="string" && item.value.length<=110).slice(0,3) as DashboardFilter[];
        if(valid.length) setFilters(valid);
      }
    }catch { /* Storage is optional */ }
  },[projectRef,selected,bundle?.plan.table,ready]);

  useEffect(()=>{
    if(!bundle?.overview || bundle.plan.table!==selected || !ready) return;
    const current=bundle;
    const appliedFilters=filters;
    const controller=new AbortController();
    let pending=false;
    let cancelled=false;
    const update=async(silent:boolean)=>{
      if(cancelled || pending || document.visibilityState==="hidden") return;
      pending=true;
      if(!silent) setFilterBusy(true);
      try {
        const [overview,drivers,trend]=await Promise.all([
          requestStage<OverviewData>("overview",current.plan.table,current.goal,current.plan,appliedFilters,controller.signal),
          requestStage<GroupPoint[]>("drivers",current.plan.table,current.goal,current.plan,appliedFilters,controller.signal),
          current.plan.time
            ? requestStage<TrendPoint[]>("trend",current.plan.table,current.goal,current.plan,appliedFilters,controller.signal)
            : Promise.resolve(null)
        ]);
        if(cancelled || controller.signal.aborted) return;
        const next={overview:overview.data,drivers:drivers.data,trend:trend?.data||[]};
        setFiltered(next);
        if(!appliedFilters.length) {
          const fresh={...current,...next};
          completedDashboards.current.set(projectRef+":"+selected,fresh);
          setBundle(previous=>previous?.plan.table===selected ? {...previous,...next} : previous);
        }
        setRefreshVersion(value=>value+1);
        setLastUpdated(Date.now());
        setFilterError("");
      } catch(problem) {
        if(!cancelled && !controller.signal.aborted) {
          setFilterError("Automatic update temporarily unavailable. Showing the last successful result.");
        }
      } finally {
        pending=false;
        if(!cancelled) setFilterBusy(false);
      }
    };
    const changedFilters=previousFilterKey.current!==null && previousFilterKey.current!==filterKey;
    previousFilterKey.current=filterKey;
    if(appliedFilters.length || changedFilters) {
      // Keep the existing dashboard visible while fresh filtered values load.
      void update(false);
    } else {
      setFiltered({overview:current.overview,drivers:current.drivers||[],trend:current.trend||[]});
    }
    // Polling is used because the Supabase Management OAuth connection does
    // not expose a project Realtime channel or browser-accessible DB key.
    const timer=window.setInterval(()=>void update(true),10000);
    const onFocus=()=>void update(true);
    const onVisibility=()=>{if(document.visibilityState==="visible")void update(true);};
    window.addEventListener("focus",onFocus);
    document.addEventListener("visibilitychange",onVisibility);
    return ()=>{
      cancelled=true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus",onFocus);
      document.removeEventListener("visibilitychange",onVisibility);
    };
  },[bundle?.plan.table,projectRef,selected,ready,filterKey]);

  function changeFilters(value:DashboardFilter[]) {
    const columns=new Set<string>();
    const valid=value.filter(filter=>{
      if(!bundle?.plan.dimensions.includes(filter.column) ||
          columns.has(filter.column) || typeof filter.value!=="string" || filter.value.length>110) return false;
      columns.add(filter.column);
      return true;
    }).slice(0,3);
    setFilters(valid);
    try {
      localStorage.setItem("querypilot:dashboard-filters:"+projectRef+":"+selected,JSON.stringify(valid));
    }catch { /* Storage is optional */ }
  }

  function selectDefaultGroup(value:string|null) {
    const column=bundle?.plan.dimension;
    if(!column) return;
    const other=filters.filter(filter=>filter.column!==column);
    changeFilters(value===null ? other : [...other.slice(0,2),{column,value}]);
  }

  const completed=steps.filter(step=>progress[step.key]==="done"||progress[step.key]==="skipped").length;
  return <section className="qp-intelligence qp-unified-studio">
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
      filters={filters} onChangeFilters={changeFilters} onSelectGroup={selectDefaultGroup}
      filterBusy={filterBusy} filterError={filterError} lastUpdated={lastUpdated} refreshVersion={refreshVersion}/>}
    {!running&&!bundle&&!error&&<div className="qp-dashboard-empty">
      {loadingDataset ? <LoaderCircle size={39} className="spinning"/> : <BarChart3 size={39}/>}
      <h3>{!selected ? "Connect a dataset" : loadingDataset ? "Loading updated dataset" : "Preparing your dashboard"}</h3>
      <p>{!selected ? "Choose a connected table to get started." :
        "The latest results are being loaded from Supabase without reloading the website."}</p>
    </div>}
    {error&&<div className="qp-build-error" role="alert"><Activity size={18}/><span>{error}</span><button type="button" onClick={()=>window.location.reload()}>Reload page</button></div>}
    {!running&&warnings.length>0&&<details className="qp-build-warnings"><summary>Some optional analyses were unavailable</summary><p>{warnings.join(" · ")}</p></details>}
  </section>;
}
