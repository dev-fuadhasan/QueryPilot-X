"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertCircle, LoaderCircle } from "lucide-react";
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
const colors = ["#2F4A63","#5B91A3","#8AB7C2","#96B9AE","#CFEAE0","#73859E"];
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
  if(!data?.points.length) return <div className="qp-panel-status">No matching data.</div>;
  const points=data.points;
  const measure=spec.aggregation==="count" ? "Records" : spec.aggregation+" "+(spec.metric||"");
  const linkable=Boolean(filterDimension && spec.dimension===filterDimension);
  const select=(value:string)=>{if(linkable && value) onSelectGroup(value);};
  if(spec.chart==="kpi") return <div className="qp-custom-kpi">
    <strong>{format(data.total)}</strong><span>{spec.description}</span>
  </div>;
  if(spec.chart==="table") return <div className="qp-evidence-scroll"><table>
    <thead><tr><th>{spec.dimension}</th><th>Records</th><th>{measure}</th></tr></thead>
    <tbody>{points.map((point,index)=><tr key={index} className={linkable?"qp-selectable-row":""} onClick={()=>select(point.label)}>
      <td>{point.label}</td><td>{format(point.records)}</td><td>{format(point.value)}</td>
    </tr>)}</tbody>
  </table></div>;
  if(spec.chart==="pie") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}><PieChart>
    <Pie data={points} nameKey="label" dataKey="value" innerRadius={50} outerRadius={94} cx="50%" cy="50%"
      onClick={item=>{const val=item as {name?:string;label?:string};select(val.label||val.name||"");}}>
      {points.map((p,index)=><Cell key={p.label+index} fill={colors[index%colors.length]}/>)}
    </Pie><Tooltip/>
  </PieChart></ResponsiveContainer><ChartCategoryLegend rows={points} onSelect={linkable ? select : undefined}/></div>;
  if(spec.chart==="line"||spec.chart==="area") return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}>
    {spec.chart==="area"
      ? <AreaChart data={points}><CartesianGrid strokeDasharray="3 3" stroke="#e6eeee"/><XAxis dataKey="label" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Area dataKey="value" name={measure} stroke="#2F4A63" fill="#CFEAE0" strokeWidth={2}/></AreaChart>
      : <LineChart data={points}><CartesianGrid strokeDasharray="3 3" stroke="#e6eeee"/><XAxis dataKey="label" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Line dataKey="value" name={measure} stroke="#2F4A63" dot={{r:3}} strokeWidth={2}/></LineChart>}
  </ResponsiveContainer></div>;
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
