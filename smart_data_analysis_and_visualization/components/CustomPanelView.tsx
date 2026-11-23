"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertCircle, LoaderCircle } from "lucide-react";
import SpecialVisual, { specialCharts } from "./SpecialVisuals";
import { CategoryTick, ChartCategoryLegend, FullCategoryLabels, ScrollableChart, categoryAxisWidth } from "./ReadableCharts";
import type { DashboardFilter, CustomPanelData, CustomPanelSpec } from "../lib/intelligence";

type Props = {
  table: string;
  spec: CustomPanelSpec;
  filterDimension: string | null;
  filters: DashboardFilter[];
  refreshVersion: number;
  onSelectGroup: (group: string) => void;
};
const colors = ["#2F4A63","#5B91A3","#CFEAE0","#131B2B"];
const format = (n:number|null) => n===null || !Number.isFinite(n) ? "—" :
  new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(n);

export default function CustomPanelView({table,spec,filterDimension,filters,refreshVersion,onSelectGroup}:Props) {
  const [data,setData]=useState<CustomPanelData|null>(null);
  const [loading,setLoading]=useState(true);
  const filterKey=JSON.stringify(filters);
  const [error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    if(!data) setLoading(true);
    setError("");
    fetch("/api/smart-dashboard-panel",{
      method:"POST",cache:"no-store",signal:controller.signal,
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"refresh",table,spec,filters})
    }).then(async response=>{
      const result=await response.json();
      if(!response.ok) throw new Error(result.error || "Could not calculate this panel.");
      return result.data as CustomPanelData;
    }).then(result=>{if(!controller.signal.aborted) setData(result);})
      .catch(problem=>{if(!controller.signal.aborted){setError(problem instanceof Error ? problem.message : "Panel calculation failed.");setData(null);}})
      .finally(()=>{if(!controller.signal.aborted) setLoading(false);});
    return ()=>controller.abort();
  },[table,spec,filterDimension,filterKey,refreshVersion]);

  if(loading && !data) return <div className="qp-panel-status"><LoaderCircle className="spinning" size={20}/> Calculating panel…</div>;
  if(error) return <div className="qp-panel-error" role="status"><AlertCircle size={18}/>{error}</div>;
  if(data && specialCharts.has(spec.chart)) return <SpecialVisual spec={spec} data={data}/>;
  if(!data?.points.length) return <div className="qp-panel-status">No matching data.</div>;
  const points=data.points;
  const measure=spec.aggregation==="count" ? "Records" : spec.aggregation+" "+(spec.metric||"");
  const linkable=Boolean(filterDimension && spec.dimension===filterDimension);
  const select=(value:string)=>{if(linkable && value) onSelectGroup(value);};
  if(spec.chart==="kpi") return <div className="qp-custom-kpi">
    <strong>{format(data.total)}</strong><span>{spec.description}</span>
  </div>;
  if(spec.chart==="gauge") {
    const minimum=spec.gaugeMin ?? 0;
    const maximum=spec.gaugeMax ?? 100;
    const value=data.total ?? 0;
    const progress=Math.max(0,Math.min(1,(value-minimum)/(maximum-minimum)));
    return <div className="qp-custom-gauge" role="img" aria-label={spec.title+": "+format(value)+" out of scale "+format(minimum)+" to "+format(maximum)}>
      <svg viewBox="0 0 260 170" aria-hidden="true" focusable="false">
        <path d="M35 135 A95 95 0 0 1 225 135" fill="none" stroke="#CFEAE0" strokeWidth="19" strokeLinecap="round"/>
        <path d="M35 135 A95 95 0 0 1 225 135" fill="none" stroke="#2F4A63" strokeWidth="19" strokeLinecap="round"
          pathLength="100" strokeDasharray={(progress*100)+" 100"}/>
        <text x="130" y="115" textAnchor="middle" fill="#131B2B" fontSize="31" fontWeight="750">{format(value)}</text>
        <text x="130" y="137" textAnchor="middle" fill="#5B91A3" fontSize="10">Current value</text>
        <text x="26" y="162" fill="#2F4A63" fontSize="11">{format(minimum)}</text>
        <text x="234" y="162" fill="#2F4A63" fontSize="11" textAnchor="end">{format(maximum)}</text>
      </svg>
      {value>maximum && <p>Above the configured target</p>}
      {value<minimum && <p>Below the configured scale</p>}
    </div>;
  }
  if(spec.chart==="table") return <div className="qp-evidence-scroll"><table>
    <thead><tr><th>{spec.dimension}</th><th>Records</th><th>{measure}</th></tr></thead>
    <tbody>{points.map((point,index)=><tr key={index} className={linkable?"qp-selectable-row":""} onClick={()=>select(point.label)}>
      <td>{point.label}</td><td>{format(point.records)}</td><td>{format(point.value)}</td>
    </tr>)}</tbody>
  </table></div>;
  if(spec.chart==="pie" || spec.chart==="donut") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}><PieChart>
    <Pie data={points} nameKey="label" dataKey="value" innerRadius={spec.chart==="donut" ? 55 : 0} outerRadius={94} cx="50%" cy="50%"
      onClick={item=>{const val=item as {name?:string;label?:string};select(val.label||val.name||"");}}>
      {points.map((p,index)=><Cell key={p.label+index} fill={colors[index%colors.length]}/>)}
    </Pie><Tooltip/>
  </PieChart></ResponsiveContainer><ChartCategoryLegend rows={points} onSelect={linkable ? select : undefined}/></div>;
  if(spec.chart==="radar") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={310}>
    <RadarChart data={points.slice(0,12)} outerRadius="70%">
      <PolarGrid stroke="#CFEAE0"/><PolarAngleAxis dataKey="label" tick={{fontSize:10,fill:"#2F4A63"}}/>
      <Radar dataKey="value" name={measure} stroke="#2F4A63" fill="#5B91A3" fillOpacity={.28} strokeWidth={2}/><Tooltip/>
    </RadarChart>
  </ResponsiveContainer><FullCategoryLabels labels={points.slice(0,12).map(point=>point.label)}/></div>;
  if(spec.chart==="line"||spec.chart==="area") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}>
    {spec.chart==="area"
      ? <AreaChart data={points}><CartesianGrid strokeDasharray="3 3" stroke="#e6eeee"/><XAxis dataKey="label" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Area dataKey="value" name={measure} stroke="#2F4A63" fill="#CFEAE0" strokeWidth={2}/></AreaChart>
      : <LineChart data={points}><CartesianGrid strokeDasharray="3 3" stroke="#e6eeee"/><XAxis dataKey="label" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Line dataKey="value" name={measure} stroke="#2F4A63" dot={{r:3}} strokeWidth={2}/></LineChart>}
  </ResponsiveContainer></div>;
  if(spec.chart==="column") return <div className="qp-chart-wrap qp-ranked-chart">
    <ScrollableChart minWidth={Math.max(550,points.length*62)}><ResponsiveContainer width="100%" height={320}>
      <BarChart data={points} margin={{top:10,right:16,bottom:60,left:0}}>
        <CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3" vertical={false}/>
        <XAxis dataKey="label" tick={{fontSize:10,fill:"#2F4A63"}} interval={0} angle={-30} textAnchor="end" height={70}/>
        <YAxis tick={{fontSize:10}}/><Tooltip/>
        <Bar dataKey="value" name={measure} fill="#5B91A3" radius={[5,5,0,0]}
          onClick={item=>{const row=item as {payload?:{label?:string}};select(row.payload?.label||"");}}/>
      </BarChart>
    </ResponsiveContainer></ScrollableChart>
    <FullCategoryLabels labels={points.map(point=>point.label)}/>
  </div>;
  const axisWidth=categoryAxisWidth(points.map(point=>point.label));
  return <div className="qp-chart-wrap qp-ranked-chart"><div className="qp-ranked-chart-viewport"><ScrollableChart minWidth={axisWidth+350}><ResponsiveContainer width="100%" height={Math.max(260,Math.min(30,points.length)*57)}>
    <BarChart data={points} layout="vertical" margin={{left:0,right:18}}>
      <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#e6eeee"/>
      <XAxis type="number" tick={{fontSize:10}}/>
      <YAxis dataKey="label" type="category" width={axisWidth} interval={0} tick={<CategoryTick width={axisWidth}/>} tickLine={false}/>
      <Tooltip/><Bar dataKey="value" name={measure} fill="#5B91A3" radius={[0,5,5,0]}
        onClick={item=>{const row=item as {payload?:{label?:string}};select(row.payload?.label||"");}}/>
    </BarChart>
  </ResponsiveContainer></ScrollableChart></div><FullCategoryLabels labels={points.map(point=>point.label)}/><p className="qp-chart-caption">Showing {points.length}{spec.resultLimit ? " of up to " + spec.resultLimit : ""} ranked categories, based on {measure.toLowerCase()}.</p></div>;
}
