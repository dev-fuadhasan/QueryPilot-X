"use client";

import type { ReactNode } from "react";

type CategoryTickProps = {
  x?: number;
  y?: number;
  width?: number;
  payload?: { value?: string | number };
};

function wrapLabel(value: string, maxChars: number, maxLines = 3) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let line = "";
  for (const token of tokens) {
    const pieces = token.match(new RegExp(".{1," + maxChars + "}", "g")) || [token];
    for (const part of pieces) {
      if (!line) line = part;
      else if ((line + " " + part).length <= maxChars) line += " " + part;
      else { rows.push(line); line = part; }
    }
  }
  if (line) rows.push(line);
  if (!rows.length) rows.push(value.slice(0, maxChars));
  if (rows.length > maxLines) {
    const tail = rows[maxLines - 1];
    rows[maxLines - 1] = tail.slice(0, Math.max(1, maxChars - 1)) + "…";
    return rows.slice(0, maxLines);
  }
  return rows;
}

export function categoryAxisWidth(values: string[]) {
  const longest = Math.max(0, ...values.map(value => String(value).length));
  return longest > 32 ? 205 : longest > 18 ? 168 : 138;
}

/** Wrapped SVG axis text with a native full-label tooltip for very long names. */
export function CategoryTick({ x = 0, y = 0, payload, width = 168 }: CategoryTickProps) {
  const label = String(payload?.value ?? "");
  const lines = wrapLabel(label, Math.max(13, Math.floor((width - 20) / 6.2)));
  const lineHeight = 12;
  return (
    <g transform={"translate(" + x + "," + y + ")"}>
      <title>{label}</title>
      <text x={-9} y={-((lines.length - 1) * lineHeight) / 2} textAnchor="end" fontSize={10} fill="#52697A">
        {lines.map((line, index) => <tspan x={-9} dy={index === 0 ? 0 : lineHeight} key={index}>{line}</tspan>)}
      </text>
    </g>
  );
}

export function ScrollableChart({ children, minWidth = 560 }: { children: ReactNode; minWidth?: number }) {
  return <div className="qp-readable-chart-scroll" role="region" aria-label="Scrollable chart" tabIndex={0}>
    <div className="qp-readable-chart-inner" style={{ minWidth }}>{children}</div>
  </div>;
}

export function ChartCategoryLegend({ rows, onSelect }: {
  rows: { label: string; value: number }[];
  onSelect?: (label: string) => void;
}) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  const colors = ["#2F4A63", "#5B91A3", "#8AB7C2", "#96B9AE", "#CFEAE0", "#73859E", "#A9C8BA"];
  return <div className="qp-category-legend">
    {rows.map((row, index) => {
      const content = <>
        <span className="qp-category-dot" style={{ background: colors[index % colors.length] }}/>
        <span className="qp-category-name" title={row.label}>{row.label}</span>
        <span className="qp-category-number">{total ? (Math.max(0, row.value) / total * 100).toFixed(1) + "%" : "—"}</span>
      </>;
      return onSelect
        ? <button type="button" className="qp-category-item" onClick={() => onSelect(row.label)} key={index}>{content}</button>
        : <div className="qp-category-item" key={index}>{content}</div>;
    })}
  </div>;
}


/** Show complete text without requiring a hover when a category is too long for three axis lines. */
export function FullCategoryLabels({ labels }: { labels: string[] }) {
  const long = labels.filter(label => label.length > 72);
  if (!long.length) return null;
  return <div className="qp-full-category-labels">
    <strong>Full category labels</strong>
    <div>{long.map((label, index) => <p key={index}>{label}</p>)}</div>
  </div>;
}
