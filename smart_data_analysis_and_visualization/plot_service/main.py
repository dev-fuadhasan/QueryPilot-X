import base64
import io
import math
import os
from urllib.parse import urlparse

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

KINDS = {
    "bar", "horizontal_bar", "line", "area", "pie", "donut", "scatter", "histogram",
    "box", "violin", "heatmap", "stacked_bar", "grouped_bar", "kde", "lollipop", "waterfall"
}
COLORS = ["#36536a", "#678fa8", "#99bbc9", "#dbad7b", "#789b8f", "#b98a97"]


def safe_text(value, limit=70):
    return str(value if value is not None else "Unknown").replace("\n", " ").strip()[:limit]


def valid_column(frame, column):
    return isinstance(column, str) and column in frame.columns


def label(column):
    return safe_text(column.replace("_", " ").title(), 50)


def render_chart(frame, spec):
    kind = spec.get("type", "")
    x = spec.get("x", "")
    y = spec.get("y", "")
    extra = spec.get("extra", [])
    title = safe_text(spec.get("title", "Chart"), 100)
    if kind not in KINDS or not valid_column(frame, y):
        return None
    values = pd.to_numeric(frame[y], errors="coerce")
    if values.notna().sum() < 2:
        return None
    fig, ax = plt.subplots(figsize=(8.5, 4.5), dpi=125)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.grid(axis="y", color="#eef1f4", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    chart = frame.copy()
    chart[y] = values
    try:
        if kind in {"bar", "horizontal_bar", "lollipop", "line", "area", "pie", "donut", "waterfall", "stacked_bar", "grouped_bar"}:
            if not valid_column(chart, x):
                return None
            chart = chart.iloc[:24].copy()
            labels = [safe_text(value, 24) for value in chart[x].tolist()]
            series = chart[y].to_numpy(dtype=float)
            xs = np.arange(len(chart))
            if kind == "bar":
                ax.bar(xs, series, color=COLORS[1], width=0.63)
                ax.set_xticks(xs, labels, rotation=30, ha="right", fontsize=8)
            elif kind == "horizontal_bar":
                ax.barh(xs[::-1], series, color=COLORS[1], height=0.63)
                ax.set_yticks(xs[::-1], labels, fontsize=9)
                ax.grid(axis="x", color="#eef1f4", linewidth=0.8)
            elif kind == "lollipop":
                ax.vlines(xs, 0, series, linewidth=2.4, color=COLORS[1])
                ax.scatter(xs, series, s=75, color=COLORS[0], zorder=5)
                ax.set_xticks(xs, labels, rotation=30, ha="right", fontsize=8)
            elif kind in {"line", "area"}:
                ax.plot(xs, series, linewidth=2.4, marker="o", markersize=4, color=COLORS[0])
                if kind == "area":
                    ax.fill_between(xs, series, 0, alpha=0.24, color=COLORS[1])
                ax.set_xticks(xs, labels, rotation=25, ha="right", fontsize=8)
            elif kind in {"pie", "donut"}:
                usable = np.isfinite(series) & (series >= 0)
                if not np.all(usable) or np.sum(series) <= 0 or len(chart) > 10:
                    return None
                ax.grid(False)
                ax.pie(series, labels=labels, colors=COLORS, startangle=90, autopct="%1.1f%%", pctdistance=0.78,
                       wedgeprops={"width": 0.44 if kind == "donut" else 1, "edgecolor": "white"}, textprops={"fontsize": 8})
            elif kind in {"stacked_bar", "grouped_bar"}:
                measures = [n for n in extra if valid_column(chart, n) and n != x][:5]
                if len(measures) < 2:
                    return None
                ax.grid(axis="y", color="#eef1f4")
                if kind == "stacked_bar":
                    base = np.zeros(len(chart))
                    for idx, measure in enumerate(measures):
                        nums = pd.to_numeric(chart[measure], errors="coerce").fillna(0).to_numpy(dtype=float)
                        ax.bar(xs, nums, bottom=base, color=COLORS[idx % len(COLORS)], label=label(measure), width=0.66)
                        base += nums
                else:
                    width = 0.75 / len(measures)
                    for idx, measure in enumerate(measures):
                        nums = pd.to_numeric(chart[measure], errors="coerce").fillna(0).to_numpy(dtype=float)
                        ax.bar(xs - 0.375 + width / 2 + idx * width, nums, width=width, color=COLORS[idx % len(COLORS)], label=label(measure))
                ax.legend(frameon=False, fontsize=8, ncol=min(3, len(measures)))
                ax.set_xticks(xs, labels, rotation=30, ha="right", fontsize=8)
            elif kind == "waterfall":
                base = np.r_[0, np.cumsum(series)[:-1]]
                ax.bar(xs, series, bottom=base, color=[COLORS[4] if s >= 0 else COLORS[5] for s in series])
                ax.set_xticks(xs, labels, rotation=30, ha="right", fontsize=8)
        elif kind == "scatter":
            if not valid_column(chart, x):
                return None
            xnums = pd.to_numeric(chart[x], errors="coerce")
            mask = xnums.notna() & values.notna()
            if mask.sum() < 3:
                return None
            sns.scatterplot(x=xnums[mask], y=values[mask], color=COLORS[1], s=50, ax=ax, edgecolor="white")
            ax.set_xlabel(label(x)); ax.set_ylabel(label(y))
        elif kind == "histogram":
            sns.histplot(values.dropna(), bins="auto", color=COLORS[1], ax=ax, edgecolor="white")
            ax.set_xlabel(label(y)); ax.set_ylabel("Frequency")
        elif kind == "box":
            if valid_column(chart, x) and chart[x].nunique() <= 10:
                sns.boxplot(data=chart, x=x, y=y, color=COLORS[1], ax=ax)
                ax.tick_params(axis="x", labelrotation=25)
            else:
                sns.boxplot(y=values.dropna(), color=COLORS[1], ax=ax)
        elif kind == "violin":
            if valid_column(chart, x) and chart[x].nunique() <= 10:
                sns.violinplot(data=chart, x=x, y=y, color=COLORS[1], ax=ax, inner="quart")
                ax.tick_params(axis="x", labelrotation=25)
            else:
                sns.violinplot(y=values.dropna(), color=COLORS[1], ax=ax, inner="quart")
        elif kind == "kde":
            if values.dropna().nunique() < 2:
                return None
            sns.kdeplot(x=values.dropna(), color=COLORS[0], fill=True, alpha=0.25, ax=ax)
            ax.set_xlabel(label(y)); ax.set_ylabel("Density")
        elif kind == "heatmap":
            cols = [c for c in extra if valid_column(chart, c)][:8]
            if len(cols) < 2:
                return None
            data = chart[cols].apply(pd.to_numeric, errors="coerce")
            matrix = data.corr()
            if matrix.isna().all().all():
                return None
            sns.heatmap(matrix, annot=True, fmt=".2f", cmap="Blues", vmin=-1, vmax=1, center=0,
                        square=True, linewidths=0.6, linecolor="white", ax=ax, annot_kws={"size": 8})
            ax.tick_params(axis="x", labelrotation=30)
        if kind not in {"pie", "donut"}:
            ax.set_title(title, loc="left", fontsize=13, fontweight="bold", pad=18, color="#223446")
            for spine in ax.spines.values():
                spine.set_visible(False)
            ax.tick_params(axis="both", which="both", length=0, labelcolor="#536272")
        else:
            ax.set_title(title, fontsize=13, fontweight="bold", color="#223446")
        fig.tight_layout(pad=1.6)
        buffer = io.BytesIO()
        fig.savefig(buffer, format="png", dpi=135, bbox_inches="tight", facecolor="white")
        return {"title": title, "type": kind, "image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")}
    finally:
        plt.close(fig)


async def produce(request: Request):
    origin = request.headers.get("origin", "")
    expected = os.getenv("APP_URL", "")
    allowed = {urlparse(expected).netloc, "localhost:3000", "127.0.0.1:3000"}
    vercel_host = os.getenv("VERCEL_URL", "")
    if vercel_host:
        allowed.add(vercel_host)
    if not origin or urlparse(origin).netloc not in allowed:
        raise HTTPException(status_code=403, detail="Invalid request origin")
    raw = await request.body()
    if len(raw) > 180000:
        raise HTTPException(status_code=413, detail="Chart request too large")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request")
    rows = data.get("rows", []) if isinstance(data, dict) else []
    specs = data.get("charts", []) if isinstance(data, dict) else []
    if not isinstance(rows, list) or not isinstance(specs, list) or len(rows) > 100 or len(specs) > 3:
        raise HTTPException(status_code=400, detail="Invalid figure request")
    frame = pd.DataFrame([row for row in rows if isinstance(row, dict)][:100])
    if len(frame.columns) > 35:
        raise HTTPException(status_code=400, detail="Too many fields")
    figures = []
    for spec in specs:
        if not isinstance(spec, dict):
            continue
        try:
            result = render_chart(frame, spec)
            if result:
                figures.append(result)
        except (ValueError, TypeError, KeyError, IndexError, OverflowError, ZeroDivisionError):
            continue
    return JSONResponse({"figures": figures}, headers={"Cache-Control": "no-store"})


@app.post("/api/figures")
async def figures(request: Request):
    return await produce(request)


@app.post("/")
async def root(request: Request):
    return await produce(request)


@app.get("/health")
async def health():
    return {"ok": True, "engine": "matplotlib-seaborn"}
