"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis, ZAxis } from "recharts";
import type { CustomPanelData, CustomPanelSpec, VisualCell, VisualSample } from "../lib/intelligence";

const palette=["#2F4A63","#5B91A3","#CFEAE0","#131B2B"];
const number=(n:number)=>new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(n);
const short=(s:string)=>s.length>20?s.slice(0,19)+"…":s;
export const specialCharts=new Set([
 "bullet","progress","thermometer","grouped_bar","stacked_bar","stacked_100","lollipop",
 "stacked_area","sparkline","combo","treemap","waffle","histogram","box","density","violin",
 "scatter","bubble","heatmap","correlation","funnel","waterfall","slope","bump","parallel",
 "network","sankey","pivot"
]);

const clamp=(x:number,low:number,high:number)=>Math.max(low,Math.min(high,x));
const quantile=(a:number[],p:number)=>{
 const index=(a.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);
 return a[lo]+(a[hi]-a[lo])*(index-lo);
};
function seriesData(cells:VisualCell[],maxCategories=12,maxSeries=6) {
 const byCategory=new Map<string,number>(),bySeries=new Map<string,number>();
 for(const c of cells){
  byCategory.set(c.label,(byCategory.get(c.label)||0)+Math.abs(c.value));
  bySeries.set(c.series,(bySeries.get(c.series)||0)+Math.abs(c.value));
 }
 const categories=[...byCategory.entries()].sort((a,b)=>b[1]-a[1]).slice(0,maxCategories).map(a=>a[0]);
 const series=[...bySeries.entries()].sort((a,b)=>b[1]-a[1]).slice(0,maxSeries).map(a=>a[0]);
 const values=categories.map(label=>{
  const row:Record<string,string|number>={label};
  series.forEach((name,i)=>{row["s"+i]=cells.filter(c=>c.label===label&&c.series===name).reduce((v,c)=>v+c.value,0);});
  return row;
 });
 return {series,rows:values,categories};
}
function TimeSeries({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const cells=data.cells||[];
 const labels=[...new Set(cells.map(c=>c.label))].sort();
 const names=[...new Set(cells.map(c=>c.series))]
   .sort((a,b)=>cells.filter(c=>c.series===b).reduce((v,c)=>v+Math.abs(c.value),0)-cells.filter(c=>c.series===a).reduce((v,c)=>v+Math.abs(c.value),0)).slice(0,6);
 const shownLabels=spec.chart==="slope"&&labels.length>1?[labels[0],labels[labels.length-1]]:labels.slice(-30);
 const rows=shownLabels.map(label=>{
  const obj:Record<string,string|number>={label};
  names.forEach((name,i)=>obj["v"+i]=cells.filter(c=>c.label===label&&c.series===name).reduce((v,c)=>v+c.value,0));
  return obj;
 });
 if(spec.chart==="bump"){
  for(const row of rows){
   const sorted=names.map((_,i)=>i).sort((a,b)=>Number(row["v"+b])-Number(row["v"+a]));
   sorted.forEach((i,rank)=>row["v"+i]=rank+1);
  }
 }
 if(!rows.length)return <p className="qp-viz-note">No time-series values.</p>;
 return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={300}>
  {spec.chart==="stacked_area" ? <AreaChart data={rows}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/>
   <XAxis dataKey="label" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/>
   {names.map((name,i)=><Area key={name} name={name} dataKey={"v"+i} stackId="stack" stroke={palette[i%4]} fill={palette[i%4]} fillOpacity={.7}/>)}
  </AreaChart> : <LineChart data={rows}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/>
   <XAxis dataKey="label" tick={{fontSize:10}}/><YAxis reversed={spec.chart==="bump"} domain={spec.chart==="bump"?[1,names.length]:undefined} tick={{fontSize:10}}/><Tooltip/>
   {names.map((name,i)=><Line key={name} name={name} type="linear" dataKey={"v"+i} stroke={palette[i%4]} strokeWidth={2.4} dot={{r:2}}/>)}
  </LineChart>}
 </ResponsiveContainer><SeriesLegend names={names}/></div>;
}
function SeriesLegend({names}:{names:string[]}){
 return <div className="qp-viz-legend">{names.map((s,i)=><span key={s}><i style={{background:palette[i%4]}}/>{s}</span>)}</div>;
}
function Grouped({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}) {
 const raw=seriesData(data.cells||[],Math.min(spec.resultLimit||12,18),6);
 const isStack=spec.chart==="stacked_bar"||spec.chart==="stacked_100";
 const rows=raw.rows.map(row=>{
  if(spec.chart!=="stacked_100")return row;
  const total=raw.series.reduce((n,_,i)=>n+Number(row["s"+i]||0),0);
  const normalized:Record<string,string|number>={label:String(row.label)};
  raw.series.forEach((_,i)=>normalized["s"+i]=total>0?Number(row["s"+i]||0)/total*100:0);
  return normalized;
 });
 return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={Math.max(270,rows.length*27)}>
  <BarChart data={rows} margin={{left:14,right:12,bottom:35,top:12}}>
   <CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3" vertical={false}/>
   <XAxis dataKey="label" tick={{fontSize:9}} interval={0} angle={-24} textAnchor="end" height={66}/>
   <YAxis tick={{fontSize:10}}/><Tooltip/>
   {raw.series.map((name,i)=><Bar key={name} name={name} dataKey={"s"+i} fill={palette[i%4]} stackId={isStack?"combined":undefined} radius={isStack?0:4}/>)}
  </BarChart>
 </ResponsiveContainer><SeriesLegend names={raw.series}/>{data.cells?.length===240&&<p className="qp-viz-note">Showing up to 240 grouped combinations.</p>}</div>;
}
function Heatmap({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const {series,categories}=seriesData(data.cells||[],Math.min(spec.resultLimit||12,16),10);
 const cells=data.cells||[];
 const max=Math.max(1,...cells.map(c=>Math.abs(c.value)));
 return <div className="qp-viz-table-scroll"><table className="qp-viz-matrix"><thead><tr><th>{spec.dimension}</th>{series.map(s=><th key={s} title={s}>{short(s)}</th>)}</tr></thead>
  <tbody>{categories.map(a=><tr key={a}><th title={a}>{a}</th>{series.map(b=>{
   const value=cells.filter(c=>c.label===a&&c.series===b).reduce((n,c)=>n+c.value,0);
   return <td key={b} title={a+" / "+b+": "+number(value)} style={{background:value>=0?"rgba(91,145,163,"+(Math.abs(value)/max*.75+.07)+")":"rgba(47,74,99,"+(Math.abs(value)/max*.75+.07)+")"}}>{number(value)}</td>;
  })}</tr>)}</tbody></table></div>;
}
function Pivot({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const {series,categories}=seriesData(data.cells||[],Math.min(spec.resultLimit||12,16),10);
 const cells=data.cells||[],colTotals=series.map(()=>0);
 return <div className="qp-viz-table-scroll"><table className="qp-viz-matrix qp-viz-pivot"><thead><tr><th>{spec.dimension}</th>{series.map(s=><th key={s}>{short(s)}</th>)}<th>Total</th></tr></thead>
 <tbody>{categories.map(a=>{
  let total=0;
  return <tr key={a}><th>{a}</th>{series.map((b,i)=>{
   const v=cells.filter(c=>c.label===a&&c.series===b).reduce((n,c)=>n+c.value,0);
   colTotals[i]+=v;total+=v;
   return <td key={b}>{number(v)}</td>;
  })}<td><strong>{number(total)}</strong></td></tr>;
 })}</tbody><tfoot><tr><th>Total</th>{colTotals.map((v,i)=><td key={i}>{number(v)}</td>)}<td>{number(colTotals.reduce((a,b)=>a+b,0))}</td></tr></tfoot></table></div>;
}
function QuantileChart({data,kind}:{data:CustomPanelData;kind:"box"|"violin"}){
 const values=(data.samples||[]).map(s=>s.x).sort((a,b)=>a-b);
 if(values.length<5)return <p className="qp-viz-note">At least 5 numeric observations are needed.</p>;
 const min=values[0],max=values[values.length-1],q1=quantile(values,.25),median=quantile(values,.5),q3=quantile(values,.75);
 const low=Math.max(min,q1-1.5*(q3-q1)),high=Math.min(max,q3+1.5*(q3-q1));
 const scale=(v:number)=>300-(v-min)/(max-min||1)*235;
 if(kind==="box")return <div className="qp-viz-quantile"><svg role="img" aria-label="Box plot showing quartiles and outlier whiskers" viewBox="0 0 320 330">
  <line x1="160" y1={scale(low)} x2="160" y2={scale(high)} stroke="#131B2B" strokeWidth="2"/>
  <line x1="125" y1={scale(low)} x2="195" y2={scale(low)} stroke="#2F4A63" strokeWidth="3"/>
  <line x1="125" y1={scale(high)} x2="195" y2={scale(high)} stroke="#2F4A63" strokeWidth="3"/>
  <rect x="111" y={scale(q3)} width="98" height={Math.max(1,scale(q1)-scale(q3))} rx="6" fill="#CFEAE0" stroke="#2F4A63" strokeWidth="2"/>
  <line x1="111" y1={scale(median)} x2="209" y2={scale(median)} stroke="#131B2B" strokeWidth="4"/>
  {values.filter(v=>v<low||v>high).slice(0,40).map((v,i)=><circle key={i} cx={136+(i%5)*11} cy={scale(v)} r="3" fill="#5B91A3"/>)}
  {[0,.25,.5,.75,1].map(p=><g key={p}><line x1="60" x2="75" y1={scale(min+(max-min)*p)} y2={scale(min+(max-min)*p)} stroke="#5B91A3"/><text x="53" y={scale(min+(max-min)*p)+4} textAnchor="end" fontSize="10" fill="#2F4A63">{number(min+(max-min)*p)}</text></g>)}
 </svg><p>Q1 {number(q1)} · Median {number(median)} · Q3 {number(q3)}</p></div>;
 const sampleGrid=Array.from({length:64},(_,i)=>min+(max-min)*(i/63));
 const sd=Math.sqrt(values.reduce((n,v)=>n+(v-median)**2,0)/values.length);
 const bandwidth=Math.max((max-min)/75,1.06*sd*Math.pow(values.length,-.2),1e-6);
 const densities=sampleGrid.map(v=>values.reduce((n,point)=>n+Math.exp(-.5*((v-point)/bandwidth)**2),0));
 const maxD=Math.max(...densities)||1;
 const left=sampleGrid.map((v,i)=>[160-90*densities[i]/maxD,scale(v)]);
 const right=sampleGrid.map((v,i)=>[160+90*densities[i]/maxD,scale(v)]).reverse();
 const path=[...left,...right].map((p,i)=>(i===0?"M":"L")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ")+" Z";
 return <div className="qp-viz-quantile"><svg viewBox="0 0 320 330" role="img" aria-label="Kernel density violin plot"><path d={path} fill="#CFEAE0" stroke="#2F4A63" strokeWidth="2"/><line x1="140" x2="180" y1={scale(median)} y2={scale(median)} stroke="#131B2B" strokeWidth="3"/></svg><p>Median {number(median)} · {values.length} observations</p></div>;
}
function Distribution({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const samples=(data.samples||[]).map(p=>p.x).filter(Number.isFinite).sort((a,b)=>a-b);
 if(spec.chart==="box"||spec.chart==="violin")return <QuantileChart data={data} kind={spec.chart}/>;
 const min=samples[0],max=samples[samples.length-1];
 const bins=Math.max(5,Math.min(24,Math.ceil(Math.sqrt(samples.length))));
 const width=(max-min||1)/bins;
 const counts=Array.from({length:bins},()=>0);
 samples.forEach(v=>{const idx=Math.min(bins-1,Math.floor((v-min)/width));counts[idx]++;});
 if(spec.chart==="histogram"){
  const rows=counts.map((value,i)=>({label:number(min+width*i),value}));
  return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={285}>
  <BarChart data={rows} barCategoryGap={0} margin={{bottom:8,left:0,right:8}}><CartesianGrid stroke="#CFEAE0"/><XAxis dataKey="label" tick={{fontSize:9}} interval="preserveStartEnd"/><YAxis tick={{fontSize:10}}/><Tooltip/><Bar dataKey="value" name="Frequency" fill="#5B91A3"/></BarChart></ResponsiveContainer>
  <p className="qp-viz-note">Distribution based on a sample of {samples.length} numeric rows.</p></div>;
 }
 const n=samples.length,mean=samples.reduce((a,b)=>a+b,0)/n;
 const sd=Math.sqrt(samples.reduce((a,v)=>a+(v-mean)**2,0)/(n-1||1));
 const bandwidth=Math.max((max-min)/70,1.06*sd*Math.pow(n,-.2),1e-6);
 const rows=Array.from({length:80},(_,i)=>{
  const x=min+(max-min)*(i/79);
  const density=samples.reduce((sum,v)=>sum+Math.exp(-.5*((x-v)/bandwidth)**2),0)/(n*bandwidth*Math.sqrt(2*Math.PI));
  return {label:number(x),density};
 });
 return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={280}><AreaChart data={rows}><CartesianGrid stroke="#CFEAE0"/><XAxis dataKey="label" tick={{fontSize:9}} interval="preserveStartEnd"/><YAxis tick={{fontSize:9}}/><Tooltip/><Area dataKey="density" name="Estimated density" stroke="#2F4A63" fill="#CFEAE0" strokeWidth={2} dot={false}/></AreaChart></ResponsiveContainer>
  <p className="qp-viz-note">Kernel density estimate from {samples.length} sampled observations.</p></div>;
}
function BubbleScatter({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const rows=(data.samples||[]).map(v=>({x:v.x,y:v.y,z:Math.max(0,v.size??1)}));
 return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={300}>
  <ScatterChart margin={{left:8,right:20,bottom:14,top:20}}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/>
  <XAxis type="number" dataKey="x" name={spec.xMetric||"X"} tick={{fontSize:10}}/><YAxis type="number" dataKey="y" name={spec.metric||"Y"} tick={{fontSize:10}}/>
  {spec.chart==="bubble"&&<ZAxis dataKey="z" type="number" range={[25,420]} name={spec.sizeMetric||"Size"}/>}
  <Tooltip cursor={{strokeDasharray:"3 3"}}/><Scatter data={rows} fill="#5B91A3" fillOpacity={.63}/>
  </ScatterChart>
 </ResponsiveContainer><p className="qp-viz-note">{rows.length} sampled numeric observations.</p></div>;
}
function Correlation({data}:{data:CustomPanelData}){
 const columns=data.columns||[];
 const samples=(data.samples||[]).map(s=>s.values||[]);
 const corr=(i:number,j:number)=>{
  const n=samples.length,a=samples.map(v=>v[i]),b=samples.map(v=>v[j]);
  const meanA=a.reduce((x,y)=>x+y,0)/n,meanB=b.reduce((x,y)=>x+y,0)/n;
  const cov=a.reduce((sum,x,k)=>sum+(x-meanA)*(b[k]-meanB),0);
  const sa=Math.sqrt(a.reduce((s,x)=>s+(x-meanA)**2,0));
  const sb=Math.sqrt(b.reduce((s,x)=>s+(x-meanB)**2,0));
  return sa&&sb?cov/(sa*sb):null;
 };
 return <div className="qp-viz-table-scroll"><table className="qp-viz-matrix"><thead><tr><th>Correlation</th>{columns.map(c=><th key={c}>{short(c)}</th>)}</tr></thead>
 <tbody>{columns.map((a,i)=><tr key={a}><th>{a}</th>{columns.map((b,j)=>{
  const r=corr(i,j);
  return <td key={b} title={a+" vs "+b} style={{
    backgroundColor:r===null?"#CFEAE0":r>=0?"rgba(91,145,163,"+(.08+Math.abs(r)*.85)+")":"rgba(47,74,99,"+(.08+Math.abs(r)*.85)+")",
    color:r!==null&&Math.abs(r)>.65?"#fff":"#131B2B"
  }}>{r===null?"—":r.toFixed(2)}</td>;
 })}</tr>)}</tbody></table><p className="qp-viz-note">Pearson correlations from {samples.length} complete sampled rows; constant columns show an undefined correlation.</p></div>;
}
function Parallel({data}:{data:CustomPanelData}){
 const names=data.columns||[],samples=(data.samples||[]).slice(0,55);
 const stats=names.map((_,i)=>({min:Math.min(...samples.map(s=>s.values?.[i]??0)),max:Math.max(...samples.map(s=>s.values?.[i]??0))}));
 const x=(i:number)=>50+i*520/Math.max(1,names.length-1);
 const y=(i:number,value:number)=>45+230*(1-(value-stats[i].min)/(stats[i].max-stats[i].min||1));
 return <div className="qp-viz-chart"><svg viewBox="0 0 630 330" role="img" aria-label="Parallel coordinates comparing multiple numeric fields">
 {names.map((name,i)=><g key={name}><line x1={x(i)} y1="45" x2={x(i)} y2="275" stroke="#2F4A63" strokeWidth="1.2"/><text x={x(i)} y="305" fontSize="10" fill="#131B2B" textAnchor="middle">{short(name)}</text></g>)}
 {samples.map((s,i)=><polyline key={i} points={(s.values||[]).map((v,j)=>x(j)+","+y(j,v)).join(" ")} fill="none" stroke={palette[i%4]} strokeWidth="1.6" opacity=".34"/>)}
 </svg><p className="qp-viz-note">{samples.length} sampled records; each axis normalized independently.</p></div>;
}
function Network({data}:{data:CustomPanelData}){
 const cells=(data.cells||[]).slice(0,60).filter(c=>c.value>0);
 const left=[...new Set(cells.map(c=>c.label))].slice(0,9),right=[...new Set(cells.map(c=>c.series))].slice(0,9);
 const y=(i:number,n:number)=>25+(i+.5)*295/n;
 const max=Math.max(1,...cells.map(c=>c.value));
 return <div className="qp-viz-chart"><svg viewBox="0 0 640 360" role="img" aria-label="Bipartite network linking two categorical fields">
 {cells.map((c,i)=>{
  const a=left.indexOf(c.label),b=right.indexOf(c.series);if(a<0||b<0)return null;
  return <line key={i} x1="174" y1={y(a,left.length)} x2="465" y2={y(b,right.length)} stroke="#5B91A3" strokeWidth={1+5*c.value/max} opacity=".32"/>;
 })}
 {left.map((name,i)=><g key={name}><circle cx="174" cy={y(i,left.length)} r="7" fill="#2F4A63"/><text x="160" y={y(i,left.length)+3} fontSize="10" textAnchor="end" fill="#131B2B">{short(name)}</text></g>)}
 {right.map((name,i)=><g key={name}><circle cx="465" cy={y(i,right.length)} r="7" fill="#5B91A3"/><text x="480" y={y(i,right.length)+3} fontSize="10" fill="#131B2B">{short(name)}</text></g>)}
 </svg><p className="qp-viz-note">Links show positive aggregated relationships between the selected fields.</p></div>;
}
function SankeyLike({data}:{data:CustomPanelData}){
 const cells=(data.cells||[]).filter(c=>c.value>0).slice(0,80);
 const left=[...new Set(cells.map(c=>c.label))].slice(0,8),right=[...new Set(cells.map(c=>c.series))].slice(0,8);
 const total=Math.max(1,cells.reduce((s,c)=>s+c.value,0));
 const sourceTotal=left.map(s=>cells.filter(c=>c.label===s).reduce((n,c)=>n+c.value,0));
 const targetTotal=right.map(s=>cells.filter(c=>c.series===s).reduce((n,c)=>n+c.value,0));
 const positions=(values:number[])=>{let y=25;return values.map(v=>{const h=Math.max(8,285*v/total);const answer={y,h};y+=h+8;return answer;});};
 const l=positions(sourceTotal),r=positions(targetTotal);
 return <div className="qp-viz-chart"><svg viewBox="0 0 680 370" role="img" aria-label="Flow diagram connecting two categorical stages">
 {cells.map((c,i)=>{
  const a=left.indexOf(c.label),b=right.indexOf(c.series);if(a<0||b<0)return null;
  const y1=l[a].y+l[a].h/2,y2=r[b].y+r[b].h/2;
  return <path key={i} d={"M 175 "+y1+" C 320 "+y1+" 360 "+y2+" 505 "+y2} stroke={palette[a%4]} strokeWidth={Math.max(1,20*c.value/total)} opacity=".42" fill="none"/>;
 })}
 {left.map((name,i)=><g key={name}><rect x="153" y={l[i].y} width="22" height={l[i].h} rx="3" fill={palette[i%4]}/><text x="145" y={l[i].y+l[i].h/2+3} textAnchor="end" fontSize="10" fill="#131B2B">{short(name)}</text></g>)}
 {right.map((name,i)=><g key={name}><rect x="505" y={r[i].y} width="22" height={r[i].h} rx="3" fill={palette[i%4]}/><text x="535" y={r[i].y+r[i].h/2+3} fontSize="10" fill="#131B2B">{short(name)}</text></g>)}
 </svg><p className="qp-viz-note">Flow width reflects positive aggregated values. Links indicate category relationships, not proven chronological transitions.</p></div>;
}
function Lollipop({data}:{data:CustomPanelData}){
 const points=data.points.slice(0,14);
 const min=Math.min(0,...points.map(p=>p.value)),max=Math.max(0,...points.map(p=>p.value));
 const x=(v:number)=>175+(v-min)/(max-min||1)*415;
 return <div className="qp-viz-chart"><svg viewBox={"0 0 650 "+(points.length*28+36)} role="img" aria-label="Lollipop category ranking">
 <line x1={x(0)} x2={x(0)} y1="10" y2={points.length*28+12} stroke="#CFEAE0" strokeWidth="2"/>
 {points.map((p,i)=><g key={i}><text x="164" y={25+i*28} textAnchor="end" fontSize="11" fill="#2F4A63">{short(p.label)}</text><line x1={x(0)} y1={21+i*28} x2={x(p.value)} y2={21+i*28} stroke="#5B91A3" strokeWidth="3"/><circle cx={x(p.value)} cy={21+i*28} r="6" fill="#131B2B"/><title>{p.label}: {number(p.value)}</title></g>)}
 </svg></div>;
}
function Funnel({data}:{data:CustomPanelData}){
 const points=data.points.slice(0,9);
 const max=Math.max(...points.map(p=>p.value),1);
 return <div className="qp-viz-chart"><svg viewBox={"0 0 640 "+(points.length*55+24)} role="img" aria-label="Funnel chart of category stage volumes">
 {points.map((p,i)=>{const w=170+385*p.value/max,left=(640-w)/2,y=9+i*55;
 return <g key={i}><path d={"M "+left+" "+y+" H "+(left+w)+" L "+(left+w-20)+" "+(y+45)+" H "+(left+20)+" Z"} fill={palette[i%4]} opacity=".85"/><text x="320" y={y+24} textAnchor="middle" fill={i%4===2?"#131B2B":"#fff"} fontSize="12" fontWeight="700">{short(p.label)} · {number(p.value)}</text></g>;})}
 </svg><p className="qp-viz-note">Stages ranked by aggregated size; choose a meaningful stage-order field for funnel analysis.</p></div>;
}
function Waterfall({data}:{data:CustomPanelData}){
 const points=data.points.slice(0,14);
 let sum=0;
 const bars=points.map(p=>{const start=sum;sum+=p.value;return {...p,start,end:sum};});
 const min=Math.min(0,...bars.flatMap(p=>[p.start,p.end]));
 const max=Math.max(0,...bars.flatMap(p=>[p.start,p.end]));
 const y=(value:number)=>310-(value-min)/(max-min||1)*260;
 const step=550/Math.max(1,bars.length);
 return <div className="qp-viz-chart"><svg viewBox="0 0 650 360" role="img" aria-label="Waterfall bridge of signed category contributions">
 <line x1="48" x2="610" y1={y(0)} y2={y(0)} stroke="#2F4A63" strokeWidth="1.2"/>
 {bars.map((b,i)=>{const top=Math.min(y(b.start),y(b.end)),height=Math.max(1,Math.abs(y(b.start)-y(b.end)));const x=55+i*step;
 return <g key={i}><rect x={x} y={top} width={Math.max(12,step-7)} height={height} rx="2" fill={b.value>=0?"#5B91A3":"#2F4A63"}/><text x={x+(step-7)/2} y="342" textAnchor="middle" fontSize="9" fill="#2F4A63">{short(b.label).slice(0,9)}</text><title>{b.label}: {number(b.value)}, cumulative {number(b.end)}</title></g>;})}
 </svg><p className="qp-viz-note">Cumulative total: {number(sum)}. Categories are arranged by the selected sort order.</p></div>;
}
function TreemapView({data}:{data:CustomPanelData}){
 const points=data.points.slice(0,20).map(p=>({name:p.label,size:p.value}));
 return <div className="qp-viz-chart" style={{height:300}}><ResponsiveContainer width="100%" height="100%"><Treemap data={points} dataKey="size" nameKey="name" aspectRatio={4/3} stroke="#fff" fill="#5B91A3"><Tooltip/></Treemap></ResponsiveContainer></div>;
}
function Waffle({data}:{data:CustomPanelData}){
 const points=data.points.filter(p=>p.value>0).slice(0,5);
 const total=points.reduce((n,p)=>n+p.value,0);
 const cumulative=points.map((p,i)=>points.slice(0,i+1).reduce((n,r)=>n+r.value,0)/total*100);
 return <div className="qp-viz-chart"><div className="qp-viz-waffle" role="img" aria-label="One hundred squares showing category proportions">
 {Array.from({length:100},(_,i)=>{const idx=cumulative.findIndex(p=>i<p);return <span key={i} style={{background:palette[Math.max(idx,0)%4]}}/>;})}
 </div><SeriesLegend names={points.map(p=>p.label)}/></div>;
}
function ScalarProgress({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}){
 const value=data.total||0,min=spec.gaugeMin||0,max=spec.gaugeMax||100;
 const pct=clamp((value-min)/(max-min||1)*100,0,100);
 if(spec.chart==="thermometer")return <div className="qp-viz-thermometer" role="img" aria-label={number(value)+" on a scale "+number(min)+" to "+number(max)}>
  <div className="qp-viz-thermo-track"><span style={{height:pct+"%"}}/></div><strong>{number(value)}</strong><small>Range {number(min)} — {number(max)}</small></div>;
 return <div className="qp-viz-scalar"><strong>{number(value)}</strong><span>{spec.description}</span><div className={"qp-viz-progress-track"+(spec.chart==="bullet"?" bullet":"")}>
 <div style={{width:pct+"%"}}/>{spec.chart==="bullet"&&<i style={{left:"96%"}}/>}</div>
 <div className="qp-viz-scalar-ends"><span>{number(min)}</span><span>Target {number(max)}</span></div>
 {value>max&&<p>Value exceeds the selected target.</p>}{value<min&&<p>Value is below the selected range.</p>}
 </div>;
}
export default function SpecialVisual({spec,data}:{spec:CustomPanelSpec;data:CustomPanelData}) {
 if(["bullet","progress","thermometer"].includes(spec.chart))return <ScalarProgress spec={spec} data={data}/>;
 if(["grouped_bar","stacked_bar","stacked_100"].includes(spec.chart))return <Grouped spec={spec} data={data}/>;
 if(["stacked_area","slope","bump"].includes(spec.chart))return <TimeSeries spec={spec} data={data}/>;
 if(spec.chart==="heatmap")return <Heatmap spec={spec} data={data}/>;
 if(spec.chart==="pivot")return <Pivot spec={spec} data={data}/>;
 if(spec.chart==="network")return <Network data={data}/>;
 if(spec.chart==="sankey")return <SankeyLike data={data}/>;
 if(spec.chart==="lollipop")return <Lollipop data={data}/>;
 if(spec.chart==="waterfall")return <Waterfall data={data}/>;
 if(spec.chart==="funnel")return <Funnel data={data}/>;
 if(spec.chart==="treemap")return <TreemapView data={data}/>;
 if(spec.chart==="waffle")return <Waffle data={data}/>;
 if(["histogram","box","violin","density"].includes(spec.chart))return <Distribution spec={spec} data={data}/>;
 if(["scatter","bubble"].includes(spec.chart))return <BubbleScatter spec={spec} data={data}/>;
 if(spec.chart==="correlation")return <Correlation data={data}/>;
 if(spec.chart==="parallel")return <Parallel data={data}/>;
 if(spec.chart==="sparkline")return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={135}><LineChart data={data.points}><Tooltip/><Line type="monotone" dataKey="value" stroke="#2F4A63" strokeWidth={2.5} dot={false}/></LineChart></ResponsiveContainer><p className="qp-viz-note">Tiny trend across {data.points.length} periods.</p></div>;
 if(spec.chart==="combo")return <div className="qp-viz-chart"><ResponsiveContainer width="100%" height={290}><ComposedChart data={data.points}><CartesianGrid stroke="#CFEAE0" strokeDasharray="3 3"/><XAxis dataKey="label" tick={{fontSize:10}}/><YAxis yAxisId="left" tick={{fontSize:10}}/><YAxis yAxisId="right" orientation="right" tick={{fontSize:10}}/><Tooltip/><Bar name={spec.metric||"Measure 1"} dataKey="value" yAxisId="left" fill="#5B91A3"/><Line name={spec.secondaryMetric||"Measure 2"} dataKey="secondValue" yAxisId="right" stroke="#131B2B" strokeWidth={2} dot={{r:2}}/></ComposedChart></ResponsiveContainer></div>;
 return <p className="qp-viz-note">This visualization has no supported renderer.</p>;
}
