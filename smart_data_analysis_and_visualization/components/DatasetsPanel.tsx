"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Columns3, Database, Hash, RefreshCw, Search, ShieldCheck, Table2 } from "lucide-react";

export type Table = { name: string; columns: string[] };

type Props = {
  tables: Table[];
  loading: boolean;
  onRefresh: () => void;
  selectedTable: string;
  onSelectTable: (name: string) => void;
  onOpenDashboard?: () => void;
};

export default function DatasetsPanel({ tables, loading, onRefresh, selectedTable, onSelectTable, onOpenDashboard }: Props) {
  const [tableSearch, setTableSearch] = useState("");
  const [fieldSearch, setFieldSearch] = useState("");
  const current = tables.find(table => table.name === selectedTable) || tables[0] || null;
  const filteredTables = tables.filter(table => table.name.toLowerCase().includes(tableSearch.trim().toLowerCase()));
  const fields = current?.columns.filter(column => column.toLowerCase().includes(fieldSearch.trim().toLowerCase())) || [];
  const allColumns = tables.reduce((sum, table) => sum + table.columns.length, 0);

  return (
    <section className="qp-datasets-modern">
      <header className="qp-datasets-heading">
        <div>
          <div className="qp-data-eyebrow"><Database size={15}/> DATA EXPLORER</div>
          <h2>Connected datasets</h2>
          <p>Browse the authorized tables and fields in your Supabase project.</p>
        </div>
        <button className="qp-datasets-refresh" type="button" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={15} className={loading ? "spinning" : ""}/> Refresh
        </button>
      </header>

      <div className="qp-data-stats">
        <div className="qp-data-stat"><span className="qp-data-stat-icon"><Database size={19}/></span>
          <div><span>Tables</span><strong>{tables.length}</strong></div></div>
        <div className="qp-data-stat"><span className="qp-data-stat-icon"><Columns3 size={19}/></span>
          <div><span>Total fields</span><strong>{allColumns}</strong></div></div>
        <div className="qp-data-stat"><span className="qp-data-stat-icon"><ShieldCheck size={19}/></span>
          <div><span>Access</span><strong className="qp-data-safe"><CheckCircle2 size={16}/> Read only</strong></div></div>
      </div>

      <div className="qp-data-layout">
        <section className="qp-data-tables" aria-label="Available tables">
          <div className="qp-data-panel-title"><h3>Tables</h3><span>{filteredTables.length} of {tables.length}</span></div>
          <label className="qp-data-search"><Search size={17}/>
            <input value={tableSearch} onChange={event => setTableSearch(event.target.value)}
              placeholder="Search tables" aria-label="Search tables"/>
          </label>
          <div className="qp-data-table-list">
            {loading && <p className="qp-data-empty">Refreshing available tables…</p>}
            {!loading && !tables.length && <p className="qp-data-empty">No readable tables found.</p>}
            {!loading && tables.length > 0 && !filteredTables.length && <p className="qp-data-empty">No matching tables.</p>}
            {filteredTables.map(table => {
              const active = current?.name === table.name;
              return <button className={"qp-data-table-item" + (active ? " active" : "")}
                key={table.name} type="button" aria-pressed={active}
                onClick={() => { setFieldSearch(""); onSelectTable(table.name); }}>
                <span className="qp-data-table-icon"><Table2 size={18}/></span>
                <span className="qp-data-table-name"><strong title={table.name}>{table.name}</strong><small>{table.columns.length} fields</small></span>
                <ArrowRight size={16} className="qp-data-table-arrow"/>
              </button>;
            })}
          </div>
        </section>

        <section className="qp-data-fields" aria-label="Selected table details">
          {current ? <>
            <div className="qp-data-detail-head">
              <span className="qp-data-detail-icon"><Table2 size={23}/></span>
              <div className="qp-data-detail-copy">
                <span>SELECTED TABLE</span><h3 title={current.name}>{current.name}</h3>
                <p><Columns3 size={14}/>{current.columns.length} available fields <span>·</span> public schema</p>
              </div>
              {onOpenDashboard && <button type="button" className="qp-data-analyze" onClick={() => {
                onSelectTable(current.name);
                onOpenDashboard();
              }}>Open dashboard <ArrowRight size={15}/></button>}
            </div>
            <div className="qp-data-field-bar">
              <div><strong>Fields</strong><span>{fields.length} shown</span></div>
              <label className="qp-data-search qp-field-search"><Search size={16}/>
                <input aria-label="Search fields" value={fieldSearch} onChange={event => setFieldSearch(event.target.value)} placeholder="Find a field"/>
              </label>
            </div>
            <div className="qp-data-field-list">
              {fields.length ? fields.map(field => {
                const position = current.columns.indexOf(field) + 1;
                return <div className="qp-data-field" key={field}>
                  <span className="qp-field-number">{String(position).padStart(2, "0")}</span>
                  <span className="qp-field-name" title={field}>{field}</span>
                  <span className="qp-field-label"><Hash size={13}/> Column</span>
                </div>;
              }) : <p className="qp-data-empty">No fields match your search.</p>}
            </div>
          </> : <div className="qp-data-no-selection"><Database size={27}/><h3>No table selected</h3><p>Choose an available table to inspect its fields.</p></div>}
        </section>
      </div>
    </section>
  );
}
