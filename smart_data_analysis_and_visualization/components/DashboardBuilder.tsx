"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowDown, ArrowUp, BarChart3, Check, Database, Download, Expand, GripVertical, LineChart as LineChartIcon, LoaderCircle, Pencil, PieChart as PieChartIcon, Plus, RotateCcw, Save, Sigma, Table2, Trash2, Sparkles, AlertCircle, CheckCircle2, X } from "lucide-react";
import CustomPanelView from "./CustomPanelView";
import { CategoryTick, ChartCategoryLegend, FullCategoryLabels, ScrollableChart, categoryAxisWidth } from "./ReadableCharts";
import type { DashboardPanel, DashboardPanelKind, GroupPoint, InvestigationBundle, OverviewData, TrendPoint } from "../lib/intelligence";

type Props = {
  bundle: InvestigationBundle;
  projectRef: string;
  overview: OverviewData;
  drivers: GroupPoint[];
  trend: TrendPoint[];
  selectedGroup: string | null;
  onSelectGroup: (value: string | null) => void;
  filterBusy: boolean;
  filterError: string;
};
const colors = ["#2F4A63", "#5B91A3", "#8AB7C2", "#96B9AE", "#CFEAE0", "#73859E", "#A9C8BA"];
const panelKinds: { value: DashboardPanelKind; label: string }[] = [
  { value: "kpi", label: "KPI overview" },
  { value: "trend", label: "Time-series chart" },
  { value: "drivers", label: "Category breakdown" },
  { value: "mix", label: "Category share" },
  { value: "table", label: "Data evidence table" }
];
function format(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, notation: Math.abs(value) >= 1000000 ? "compact" : "standard" }).format(value);
}
function defaultPanels(bundle: InvestigationBundle): DashboardPanel[] {
  const panels: DashboardPanel[] = [
    { id: "metrics", kind: "kpi", title: "Performance snapshot", wide: true, chart: "bar" }
  ];
  if (bundle.trend?.length) panels.push({ id: "trend", kind: "trend", title: "Performance over time", wide: false, chart: "line" });
  if (bundle.drivers?.length) {
    panels.push({ id: "drivers", kind: "drivers", title: "Category performance", wide: false, chart: "bar" });
    panels.push({ id: "mix", kind: "mix", title: "Contribution by category", wide: false, chart: "pie" });
  }
  panels.push({ id: "table", kind: "table", title: "Supporting evidence", wide: true, chart: "bar" });
  return panels;
}
export default function DashboardBuilder({ bundle, projectRef, overview, drivers, trend, selectedGroup, onSelectGroup, filterBusy, filterError }: Props) {
  const { plan } = bundle;
  const storageKey = "querypilot:dashboard-layout:" + projectRef + ":" + plan.table;
  const [title, setTitle] = useState("Dashboard");
  const [draftTitle, setDraftTitle] = useState("Dashboard");
  const [editingTitle, setEditingTitle] = useState(false);
  const [panels, setPanels] = useState<DashboardPanel[]>(() => defaultPanels(bundle));
  const [customPrompt, setCustomPrompt] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{message:string;type:"error"|"success"}|null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(false);
    setPanels(defaultPanels(bundle));
    setTitle("Dashboard");
    setDraftTitle("Dashboard");
    setEditingTitle(false);
    try {
      const value = localStorage.getItem(storageKey);
      if (value) {
        const stored: unknown = JSON.parse(value);
        if (stored && typeof stored === "object") {
          const item = stored as { title?: unknown; panels?: unknown };
          if (typeof item.title === "string" && item.title.length < 110) { setTitle(item.title); setDraftTitle(item.title); }
          if (Array.isArray(item.panels)) {
            const good: DashboardPanel[] = item.panels.filter(panel =>
              panel && typeof panel.id === "string" && typeof panel.title === "string" &&
              (panelKinds.some(kind => kind.value === panel.kind) ||
                (panel.kind === "custom" && panel.spec && typeof panel.spec.title === "string" && ["kpi","bar","line","area","pie","table"].includes(panel.spec.chart))) &&
              ["bar", "line", "area", "pie"].includes(panel.chart) &&
              typeof panel.wide === "boolean"
            ).slice(0, 12);
            if (good.length) setPanels(good);
          }
        }
      }
    } catch { /* Browser storage may be disabled */ }
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ title, panels }));
    } catch { /* Dashboard remains usable without browser storage */ }
  }, [loaded, storageKey, title, panels]);

  function editPanel(id: string, updates: Partial<DashboardPanel>) {
    setPanels(items => items.map(panel => panel.id === id ? { ...panel, ...updates } : panel));
  }
  function shiftPanel(id: string, offset: number) {
    setPanels(items => {
      const index = items.findIndex(panel => panel.id === id);
      const to = index + offset;
      if (index < 0 || to < 0 || to >= items.length) return items;
      const updated = [...items];
      const [current] = updated.splice(index, 1);
      updated.splice(to, 0, current);
      return updated;
    });
  }
  function dropPanel(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    setPanels(items => {
      const from = items.findIndex(item => item.id === draggingId);
      const to = items.findIndex(item => item.id === targetId);
      if (from < 0 || to < 0) return items;
      const moved = [...items];
      const [panel] = moved.splice(from, 1);
      moved.splice(to, 0, panel);
      return moved;
    });
    setDraggingId(null);
  }
  useEffect(()=>{
    if (!toast) return;
    const timer=window.setTimeout(()=>setToast(null),6500);
    return ()=>window.clearTimeout(timer);
  },[toast]);

  async function createCustomPanel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customPrompt.trim() || creating) return;
    if (panels.length>=12) {
      setToast({type:"error",message:"Maximum 12 panels. Remove one to create another."});
      return;
    }
    setCreating(true);
    try {
      const response=await fetch("/api/smart-dashboard-panel",{
        method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"create",table:plan.table,prompt:customPrompt.trim(),
          title:customTitle.trim()||undefined,filterDimension:plan.dimension,filterValue:selectedGroup})
      });
      const result=await response.json();
      if (!response.ok) throw new Error(result.error || "This dataset cannot create the requested panel.");
      if (!result.spec || !Array.isArray(result.data?.points)) throw new Error("Panel could not be verified.");
      setPanels(current=>[...current,{id:"panel-"+Date.now()+"-"+Math.random().toString(36).slice(2,6),
        kind:"custom",title:result.spec.title,wide:false,chart:"bar",spec:result.spec}]);
      setCustomPrompt("");
      setCustomTitle("");
      setToast({type:"success",message:"Your custom panel has been created."});
    } catch (problem) {
      setToast({type:"error",message:problem instanceof Error ? problem.message : "Unable to create panel."});
    } finally { setCreating(false); }
  }
  function saveDashboardTitle() {
    const value = draftTitle.trim();
    if (!value) {
      setToast({type:"error",message:"Please enter a dashboard name."});
      return;
    }
    setTitle(value);
    setEditingTitle(false);
    setToast({type:"success",message:"Dashboard name saved."});
  }
  function saveLayout() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({title,panels}));
      setToast({type:"success",message:"Dashboard layout saved in this browser."});
    } catch {
      setToast({type:"error",message:"Unable to save the layout in this browser."});
    }
  }
  function resetLayout() {
    const defaults = defaultPanels(bundle);
    setPanels(defaults);
    setTitle("Dashboard");
    setDraftTitle("Dashboard");
    setEditingTitle(false);
    onSelectGroup(null);
    setToast({type:"success",message:"Dashboard layout reset to its default cards."});
  }
  const globalGroups = bundle.drivers || [];
  const canTrend = (bundle.trend || []).length > 0;
  const label = plan.metric ? plan.metric.replace(/_/g, " ") : "record count";
  const metricValue = (point: GroupPoint | TrendPoint) => point.value;
  function renderPanel(panel: DashboardPanel) {
    if (panel.kind === "custom" && panel.spec) return <CustomPanelView table={plan.table} spec={panel.spec} filterDimension={plan.dimension} selectedGroup={selectedGroup} onSelectGroup={onSelectGroup}/>;
    if (panel.kind === "kpi") {
      return <div className="qp-kpi-grid">
        <div className="qp-kpi-card">
          <div className="qp-kpi-card-top"><span>Total records</span><span className="qp-kpi-card-icon"><Database size={17}/></span></div>
          <strong>{format(overview.records)}</strong>
          <small>{selectedGroup ? "Selected segment" : "Current dataset"}</small>
        </div>
        <div className="qp-kpi-card">
          <div className="qp-kpi-card-top"><span>{plan.metric ? "Total " + label : "Analyzed records"}</span><span className="qp-kpi-card-icon"><Sigma size={17}/></span></div>
          <strong>{format(plan.metric ? overview.total : overview.records)}</strong>
          <small>{plan.metric ? "Aggregated metric" : "Record count"}</small>
        </div>
        <div className="qp-kpi-card">
          <div className="qp-kpi-card-top"><span>{plan.metric ? "Average " + label : "Connected columns"}</span><span className="qp-kpi-card-icon"><Activity size={17}/></span></div>
          <strong>{format(plan.metric ? overview.average : plan.columnCount)}</strong>
          <small>{plan.metric ? "Per non-null observation" : "Schema fields"}</small>
        </div>
      </div>;
    }
    if (panel.kind === "trend") {
      if (!trend.length) return <p className="qp-chart-empty">No usable date column or dated observations. Choose a dataset with a date field to enable trends.</p>;
      return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}>
        {panel.chart === "area"
          ? <AreaChart data={trend}><CartesianGrid stroke="#edf3f2" strokeDasharray="3 3"/><XAxis dataKey="period" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Area dataKey="value" name={label} fill="#CFEAE0" stroke="#2F4A63" strokeWidth={2.5}/></AreaChart>
          : <LineChart data={trend}><CartesianGrid stroke="#edf3f2" strokeDasharray="3 3"/><XAxis dataKey="period" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip/><Line dataKey="value" name={label} stroke="#2F4A63" strokeWidth={2.5} dot={{r:3}}/></LineChart>}
      </ResponsiveContainer></div>;
    }
    if (panel.kind === "drivers") {
      if (!drivers.length) return <p className="qp-chart-empty">No categorical breakdown is available for this dataset.</p>;
      const axisWidth = categoryAxisWidth(drivers.map(item => item.label));
      return <><div className="qp-chart-wrap"><ScrollableChart minWidth={axisWidth + 340}><ResponsiveContainer width="100%" height={Math.max(260, Math.min(drivers.length, 10) * 58)}>
        <BarChart data={drivers.slice(0, 10)} layout="vertical" margin={{left:4,right:14}}>
          <CartesianGrid stroke="#edf3f2" strokeDasharray="3 3" horizontal={false}/>
          <XAxis type="number" tick={{fontSize:10}}/>
          <YAxis type="category" dataKey="label" width={axisWidth} interval={0} tick={<CategoryTick width={axisWidth}/>} tickLine={false}/>
          <Tooltip/>
          <Bar dataKey="value" name={label} fill="#5B91A3" radius={[0,5,5,0]}
            onClick={(entry) => {
              const data = entry as { payload?: { label?: string } };
              if (data.payload?.label) onSelectGroup(data.payload.label);
            }}
          />
        </BarChart>
      </ResponsiveContainer></ScrollableChart><FullCategoryLabels labels={drivers.slice(0, 10).map(item => item.label)}/></div><p className="qp-chart-caption">Select a bar to filter the connected metrics and time series.</p></>;
    }
    if (panel.kind === "mix") {
      if (!drivers.length) return <p className="qp-chart-empty">No category breakdown is available.</p>;
      if (drivers.some(item => item.value < 0) || drivers.every(item => item.value === 0)) {
        return <p className="qp-chart-empty">A share chart requires non-negative values with a positive total.</p>;
      }
      return <div className="qp-chart-wrap"><ResponsiveContainer width="100%" height={260}><PieChart>
        <Pie data={drivers.slice(0, 8)} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={62} outerRadius={100} paddingAngle={2}
          onClick={item => {
            const point = item as { label?: string; name?: string };
            const value = point.label || point.name;
            if (value) onSelectGroup(value);
          }}
        >
          {drivers.slice(0, 8).map((item, index) => <Cell key={item.label + index} fill={colors[index % colors.length]}/>)}
        </Pie><Tooltip/>
      </PieChart></ResponsiveContainer><ChartCategoryLegend rows={drivers.slice(0, 8)} onSelect={value => onSelectGroup(value)}/></div>;
    }
    return <div className="qp-evidence-scroll"><table><thead><tr><th>{plan.dimension || "Group"}</th><th>Records</th><th>{label}</th></tr></thead>
      <tbody>{drivers.length ? drivers.map((item, index) => <tr key={item.label + index} onClick={() => onSelectGroup(item.label)} className="qp-selectable-row"><td>{item.label}</td><td>{format(item.records)}</td><td>{format(metricValue(item))}</td></tr>)
        : <tr><td>All records</td><td>{format(overview.records)}</td><td>{format(plan.metric ? overview.total : overview.records)}</td></tr>}</tbody>
    </table></div>;
  }
  return <section className="qp-dashboard-builder">
    <div className="qp-dash-titlebar">
      <div className="qp-dash-title-content">
        <div className="qp-dash-title-row">
          {editingTitle ? (
            <>
              <input aria-label="Dashboard title" className="qp-dashboard-title qp-title-edit" maxLength={90}
                autoFocus value={draftTitle} onChange={event => setDraftTitle(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter") { event.preventDefault(); saveDashboardTitle(); }
                  if (event.key === "Escape") { setEditingTitle(false); setDraftTitle(title); }
                }}/>
              <button type="button" className="qp-title-icon-button qp-title-save" aria-label="Save dashboard name" title="Save name" onClick={saveDashboardTitle}><Check size={15}/></button>
              <button type="button" className="qp-title-icon-button" aria-label="Cancel editing dashboard name" title="Cancel" onClick={() => {setDraftTitle(title); setEditingTitle(false);}}><X size={14}/></button>
            </>
          ) : (
            <>
              <h2 className="qp-dashboard-title" title={title}>{title}</h2>
              <button type="button" className="qp-title-icon-button" aria-label="Edit dashboard name" title="Edit dashboard name" onClick={() => {setDraftTitle(title); setEditingTitle(true);}}><Pencil size={14}/></button>
            </>
          )}
        </div>
        <p><strong>{plan.table}</strong> <span className="qp-title-separator">·</span> Live metrics</p>
      </div>
      <div className="qp-dash-actions qp-dashboard-toolbar" role="toolbar" aria-label="Dashboard actions">
        <button type="button" onClick={saveLayout}><Save size={15}/> Save layout</button>
        <button type="button" onClick={() => window.print()}><Download size={15}/> Print / PDF</button>
        <button type="button" onClick={resetLayout}><RotateCcw size={15}/> Reset</button>
      </div>
    </div>
    <div className="qp-filter-line">
      <strong>Filter</strong>
      <button type="button" className={!selectedGroup ? "active" : ""} onClick={() => onSelectGroup(null)}>All data</button>
      {globalGroups.slice(0, 8).map(item => <button key={item.label} type="button" title={item.label} className={selectedGroup === item.label ? "active" : ""} onClick={() => onSelectGroup(item.label)}>{item.label}</button>)}
      {filterBusy && <small>Recalculating…</small>}
    </div>
    {filterError && <div className="qp-alert" role="alert">{filterError}</div>}
    <div className="qp-dashboard-grid" aria-busy={filterBusy}>
      {panels.map((panel, index) => <article key={panel.id} className={"qp-dashboard-panel" + (panel.wide ? " wide" : "") + (draggingId === panel.id ? " dragging" : "")} draggable onDragStart={() => setDraggingId(panel.id)} onDragOver={event => event.preventDefault()} onDrop={() => dropPanel(panel.id)} onDragEnd={() => setDraggingId(null)}>
        <div className="qp-panel-heading">
          <div className="qp-panel-title">
            <span className="qp-panel-kind-icon" aria-hidden="true">
              {panel.kind === "kpi" ? <Activity size={16}/> : panel.kind === "trend" ? <LineChartIcon size={16}/> : panel.kind === "mix" ? <PieChartIcon size={16}/> : panel.kind === "table" ? <Table2 size={16}/> : <BarChart3 size={16}/>}
            </span>
            <input value={panel.title} aria-label="Panel heading" maxLength={65} onChange={event => editPanel(panel.id, {title:event.target.value})}/>
          </div>
          <div className="qp-panel-actions">
            <span className="qp-panel-drag-hint" aria-label="Drag to reorder" title="Drag to reorder"><GripVertical size={15}/></span>
            {(panel.kind === "trend" || panel.kind === "drivers") && <select aria-label="Chart type" value={panel.chart} onChange={event => editPanel(panel.id,{chart:event.target.value as DashboardPanel["chart"]})}>
              {panel.kind === "trend" ? <><option value="line">Line</option><option value="area">Area</option></> : <option value="bar">Bars</option>}
            </select>}
            <button aria-label="Move panel up" title="Move up" disabled={index === 0} onClick={() => shiftPanel(panel.id,-1)}><ArrowUp size={15}/></button>
            <button aria-label="Move panel down" title="Move down" disabled={index === panels.length-1} onClick={() => shiftPanel(panel.id,1)}><ArrowDown size={15}/></button>
            <button aria-label="Change panel width" title="Toggle width" onClick={() => editPanel(panel.id,{wide:!panel.wide})}><Expand size={15}/></button>
            <button aria-label="Remove panel" title="Remove" onClick={() => setPanels(items => items.filter(p => p.id !== panel.id))}><Trash2 size={15}/></button>
          </div>
        </div>
        {renderPanel(panel)}
      </article>)}
    </div>
    <form className="qp-custom-create" onSubmit={createCustomPanel}>
      <div className="qp-custom-heading"><Sparkles size={18}/><strong>Create your own panel</strong></div>
      <input aria-label="Custom panel title" placeholder="Panel title (optional)" maxLength={65}
        value={customTitle} onChange={event=>setCustomTitle(event.target.value)}/>
      <div className="qp-custom-request">
        <textarea aria-label="Describe your panel" required maxLength={300} rows={2}
          value={customPrompt} onChange={event=>setCustomPrompt(event.target.value)}
          placeholder="Describe what you need, e.g. Average price by category or monthly revenue trend"/>
        <button type="submit" disabled={creating || !customPrompt.trim() || panels.length>=12}>
          {creating?<LoaderCircle size={17} className="spinning"/>:<Plus size={17}/>}
          {creating?"Building…":"Create panel"}
        </button>
      </div>
    </form>
    {toast && <div role={toast.type==="error"?"alert":"status"} className={"qp-floating-toast "+toast.type}>
      {toast.type==="error"?<AlertCircle size={19}/>:<CheckCircle2 size={19}/>}
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={()=>setToast(null)}><X size={16}/></button>
    </div>}
  </section>;
}
