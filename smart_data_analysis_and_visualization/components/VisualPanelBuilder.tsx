"use client";

import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowRight, BarChart3, CheckCircle2, ChevronLeft, Database, LoaderCircle, X, Search } from "lucide-react";
import ChartTypeGlyph from "./ChartTypeGlyph";
import SpecialVisual, { specialCharts } from "./SpecialVisuals";
import type { CustomAggregation, CustomChart, CustomPanelData, CustomPanelSpec, DashboardFilter } from "../lib/intelligence";

type Fields = { metrics: string[]; dimensions: string[]; times: string[] };
type ChartMode = "category" | "time" | "single" | "twoDim" | "timeSeries" | "distribution" | "scatter" | "multi";
type ChartGroup = "Comparison" | "Trends" | "Part-to-whole" | "Distribution" | "Relationship" | "KPIs" | "Flow" | "Ranking" | "Multi-dimensional" | "Tables";
type ChartItem = {
  value: CustomChart;
  label: string;
  description: string;
  mode: ChartMode;
  group: ChartGroup;
};
type Props = {
  table: string;
  filters: DashboardFilter[];
  initialSpec?: CustomPanelSpec | null;
  initialWide?: boolean;
  atLimit: boolean;
  onClose: () => void;
  onSave: (spec: CustomPanelSpec, wide: boolean) => void;
};

const chartOptions: ChartItem[] = [
 {value:"bar",label:"Horizontal bar",description:"Rank categories",mode:"category",group:"Comparison"},
 {value:"column",label:"Column chart",description:"Compare category values",mode:"category",group:"Comparison"},
 {value:"grouped_bar",label:"Grouped bars",description:"Compare two category fields",mode:"twoDim",group:"Comparison"},
 {value:"stacked_bar",label:"Stacked bars",description:"Category totals and parts",mode:"twoDim",group:"Comparison"},
 {value:"stacked_100",label:"100% stacked",description:"Relative proportions",mode:"twoDim",group:"Comparison"},
 {value:"bullet",label:"Bullet chart",description:"Actual versus target",mode:"single",group:"Comparison"},
 {value:"lollipop",label:"Lollipop",description:"Minimal dot ranking",mode:"category",group:"Comparison"},
 {value:"line",label:"Line chart",description:"Month-to-month trends",mode:"time",group:"Trends"},
 {value:"area",label:"Area chart",description:"Trend and volume",mode:"time",group:"Trends"},
 {value:"stacked_area",label:"Stacked area",description:"Trends split by category",mode:"timeSeries",group:"Trends"},
 {value:"sparkline",label:"Sparkline",description:"Compact time series",mode:"time",group:"Trends"},
 {value:"combo",label:"Bar + line combo",description:"Compare two metrics",mode:"time",group:"Trends"},
 {value:"pie",label:"Pie chart",description:"Shares across categories",mode:"category",group:"Part-to-whole"},
 {value:"donut",label:"Donut chart",description:"Category contribution",mode:"category",group:"Part-to-whole"},
 {value:"treemap",label:"Treemap",description:"Space by relative size",mode:"category",group:"Part-to-whole"},
 {value:"waffle",label:"Waffle chart",description:"100-square percentages",mode:"category",group:"Part-to-whole"},
 {value:"histogram",label:"Histogram",description:"Numeric distribution",mode:"distribution",group:"Distribution"},
 {value:"box",label:"Box plot",description:"Quartiles and outliers",mode:"distribution",group:"Distribution"},
 {value:"violin",label:"Violin plot",description:"Distribution shape",mode:"distribution",group:"Distribution"},
 {value:"density",label:"Density plot",description:"Smoothed distribution",mode:"distribution",group:"Distribution"},
 {value:"scatter",label:"Scatter plot",description:"Two numeric variables",mode:"scatter",group:"Relationship"},
 {value:"bubble",label:"Bubble chart",description:"X, Y and marker size",mode:"scatter",group:"Relationship"},
 {value:"heatmap",label:"Heatmap",description:"Values across two fields",mode:"twoDim",group:"Relationship"},
 {value:"correlation",label:"Correlation matrix",description:"Pearson relationships",mode:"multi",group:"Relationship"},
 {value:"kpi",label:"KPI number",description:"Headline numeric metric",mode:"single",group:"KPIs"},
 {value:"gauge",label:"Gauge",description:"Metric on a target scale",mode:"single",group:"KPIs"},
 {value:"progress",label:"Progress bar",description:"Progress toward target",mode:"single",group:"KPIs"},
 {value:"thermometer",label:"Thermometer",description:"Goal or quota progress",mode:"single",group:"KPIs"},
 {value:"funnel",label:"Funnel",description:"Stage size breakdown",mode:"category",group:"Flow"},
 {value:"waterfall",label:"Waterfall",description:"Signed contributions",mode:"category",group:"Flow"},
 {value:"sankey",label:"Sankey-style flow",description:"Links across two fields",mode:"twoDim",group:"Flow"},
 {value:"slope",label:"Slope chart",description:"Values between periods",mode:"timeSeries",group:"Ranking"},
 {value:"bump",label:"Bump chart",description:"Rank evolution",mode:"timeSeries",group:"Ranking"},
 {value:"radar",label:"Radar",description:"Category value profile",mode:"category",group:"Multi-dimensional"},
 {value:"parallel",label:"Parallel coordinates",description:"Compare numeric fields",mode:"multi",group:"Multi-dimensional"},
 {value:"network",label:"Network graph",description:"Category relationships",mode:"twoDim",group:"Multi-dimensional"},
 {value:"table",label:"Data table",description:"Detailed grouped values",mode:"category",group:"Tables"},
 {value:"pivot",label:"Pivot table",description:"Two-field summary table",mode:"twoDim",group:"Tables"}
];
const chartGroups: ChartGroup[] = ["Comparison","Trends","Part-to-whole","Distribution","Relationship","KPIs","Flow","Ranking","Multi-dimensional","Tables"];
function compatible(option:ChartItem,fields:Fields):string|null {
 const dims=fields.dimensions.length,metrics=fields.metrics.length,times=fields.times.length;
 if(option.mode==="category"&&dims<1)return "Requires a categorical field";
 if(option.mode==="time"&&times<1)return "Requires a date/time field";
 if(option.mode==="twoDim"&&dims<2)return "Requires two category fields";
 if(option.mode==="timeSeries"&&(!times||!dims))return "Requires a date and category field";
 if(option.mode==="distribution"&&metrics<1)return "Requires a numeric field";
 if(option.mode==="scatter"&&metrics<(option.value==="bubble"?3:2))return "Requires "+(option.value==="bubble"?"three":"two")+" numeric fields";
 if(option.mode==="multi"&&metrics<(option.value==="parallel"?3:2))return "Requires "+(option.value==="parallel"?"three":"two")+" numeric fields";
 if(option.value==="combo"&&metrics<2)return "Requires two numeric measures";
 return null;
}
const palette = ["#2F4A63","#5B91A3","#CFEAE0","#131B2B"];
const format = (value:number|null|undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? "—" : new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(value);
const label = (value:string) => value.replace(/_/g," ");
const isShare = (chart:CustomChart) => chart==="pie" || chart==="donut";

function Preview({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}) {
  if(specialCharts.has(spec.chart))return <SpecialVisual spec={spec} data={data}/>;
  const points = data.points;
  if (spec.chart==="kpi") return <div className="qp-visual-preview-number"><strong>{format(data.total)}</strong><span>{spec.description}</span></div>;
  if (spec.chart==="gauge") {
    const min=spec.gaugeMin ?? 0;
    const max=spec.gaugeMax ?? 100;
    const value=data.total ?? 0;
    const percent=Math.max(0,Math.min(100,(value-min)/(max-min)*100));
    return <div className="qp-visual-mini-gauge"><div><span>{format(value)}</span><small>{format(min)} — {format(max)}</small></div><div className="qp-visual-mini-track"><span style={{width:percent+"%"}}/></div></div>;
  }
  if (spec.chart==="table") return <div className="qp-visual-preview-table"><table><thead><tr><th>{label(spec.dimension||"Group")}</th><th>Records</th><th>Value</th></tr></thead><tbody>{points.slice(0,6).map((point,i)=><tr key={i}><td title={point.label}>{point.label}</td><td>{format(point.records)}</td><td>{format(point.value)}</td></tr>)}</tbody></table></div>;
  if (spec.chart==="pie" || spec.chart==="donut") return <ResponsiveContainer width="100%" height={220}><PieChart><Pie data={points.slice(0,10)} dataKey="value" nameKey="label" innerRadius={spec.chart==="donut"?52:0} outerRadius={82}>{points.slice(0,10).map((point,i)=><Cell key={point.label+i} fill={palette[i%palette.length]}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer>;
  if (spec.chart==="radar") return <ResponsiveContainer width="100%" height={220}><RadarChart data={points.slice(0,10)} outerRadius={74}><PolarGrid stroke="#CFEAE0"/><PolarAngleAxis dataKey="label" tick={{fontSize:9,fill:"#2F4A63"}}/><Radar dataKey="value" stroke="#2F4A63" fill="#5B91A3" fillOpacity={.23}/><Tooltip/></RadarChart></ResponsiveContainer>;
  if (spec.chart==="line") return <ResponsiveContainer width="100%" height={220}><LineChart data={points} margin={{left:-10,right:12,top:16,bottom:8}}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/><XAxis dataKey="label" tick={{fontSize:9}} interval="preserveStartEnd"/><YAxis tick={{fontSize:9}}/><Tooltip/><Line type="monotone" dataKey="value" stroke="#2F4A63" strokeWidth={2.5} dot={false}/></LineChart></ResponsiveContainer>;
  if (spec.chart==="area") return <ResponsiveContainer width="100%" height={220}><AreaChart data={points} margin={{left:-10,right:12,top:16,bottom:8}}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/><XAxis dataKey="label" tick={{fontSize:9}} interval="preserveStartEnd"/><YAxis tick={{fontSize:9}}/><Tooltip/><Area type="monotone" dataKey="value" stroke="#2F4A63" fill="#CFEAE0" strokeWidth={2.5}/></AreaChart></ResponsiveContainer>;
  if (spec.chart==="bar") return <ResponsiveContainer width="100%" height={220}><BarChart data={points.slice(0,8)} layout="vertical" margin={{left:3,right:15,top:8,bottom:6}}><XAxis type="number" tick={{fontSize:9}}/><YAxis dataKey="label" type="category" width={90} tick={{fontSize:9}}/><Tooltip/><Bar dataKey="value" fill="#5B91A3" radius={[0,4,4,0]}/></BarChart></ResponsiveContainer>;
  return <ResponsiveContainer width="100%" height={220}><BarChart data={points.slice(0,10)} margin={{left:-15,right:5,top:12,bottom:8}}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/><XAxis dataKey="label" tick={{fontSize:9}} interval="preserveStartEnd"/><YAxis tick={{fontSize:9}}/><Tooltip/><Bar dataKey="value" fill="#5B91A3" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer>;
}

export default function VisualPanelBuilder({table,filters,initialSpec,initialWide=false,atLimit,onClose,onSave}:Props) {
  const [fields,setFields]=useState<Fields|null>(null);
  const [schemaError,setSchemaError]=useState("");
  const [reload,setReload]=useState(0);
  const [chart,setChart]=useState<CustomChart|null>(initialSpec?.chart || null);
  const [dimension,setDimension]=useState(initialSpec?.time || initialSpec?.dimension || "");
  const [measure,setMeasure]=useState(initialSpec?.metric || "__count__");
  const [aggregation,setAggregation]=useState<CustomAggregation>(initialSpec?.aggregation==="count" ? "sum" : initialSpec?.aggregation || "sum");
  const [customTitle,setCustomTitle]=useState(initialSpec?.title || "");
  const [resultLimit,setResultLimit]=useState(initialSpec?.resultLimit || 10);
  const [sort,setSort]=useState<"asc"|"desc">(initialSpec?.sortDirection || "desc");
  const [wide,setWide]=useState(initialWide);
  const [gaugeMin,setGaugeMin]=useState(String(initialSpec?.gaugeMin ?? 0));
  const [gaugeMax,setGaugeMax]=useState(String(initialSpec?.gaugeMax ?? 100));
  const [secondDimension,setSecondDimension]=useState(initialSpec?.secondDimension||(initialSpec?.time?initialSpec.dimension||"":""));
  const [xMetric,setXMetric]=useState(initialSpec?.xMetric||"");
  const [sizeMetric,setSizeMetric]=useState(initialSpec?.sizeMetric||"");
  const [secondaryMetric,setSecondaryMetric]=useState(initialSpec?.secondaryMetric||"");
  const [chosenMetrics,setChosenMetrics]=useState<string[]>(initialSpec?.metrics||[]);
  const [chartSearch,setChartSearch]=useState("");
  const [activeGroup,setActiveGroup]=useState<ChartGroup|"All">("All");
  const [preview,setPreview]=useState<{spec:CustomPanelSpec;data:CustomPanelData}|null>(null);
  const [validating,setValidating]=useState(false);
  const [error,setError]=useState("");
  const requestRef=useRef<AbortController|null>(null);
  const closeRef=useRef<HTMLButtonElement|null>(null);
  const scrollRef=useRef<HTMLDivElement|null>(null);
  const [step,setStep]=useState<"gallery"|"configure">(initialSpec?.chart?"configure":"gallery");
  const filterKey=JSON.stringify(filters);

  useEffect(()=>{
    const controller=new AbortController();
    setFields(null);
    setSchemaError("");
    fetch("/api/smart-dashboard-panel",{
      method:"POST",cache:"no-store",signal:controller.signal,
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"schema",table})
    }).then(async response=>{
      const data=await response.json();
      if(!response.ok)throw new Error(data.error || "Could not inspect this dataset.");
      const fields=data.fields as Fields;
      if(!fields || !Array.isArray(fields.metrics) || !Array.isArray(fields.dimensions) || !Array.isArray(fields.times))throw new Error("No compatible schema was returned.");
      return fields;
    }).then(data=>{if(!controller.signal.aborted)setFields(data);})
      .catch(problem=>{if(!controller.signal.aborted)setSchemaError(problem instanceof Error?problem.message:"Unable to inspect dataset fields.");});
    return ()=>controller.abort();
  },[table,reload]);

  useEffect(()=>{
    closeRef.current?.focus();
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[onClose]);

  useEffect(()=>{
    requestRef.current?.abort();
    setValidating(false);
    setPreview(null);
    setError("");
  },[chart,dimension,secondDimension,xMetric,sizeMetric,secondaryMetric,chosenMetrics,measure,aggregation,customTitle,resultLimit,sort,wide,gaugeMin,gaugeMax,filterKey]);

  useEffect(()=>()=>requestRef.current?.abort(),[]);

  const selected=chartOptions.find(item=>item.value===chart);
  const mode=selected?.mode;
  const availableMetrics=fields?.metrics||[];
  const needsAxis=mode==="category"||mode==="time"||mode==="twoDim"||mode==="timeSeries";
  const primaryIsDate=mode==="time"||mode==="timeSeries";
  const eligibleOptions=primaryIsDate ? fields?.times||[] : fields?.dimensions||[];
  const isShare=chart==="pie"||chart==="donut"||chart==="treemap"||chart==="waffle"||chart==="funnel"||
    chart==="radar"||chart==="stacked_100"||chart==="stacked_area"||chart==="sankey"||chart==="network";
  const isGauge=["gauge","bullet","progress","thermometer"].includes(chart||"");
  const numericOnly=["distribution","scatter","multi"].includes(mode||"");
  const hasSecondDimension=mode==="twoDim"||mode==="timeSeries";
  const boundsValid=!isGauge || (gaugeMin.trim()!=="" && gaugeMax.trim()!=="" &&
    Number.isFinite(Number(gaugeMin)) && Number.isFinite(Number(gaugeMax)) && Number(gaugeMax)>Number(gaugeMin) &&
    (chart!=="progress" || (Number(gaugeMin)===0 && Number(gaugeMax)>0)));
  const missingDimension=Boolean(fields&&selected&&compatible(selected,fields));
  const primaryValid=!needsAxis || eligibleOptions.includes(dimension);
  const secondValid=!hasSecondDimension || (fields?.dimensions.includes(secondDimension) &&
    (mode==="timeSeries" || secondDimension!==dimension));
  const metricValid=mode==="multi" ? chosenMetrics.length>=(chart==="parallel"?3:2) &&
      chosenMetrics.length<=6 && chosenMetrics.every(m=>availableMetrics.includes(m)) &&
      new Set(chosenMetrics).size===chosenMetrics.length
    : (measure==="__count__"&&!numericOnly || availableMetrics.includes(measure));
  const scatterValid=mode!=="scatter" || (availableMetrics.includes(xMetric) && xMetric!==measure &&
    (chart!=="bubble" || (availableMetrics.includes(sizeMetric) && ![xMetric,measure].includes(sizeMetric))));
  const comboValid=chart!=="combo" || (availableMetrics.includes(measure)&&availableMetrics.includes(secondaryMetric)&&secondaryMetric!==measure);
  const canPreview=Boolean(fields&&chart&&!missingDimension&&primaryValid&&secondValid&&metricValid&&scatterValid&&comboValid&&boundsValid);
  const canAdd=Boolean(preview&&!validating&&(!atLimit||Boolean(initialSpec)));
  const aggregate=mode==="multi" ? "count" : (measure==="__count__" ? "count" : isShare ? "sum" : aggregation);
  const defaultTitle=selected?.label||"New visualization";
  const visibleCharts=chartOptions.filter(option=>(activeGroup==="All"||option.group===activeGroup)&&
    (option.label+" "+option.description+" "+option.group).toLowerCase().includes(chartSearch.trim().toLowerCase()));
  const enabledCount=fields?chartOptions.filter(item=>!compatible(item,fields)).length:0;

  function chooseChart(next:ChartItem) {
    if(!fields||compatible(next,fields))return;
    setChart(next.value);
    setDimension(next.mode==="time"||next.mode==="timeSeries" ? fields.times[0]||"" :
      next.mode==="category"||next.mode==="twoDim" ? fields.dimensions[0]||"" : "");
    setSecondDimension(next.mode==="twoDim" ? fields.dimensions[1]||"" : fields.dimensions[0]||"");
    setMeasure(["distribution","scatter"].includes(next.mode) || next.value==="combo" ? fields.metrics[next.mode==="scatter"?1:0]||"__count__" : "__count__");
    setXMetric(fields.metrics[0]||"");
    setSizeMetric(fields.metrics[2]||"");
    setSecondaryMetric(fields.metrics[1]||"");
    setChosenMetrics(fields.metrics.slice(0,next.value==="parallel"?3:2));
    setAggregation("sum");
    setCustomTitle(next.label+" · "+table);
    setStep("configure");
    scrollRef.current?.scrollTo({top:0,behavior:"auto"});
  }

  function returnToGallery() {
    requestRef.current?.abort();
    setValidating(false);
    setStep("gallery");
    scrollRef.current?.scrollTo({top:0,behavior:"auto"});
  }

  async function validate() {
    if(!canPreview || !chart || !selected)return;
    requestRef.current?.abort();
    const controller=new AbortController();
    requestRef.current=controller;
    setValidating(true);
    setPreview(null);
    setError("");
    const proposed:CustomPanelSpec={
      chart,aggregation:aggregate,
      metric:mode==="multi"||measure==="__count__"?null:measure,
      dimension:mode==="timeSeries" ? secondDimension : mode==="category"||mode==="twoDim" ? dimension : null,
      time:primaryIsDate?dimension:null,
      title:customTitle.trim()||defaultTitle,
      description:"Configured visualization for "+table,
      resultLimit,sortDirection:sort,
      ...(isGauge?{gaugeMin:Number(gaugeMin),gaugeMax:Number(gaugeMax)}:{}),
      ...(mode==="twoDim"?{secondDimension}:{}),
      ...(mode==="scatter"?{xMetric,sizeMetric:chart==="bubble"?sizeMetric:null}:{}),
      ...(mode==="multi"?{metrics:chosenMetrics}:{}),
      ...(chart==="combo"?{secondaryMetric}:{})
    };
    try{
      const response=await fetch("/api/smart-dashboard-panel",{
        method:"POST",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"refresh",table,spec:proposed,filters})
      });
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"This combination is not supported by the selected data.");
      if(!data.spec || !Array.isArray(data.data?.points))throw new Error("No valid chart data was returned.");
      if(!controller.signal.aborted)setPreview({spec:data.spec as CustomPanelSpec,data:data.data as CustomPanelData});
    }catch(problem){
      if(!controller.signal.aborted)setError(problem instanceof Error?problem.message:"Unable to validate this chart.");
    }finally{
      if(!controller.signal.aborted)setValidating(false);
    }
  }

  function addPanel() {
    if(!preview || (atLimit && !initialSpec))return;
    onSave(preview.spec,wide);
  }

  return <div className="qp-visual-overlay" role="presentation">
    <button type="button" className="qp-visual-backdrop" aria-label="Close visualization builder" onClick={onClose}/>
    <aside className={"qp-visual-drawer"+(step==="configure"?" qp-visual-drawer-config":"")} role="dialog" aria-modal="true" aria-labelledby="qp-visual-title">
      <header className="qp-visual-header">
        {step==="configure" ? <button type="button" className="qp-visual-back" onClick={returnToGallery} aria-label="Back to chart gallery"><ChevronLeft size={21}/></button> :
          <div className="qp-visual-header-icon"><BarChart3 size={19}/></div>}
        <div className="qp-visual-header-copy">
          <span>VISUAL BUILDER</span>
          <h2 id="qp-visual-title">{step==="configure" ? (initialSpec?"Edit ":"Customize ")+(selected?.label||"chart") : "Choose a visualization"}</h2>
          <p><Database size={12}/> {table}</p>
        </div>
        <button ref={closeRef} className="qp-visual-close" type="button" onClick={onClose} aria-label="Close builder"><X size={18}/></button>
      </header>

      <div className="qp-visual-scroll" ref={scrollRef}>
        {schemaError && <div className="qp-visual-error" role="alert">{schemaError}<button type="button" onClick={()=>setReload(value=>value+1)}>Retry</button></div>}
        {!fields && !schemaError && <div className="qp-visual-loading" role="status"><LoaderCircle size={19} className="spinning"/> Checking compatible dataset fields…</div>}
        {fields && step==="gallery" && <>
          <div className="qp-visual-section-heading">
            <div><span className="qp-visual-step">01</span><h3>Choose a visualization</h3></div>
            <p>Options are checked against the selected dataset.</p>
          </div>
          <div className="qp-visual-searchline">
            <label className="qp-visual-search"><Search size={16}/><input value={chartSearch} onChange={event=>setChartSearch(event.target.value)} placeholder="Search chart types…" aria-label="Search visualizations"/></label>
            <span className="qp-visual-available-count">{enabledCount} compatible</span>
          </div>
          <div className="qp-visual-groups" role="group" aria-label="Chart categories">
            {(["All",...chartGroups] as (ChartGroup|"All")[]).map(group=><button type="button" key={group} className={activeGroup===group?"active":""}
              onClick={()=>setActiveGroup(group)} aria-pressed={activeGroup===group}>{group}</button>)}
          </div>
          <div className="qp-visual-gallery">
            {visibleCharts.map(option=>{
              const unavailable=compatible(option,fields);
              return <button key={option.value} type="button" disabled={Boolean(unavailable)} title={unavailable||option.description}
                className={"qp-visual-option"+(chart===option.value?" selected":"")} onClick={()=>chooseChart(option)}
                aria-pressed={chart===option.value}>
                <span className="qp-visual-option-icon"><ChartTypeGlyph chart={option.value} size={36}/></span>
                <strong>{option.label}</strong>
                <small>{unavailable||option.description}</small>
              </button>;
            })}
          </div>
          {!visibleCharts.length&&<p className="qp-visual-guidance">No chart types match that search. Try another category.</p>}
          <div className="qp-visual-guidance"><CheckCircle2 size={16}/> Choose a chart to open its setup. You can return to this gallery at any time.</div>
        </>}
          {fields && step==="configure" && chart && selected && <>
            <div className="qp-visual-selected-card">
              <span className="qp-visual-selected-icon"><ChartTypeGlyph chart={chart} size={44}/></span>
              <div><strong>{selected.label}</strong><p>{selected.description}</p></div>
              <button type="button" className="qp-visual-change-link" onClick={returnToGallery}>Change</button>
            </div>
            <div className="qp-visual-section-heading qp-visual-config-heading"><div><span className="qp-visual-step">02</span><h3>Configure your data</h3></div><p>Only compatible fields are offered.</p></div>
            <div className="qp-visual-fields">
              {needsAxis && <label className="qp-visual-field"><span>{primaryIsDate?"X axis · Date / time":"X axis · Category"}</span>
                <select value={dimension} onChange={event=>setDimension(event.target.value)}>
                  <option value="">Choose a field</option>
                  {eligibleOptions.map(field=><option key={field} value={field}>{label(field)}</option>)}
                </select>
              </label>}
              {hasSecondDimension&&<label className="qp-visual-field"><span>{mode==="timeSeries"?"Series · Category":"Group / series · Second category"}</span>
                <select value={secondDimension} onChange={event=>setSecondDimension(event.target.value)}>
                  <option value="">Choose another field</option>
                  {(fields.dimensions||[]).filter(field=>mode==="timeSeries"||field!==dimension).map(field=><option key={field} value={field}>{label(field)}</option>)}
                </select>
              </label>}
              {mode==="scatter" && <label className="qp-visual-field"><span>X axis · Numeric field</span>
                <select value={xMetric} onChange={event=>setXMetric(event.target.value)}>{availableMetrics.map(field=><option key={field} value={field}>{label(field)}</option>)}</select>
              </label>}
              {mode!=="multi" && <label className="qp-visual-field"><span>{mode==="single"?"Metric":mode==="distribution"?"Numeric field":"Y axis · Measure"}</span>
                <select value={measure} onChange={event=>{setMeasure(event.target.value);setAggregation("sum");}}>
                  {!numericOnly && <option value="__count__">Number of records</option>}
                  {availableMetrics.map(field=><option key={field} value={field}>{label(field)}</option>)}
                </select>
              </label>}
              {chart==="bubble" && <label className="qp-visual-field"><span>Marker size · Numeric field</span>
                <select value={sizeMetric} onChange={event=>setSizeMetric(event.target.value)}>{availableMetrics.map(field=><option key={field} value={field}>{label(field)}</option>)}</select>
              </label>}
              {chart==="combo" && <label className="qp-visual-field"><span>Line series · Second numeric measure</span>
                <select value={secondaryMetric} onChange={event=>setSecondaryMetric(event.target.value)}>
                  {availableMetrics.filter(field=>field!==measure).map(field=><option key={field} value={field}>{label(field)}</option>)}
                </select>
              </label>}
              {mode==="multi"&&<fieldset className="qp-visual-multi-metrics qp-visual-field-full"><legend>{chart==="parallel"?"Choose 3–6 numeric fields":"Choose 2–6 numeric fields"}</legend>
                <div>{availableMetrics.map(field=><label key={field}><input type="checkbox" checked={chosenMetrics.includes(field)}
                  onChange={event=>setChosenMetrics(current=>event.target.checked?[...current,field].slice(0,6):current.filter(item=>item!==field))}/>{label(field)}</label>)}</div>
              </fieldset>}
              {!numericOnly && <label className="qp-visual-field"><span>Calculation</span>
                <select value={aggregate} disabled={measure==="__count__" || isShare} onChange={event=>setAggregation(event.target.value as CustomAggregation)}>
                  {measure==="__count__"?<option value="count">Count records</option>:isShare?<option value="sum">Sum</option>:<>
                    <option value="sum">Sum</option><option value="average">Average</option>
                    <option value="min">Minimum</option><option value="max">Maximum</option>
                  </>}
                </select>
              </label>}
              <label className="qp-visual-field qp-visual-field-full"><span>Panel title</span>
                <input maxLength={65} value={customTitle} onChange={event=>setCustomTitle(event.target.value)} placeholder={defaultTitle}/>
              </label>
              {needsAxis && <><label className="qp-visual-field"><span>{primaryIsDate?"Periods":"Category limit"}</span>
                <select value={resultLimit} onChange={event=>setResultLimit(Number(event.target.value))}>
                  {[...new Set([5,10,12,15,20,24,30,initialSpec?.resultLimit||10])].sort((a,b)=>a-b).map(count=><option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <label className="qp-visual-field"><span>{primaryIsDate?"Period order":"Value order"}</span>
                <select value={sort} onChange={event=>setSort(event.target.value as "asc"|"desc")}>
                  <option value="desc">{primaryIsDate?"Latest periods":"Highest first"}</option>
                  <option value="asc">{primaryIsDate?"Earliest periods":"Lowest first"}</option>
                </select>
              </label></>}
              {isGauge && <><label className="qp-visual-field"><span>{chart==="progress"?"Baseline (zero)":"Scale minimum"}</span><input type="number" value={gaugeMin} onChange={event=>setGaugeMin(event.target.value)}/></label>
                <label className="qp-visual-field"><span>Scale maximum / target</span><input type="number" value={gaugeMax} onChange={event=>setGaugeMax(event.target.value)}/></label></>}
              <label className="qp-visual-wide-choice qp-visual-field-full"><input type="checkbox" checked={wide} onChange={event=>setWide(event.target.checked)}/><span>Use full dashboard width</span></label>
            </div>
            {!boundsValid && <p className="qp-visual-inline-error" role="alert">Set a valid minimum and maximum target range.</p>}
            {!secondValid && hasSecondDimension && <p className="qp-visual-inline-error" role="alert">Choose two compatible, distinct category fields.</p>}
            {!scatterValid && mode==="scatter" && <p className="qp-visual-inline-error" role="alert">Select separate numeric fields for X, Y{chart==="bubble"?", and size":""}.</p>}
            {!comboValid && chart==="combo" && <p className="qp-visual-inline-error" role="alert">Combo charts require two different numeric fields.</p>}
            {missingDimension && <p className="qp-visual-inline-error" role="alert">{selected&&compatible(selected,fields)||"This combination is unavailable."}.</p>}
            <div className="qp-visual-section-heading qp-visual-config-heading"><div><span className="qp-visual-step">03</span><h3>Validate & preview</h3></div><p>Uses live, read-only data.</p></div>
            <div className="qp-visual-preview-box" aria-live="polite">
              {validating ? <div className="qp-visual-loading"><LoaderCircle size={18} className="spinning"/> Checking the selected fields and calculating the chart…</div>
              : preview ? <><div className="qp-visual-preview-status"><CheckCircle2 size={15}/> Verified with your connected dataset <small>{preview.data.points.length} result rows</small></div><Preview spec={preview.spec} data={preview.data}/></>
              : <div className="qp-visual-preview-placeholder"><BarChart3 size={27}/><strong>Preview your chart</strong><p>Run validation to confirm the field combination works with real data.</p></div>}
            </div>
            {error && <div className="qp-visual-error" role="alert"><span>{error}</span><small>Change the X/Y fields, calculation, chart type or filters and try again.</small></div>}
            {filters.length>0 && <p className="qp-visual-filter-note">Current dashboard filters ({filters.length}) will also apply to this visualization.</p>}
          </>}
      </div>
      <footer className="qp-visual-footer">
        <button type="button" className="qp-visual-cancel" onClick={onClose}>Cancel</button>
        {step==="configure" && chart && fields ? <>
          <button type="button" className="qp-visual-preview-button" disabled={!canPreview||validating} onClick={()=>void validate()}>{validating?<LoaderCircle size={15} className="spinning"/>:<Activity size={15}/>} {validating?"Validating…":"Preview"}</button>
          <button type="button" className="qp-visual-add-button" disabled={!canAdd} title={atLimit&&!initialSpec?"Maximum 12 dashboard panels":!preview?"Validate a preview first":"Add the chart"} onClick={addPanel}>{initialSpec?"Update panel":"Add to dashboard"} <ArrowRight size={16}/></button>
        </>:<span className="qp-visual-footer-hint"><ArrowRight size={14}/> Choose a chart to configure</span>}
      </footer>
    </aside>
  </div>;
}
