import PDFDocument from "pdfkit";
import type { DimensionBreakdown, MetricResult, TimeSeriesPoint } from "../metrics/types";
import type { DailyReportAlert } from "../notifications";
import type {
  ActionableRecommendation,
  BriefFinding,
  DataHealthReport,
  ReportArchiveComparisonResult,
  RootCauseAnalysisResult,
  SmartDayComparison
} from "../intelligence/types";
import type { DynamicPdfReportInput, HistoricalContextBundle, PdfReportMetadata } from "./types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_TOP = 82;
const CONTENT_BOTTOM = PAGE_HEIGHT - 64;

const COLORS = {
  navy: "#162638",
  ink: "#202934",
  slate: "#4b5a69",
  muted: "#6d7a88",
  green: "#279a6c",
  greenBg: "#eff9f3",
  greenBorder: "#ccebd9",
  blue: "#2e6fa8",
  blueBg: "#f0f6fc",
  amber: "#b7791f",
  amberBg: "#fff9ec",
  amberBorder: "#f1ddb2",
  red: "#b43c44",
  redBg: "#fff3f4",
  redBorder: "#f2cfd2",
  border: "#dce3ea",
  surface: "#f6f8fa",
  white: "#ffffff"
};

type TextStyle = PDFKit.Mixins.TextOptions & {
  font?: string;
  fontSize?: number;
  fillColor?: string;
};

function safeNum(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cleanText(value: string | null | undefined, maxLen = 400): string {
  if (!value) return "";
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function formatFrequencyLabel(freq: PdfReportMetadata["frequency"], quickRangeLabel?: string | null): string {
  if (freq === "daily") return "Daily";
  if (freq === "weekly") return "Weekly (Mon–Sun)";
  if (freq === "monthly") return "Monthly";
  return quickRangeLabel ? `Manual (${quickRangeLabel})` : "Manual / Custom";
}

function formatTimestamp(iso: string, timeZone: string): string {
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(dt);
    return `${formatted} (${timeZone})`;
  } catch {
    return iso;
  }
}

class PdfLayoutCursor {
  public y = CONTENT_TOP;
  public pageNumber = 0;

  constructor(
    public readonly doc: PDFKit.PDFDocument,
    private readonly meta: PdfReportMetadata
  ) {}

  addPage(isCover = false): void {
    this.doc.addPage();
    this.pageNumber += 1;
    if (!isCover) {
      this.drawRunningHeader();
    }
    this.drawRunningFooter();
    this.y = isCover ? MARGIN : CONTENT_TOP;
  }

  ensureSpace(requiredHeight: number): void {
    if (this.y + requiredHeight > CONTENT_BOTTOM) {
      this.addPage(false);
    }
  }

  text(content: string, x: number, y: number, style: TextStyle = {}): void {
    const { font, fontSize, fillColor, ...rest } = style;
    this.doc
      .font(font || "Helvetica")
      .fontSize(fontSize || 9)
      .fillColor(fillColor || COLORS.ink)
      .text(content, x, y, rest);
  }

  measureHeight(content: string, width: number, fontSize = 8.5, font = "Helvetica", lineGap = 2): number {
    this.doc.font(font).fontSize(fontSize);
    return this.doc.heightOfString(content, { width, lineGap });
  }

  drawSectionHeading(title: string, subtitle?: string): void {
    const needed = subtitle ? 46 : 34;
    this.ensureSpace(needed);
    this.text(title, MARGIN, this.y, { font: "Helvetica-Bold", fontSize: 12.5, fillColor: COLORS.navy, width: CONTENT_WIDTH });
    this.y += 17;
    if (subtitle) {
      const subH = this.measureHeight(subtitle, CONTENT_WIDTH, 8);
      this.text(subtitle, MARGIN, this.y, { fontSize: 8, fillColor: COLORS.muted, width: CONTENT_WIDTH, lineGap: 1.5 });
      this.y += subH + 4;
    }
    this.doc
      .moveTo(MARGIN, this.y)
      .lineTo(PAGE_WIDTH - MARGIN, this.y)
      .strokeColor(COLORS.green)
      .lineWidth(1.2)
      .stroke();
    this.y += 10;
  }

  drawCallout(text: string, options: { bg?: string; border?: string; color?: string; label?: string } = {}): void {
    const bg = options.bg || COLORS.surface;
    const border = options.border || COLORS.border;
    const color = options.color || COLORS.ink;
    const full = options.label ? `${options.label}: ${text}` : text;
    const bodyHeight = this.measureHeight(full, CONTENT_WIDTH - 20, 8.5);
    const boxHeight = bodyHeight + 14;
    this.ensureSpace(boxHeight + 8);
    this.doc.roundedRect(MARGIN, this.y, CONTENT_WIDTH, boxHeight, 5).fillColor(bg).fillAndStroke(border);
    this.text(full, MARGIN + 10, this.y + 7, { fontSize: 8.5, fillColor: color, width: CONTENT_WIDTH - 20, lineGap: 2 });
    this.y += boxHeight + 8;
  }

  private drawRunningHeader(): void {
    this.doc.fillColor(COLORS.green).roundedRect(MARGIN, 26, 22, 22, 4).fill();
    this.text("Q", MARGIN + 6.5, 31, { font: "Helvetica-Bold", fontSize: 11, fillColor: COLORS.white, lineBreak: false });
    this.text("QueryPilot X", MARGIN + 29, 29, { font: "Helvetica-Bold", fontSize: 10.5, fillColor: COLORS.navy, lineBreak: false });
    this.text(cleanText(`${this.meta.domainName} · ${this.meta.datasetTable}`, 70), MARGIN + 29, 41, {
      fontSize: 7.5,
      fillColor: COLORS.muted,
      width: 240,
      ellipsis: true,
      lineBreak: false
    });
    this.text(cleanText(`Period: ${this.meta.periodLabel} (${this.meta.timezone})`, 60), MARGIN + 260, 32, {
      fontSize: 7.5,
      fillColor: COLORS.muted,
      width: CONTENT_WIDTH - 260,
      align: "right",
      ellipsis: true,
      lineBreak: false
    });
    this.doc.moveTo(MARGIN, 56).lineTo(PAGE_WIDTH - MARGIN, 56).strokeColor(COLORS.border).lineWidth(0.75).stroke();
  }

  private drawRunningFooter(): void {
    const footerY = PAGE_HEIGHT - 46;
    this.doc.moveTo(MARGIN, footerY - 6).lineTo(PAGE_WIDTH - MARGIN, footerY - 6).strokeColor(COLORS.border).lineWidth(0.6).stroke();
    this.text(
      cleanText(`QueryPilot X · Confidential · ${this.meta.organizationLabel} · Report ${this.meta.reportId.slice(0, 12)}`, 88),
      MARGIN,
      footerY,
      { fontSize: 7.2, fillColor: COLORS.muted, width: CONTENT_WIDTH - 70, ellipsis: true, lineBreak: false }
    );
    this.text(`Page ${this.pageNumber}`, PAGE_WIDTH - MARGIN - 65, footerY, {
      fontSize: 7.5,
      fillColor: COLORS.muted,
      width: 65,
      align: "right",
      lineBreak: false
    });
  }
}

/* ============================================================================
 * 1. COVER PAGE
 * ============================================================================ */

function renderCoverPage(cursor: PdfLayoutCursor, input: DynamicPdfReportInput): void {
  const { metadata: meta, unified } = input;
  cursor.addPage(true);

  // Top dark accent band
  cursor.doc.roundedRect(MARGIN, MARGIN, CONTENT_WIDTH, 118, 8).fillColor(COLORS.navy).fill();
  cursor.doc.fillColor(COLORS.green).roundedRect(MARGIN + 22, MARGIN + 22, 34, 34, 6).fill();
  cursor.text("Q", MARGIN + 33, MARGIN + 30, { font: "Helvetica-Bold", fontSize: 16, fillColor: COLORS.white, lineBreak: false });
  cursor.text("QueryPilot X", MARGIN + 66, MARGIN + 24, { font: "Helvetica-Bold", fontSize: 16, fillColor: COLORS.white, lineBreak: false });
  cursor.text("DYNAMIC BUSINESS INTELLIGENCE & REPORTING", MARGIN + 66, MARGIN + 44, { fontSize: 8, fillColor: "#9cc9b5", lineBreak: false });

  cursor.text(cleanText(`${meta.domainName} Report`, 64), MARGIN + 22, MARGIN + 72, {
    font: "Helvetica-Bold",
    fontSize: 18,
    fillColor: COLORS.white,
    width: CONTENT_WIDTH - 44,
    ellipsis: true,
    lineBreak: false
  });
  cursor.text(
    cleanText(`${meta.generationType === "automatic" ? "Automatic Scheduled" : "Manual On-Demand"} · ${formatFrequencyLabel(meta.frequency, meta.quickRangeLabel)}`, 90),
    MARGIN + 22,
    MARGIN + 96,
    { fontSize: 9, fillColor: "#c9d6e2", width: CONTENT_WIDTH - 44, ellipsis: true, lineBreak: false }
  );

  cursor.y = MARGIN + 136;

  // Metadata card (safe non-sensitive fields only)
  const metaRows: Array<[string, string]> = [
    ["Organisation", cleanText(meta.organizationLabel, 80)],
    ["Business Domain", meta.domainName],
    ["Dataset / Source", cleanText(meta.datasetTable, 80)],
    ["Report ID", cleanText(meta.reportId, 60)],
    ["Report Type", meta.generationType === "automatic" ? "Automatic (Scheduled)" : "Manual (On-Demand)"],
    ["Frequency", formatFrequencyLabel(meta.frequency, meta.quickRangeLabel)],
    ["Primary Reporting Period", meta.periodLabel],
    ["Comparison Period", meta.comparisonLabel || "Not selected / unavailable"],
    ["Organisation Timezone", meta.timezone],
    ["Generated At", formatTimestamp(meta.generatedAt, meta.timezone)]
  ];

  const colW = (CONTENT_WIDTH - 14) / 2;
  const rowH = 38;
  const gridRows = Math.ceil(metaRows.length / 2);
  const cardH = gridRows * rowH + 20;
  cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, cardH, 6).fillColor(COLORS.surface).fillAndStroke(COLORS.border);

  metaRows.forEach(([label, val], idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = MARGIN + 12 + col * (colW + 4);
    const y = cursor.y + 12 + row * rowH;
    cursor.text(label.toUpperCase(), x, y, { font: "Helvetica-Bold", fontSize: 7, fillColor: COLORS.muted, width: colW - 14, lineBreak: false });
    cursor.text(val, x, y + 11, { font: "Helvetica-Bold", fontSize: 9, fillColor: COLORS.ink, width: colW - 14, ellipsis: true, lineBreak: false });
  });
  cursor.y += cardH + 18;

  // Cover Executive Snapshot (top 4 available KPIs)
  const topKpis = unified.analysis.availableMetrics.slice(0, 4);
  if (topKpis.length > 0) {
    cursor.text("EXECUTIVE KPI SNAPSHOT (PRIMARY PERIOD)", MARGIN, cursor.y, {
      font: "Helvetica-Bold",
      fontSize: 8.5,
      fillColor: COLORS.slate
    });
    cursor.y += 14;
    const boxW = (CONTENT_WIDTH - 12 * (topKpis.length - 1)) / topKpis.length;
    topKpis.forEach((kpi, i) => {
      const x = MARGIN + i * (boxW + 12);
      cursor.doc.roundedRect(x, cursor.y, boxW, 64, 6).fillColor(COLORS.white).fillAndStroke(COLORS.border);
      cursor.text(cleanText(kpi.name, 26), x + 8, cursor.y + 8, { fontSize: 7.5, fillColor: COLORS.muted, width: boxW - 16, ellipsis: true, lineBreak: false });
      cursor.text(kpi.formattedValue || "—", x + 8, cursor.y + 23, { font: "Helvetica-Bold", fontSize: 12, fillColor: COLORS.navy, width: boxW - 16, ellipsis: true, lineBreak: false });
      const deltaStr = kpi.changePercent !== null
        ? `${kpi.changePercent >= 0 ? "▲ +" : "▼ "}${kpi.changePercent.toFixed(1)}%`
        : "No comparison";
      const deltaColor = kpi.changePercent === null ? COLORS.muted : kpi.changePercent >= 0 ? COLORS.green : COLORS.red;
      cursor.text(deltaStr, x + 8, cursor.y + 44, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: deltaColor, width: boxW - 16, lineBreak: false });
    });
    cursor.y += 78;
  }

  // Executive Brief preview on cover
  if (unified.tools.intelligenceBrief?.executiveSummary) {
    cursor.drawCallout(cleanText(unified.tools.intelligenceBrief.executiveSummary, 480), {
      bg: COLORS.greenBg,
      border: COLORS.greenBorder,
      color: COLORS.navy,
      label: "Brief Overview"
    });
  }

  // Data Governance & Confidentiality notice on cover
  const governanceNote = `Source database accessed read-only (${unified.analysis.source.rowCountInPeriod} record(s) evaluated in primary period). Source freshness: ${unified.dataFreshnessTimestamp || "unknown"}. Personal and raw sensitive fields are excluded.`;
  cursor.drawCallout(governanceNote, { bg: COLORS.surface, border: COLORS.border, color: COLORS.muted });
}

/* ============================================================================
 * 2. EXECUTIVE SUMMARY — DAILY INTELLIGENCE BRIEF
 * ============================================================================ */

function renderIntelligenceBrief(cursor: PdfLayoutCursor, unified: DynamicPdfReportInput["unified"]): void {
  const brief = unified.tools.intelligenceBrief;
  if (!brief) return;

  cursor.drawSectionHeading(
    "Executive Summary — Daily Intelligence Brief",
    `Status: ${brief.status.replace(/_/g, " ")} · Derived strictly from verified database metrics`
  );

  cursor.drawCallout(cleanText(brief.executiveSummary, 550), {
    bg: brief.status === "insufficient_data" ? COLORS.amberBg : COLORS.greenBg,
    border: brief.status === "insufficient_data" ? COLORS.amberBorder : COLORS.greenBorder,
    color: COLORS.navy
  });

  const renderFindingCard = (finding: BriefFinding) => {
    const accent = finding.category === "positive"
      ? COLORS.green
      : finding.category === "negative"
        ? COLORS.red
        : finding.category === "unusual" || finding.category === "data_gap"
          ? COLORS.amber
          : COLORS.blue;

    const badge = finding.certainty === "confirmed" ? "CONFIRMED" : "POSSIBLE EXPLANATION";
    const lines = [
      `What happened: ${cleanText(finding.whatHappened, 220)}`,
      finding.whatChanged ? `What changed: ${cleanText(finding.whatChanged, 200)}` : null,
      finding.performanceLabel
        ? `Performance: ${cleanText(finding.performanceLabel, 80)}${finding.financialPositionLabel ? ` · Current Financial Position: ${cleanText(finding.financialPositionLabel, 80)}` : ""}`
        : null,
      finding.possibleExplanation ? `Possible explanation: ${cleanText(finding.possibleExplanation, 220)}` : null
    ].filter((l): l is string => Boolean(l));

    const bodyText = lines.join("\n");
    const bodyH = cursor.measureHeight(bodyText, CONTENT_WIDTH - 24, 8, "Helvetica", 1.8);
    const cardH = bodyH + 28;
    cursor.ensureSpace(cardH + 6);

    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, cardH, 5).fillColor(COLORS.white).fillAndStroke(COLORS.border);
    cursor.doc.rect(MARGIN, cursor.y, 4, cardH).fillColor(accent).fill();
    cursor.text(cleanText(finding.headline, 95), MARGIN + 12, cursor.y + 7, {
      font: "Helvetica-Bold",
      fontSize: 9,
      fillColor: COLORS.navy,
      width: CONTENT_WIDTH - 130,
      ellipsis: true,
      lineBreak: false
    });
    cursor.text(badge, PAGE_WIDTH - MARGIN - 118, cursor.y + 8, {
      font: "Helvetica-Bold",
      fontSize: 6.8,
      fillColor: accent,
      width: 110,
      align: "right",
      lineBreak: false
    });
    cursor.text(bodyText, MARGIN + 12, cursor.y + 21, {
      fontSize: 8,
      fillColor: COLORS.slate,
      width: CONTENT_WIDTH - 24,
      lineGap: 1.8
    });
    cursor.y += cardH + 6;
  };

  for (const finding of brief.findings.slice(0, 10)) {
    renderFindingCard(finding);
  }

  if (brief.dataCaveats.length > 0) {
    cursor.drawCallout(cleanText(brief.dataCaveats.slice(0, 3).join(" | "), 420), {
      bg: COLORS.amberBg,
      border: COLORS.amberBorder,
      color: COLORS.amber,
      label: "Data Caveats"
    });
  }
}

/* ============================================================================
 * 3. DYNAMIC BUSINESS KPI SECTION (+ DOMAIN-SPECIFIC SUMMARIES)
 * ============================================================================ */

function renderKpiCards(cursor: PdfLayoutCursor, metrics: MetricResult[], sectionTitle: string, subtitle: string): void {
  cursor.drawSectionHeading(sectionTitle, subtitle);

  if (metrics.length === 0) {
    cursor.drawCallout("No verified metrics could be calculated for this period because required fields or records were unavailable.", {
      bg: COLORS.amberBg,
      border: COLORS.amberBorder,
      color: COLORS.amber
    });
    return;
  }

  const cardW = (CONTENT_WIDTH - 12) / 2;
  const cardH = 66;

  for (let i = 0; i < metrics.length; i += 2) {
    cursor.ensureSpace(cardH + 8);
    const rowY = cursor.y;

    for (let col = 0; col < 2; col += 1) {
      const m = metrics[i + col];
      if (!m) continue;
      const x = MARGIN + col * (cardW + 12);
      cursor.doc.roundedRect(x, rowY, cardW, cardH, 6).fillColor(COLORS.surface).fillAndStroke(COLORS.border);

      cursor.text(cleanText(m.name, 42), x + 10, rowY + 8, {
        fontSize: 8,
        fillColor: COLORS.muted,
        width: cardW - 60,
        ellipsis: true,
        lineBreak: false
      });

      if (m.confidence === "medium") {
        cursor.text("MED CONF", x + cardW - 54, rowY + 8, {
          font: "Helvetica-Bold",
          fontSize: 6.5,
          fillColor: COLORS.amber,
          width: 46,
          align: "right",
          lineBreak: false
        });
      }

      cursor.text(m.formattedValue || "—", x + 10, rowY + 22, {
        font: "Helvetica-Bold",
        fontSize: 13.5,
        fillColor: COLORS.navy,
        width: cardW - 20,
        ellipsis: true,
        lineBreak: false
      });

      let indicator = "No comparison";
      let indColor = COLORS.muted;
      if (m.changePercent !== null) {
        const up = m.changePercent >= 0;
        indicator = `${up ? "▲ +" : "▼ "}${m.changePercent.toFixed(1)}%`;
        const improved = m.polarity === "lower_is_better" ? !up : up;
        indColor = m.polarity === "neutral" ? COLORS.blue : improved ? COLORS.green : COLORS.red;
      } else if (m.comparisonValue === 0) {
        indicator = "Zero baseline";
      }

      cursor.text(indicator, x + 10, rowY + 45, {
        font: "Helvetica-Bold",
        fontSize: 8,
        fillColor: indColor,
        width: 100,
        lineBreak: false
      });

      if (m.formattedComparisonValue) {
        cursor.text(`Ref: ${m.formattedComparisonValue}`, x + 108, rowY + 46, {
          fontSize: 7,
          fillColor: COLORS.muted,
          width: cardW - 118,
          align: "right",
          ellipsis: true,
          lineBreak: false
        });
      }
    }

    cursor.y += cardH + 8;
  }
}

function renderDomainSpecificBlocks(cursor: PdfLayoutCursor, unified: DynamicPdfReportInput["unified"]): void {
  const analysis = unified.analysis;
  const extra = analysis.domainSpecificData;

  if (analysis.unavailableMetrics.length > 0) {
    const names = analysis.unavailableMetrics.map(m => `${m.name} (${m.missingRequiredFields.length ? `missing ${m.missingRequiredFields.join(", ")}` : "insufficient data"})`);
    cursor.drawCallout(cleanText(names.join("; "), 460), {
      bg: COLORS.surface,
      border: COLORS.border,
      color: COLORS.muted,
      label: "Unavailable Metrics (not fabricated as zero)"
    });
  }

  if (analysis.domainId === "customers_crm" && extra?.rfm && typeof extra.rfm === "object") {
    const rfm = extra.rfm as { available?: boolean; segments?: Record<string, number> };
    if (rfm.available && rfm.segments) {
      const segLine = Object.entries(rfm.segments).map(([k, v]) => `${k}: ${v}`).join("  |  ");
      const clvMethod = typeof extra.clvMethod === "string" ? ` · CLV basis: ${extra.clvMethod}` : "";
      cursor.drawCallout(`${segLine}${clvMethod}`, {
        bg: COLORS.blueBg,
        border: COLORS.border,
        color: COLORS.navy,
        label: "CRM RFM Segmentation"
      });
    }
  }

  if (analysis.domainId === "inventory_supply_chain" && extra) {
    const reorderItems = Array.isArray(extra.reorderAlertItems)
      ? (extra.reorderAlertItems as Array<{ skuId: string; product: string; warehouse: string; stockOnHand: number; reorderPoint: number }>)
      : [];
    if (reorderItems.length > 0) {
      const summary = reorderItems.slice(0, 6).map(i => `${i.product} (${i.warehouse}: ${i.stockOnHand}/${i.reorderPoint})`).join(", ");
      cursor.drawCallout(cleanText(summary, 420), {
        bg: COLORS.amberBg,
        border: COLORS.amberBorder,
        color: COLORS.amber,
        label: "Reorder Alert SKUs"
      });
    }
  }
}

/* ============================================================================
 * 4. SMART DAY COMPARISON
 * ============================================================================ */

function renderSmartComparison(cursor: PdfLayoutCursor, comparison: SmartDayComparison | null): void {
  if (!comparison) return;

  cursor.drawSectionHeading(
    "Smart Day Comparison",
    comparison.comparisonPeriod
      ? `Current: ${comparison.reportingPeriod.label} vs Reference: ${comparison.comparisonPeriod.label} (${comparison.mode.replace(/_/g, " ")})`
      : "No comparison period selected"
  );

  if (comparison.weekdayNote) {
    cursor.drawCallout(cleanText(comparison.weekdayNote, 320), {
      bg: COLORS.blueBg,
      border: COLORS.border,
      color: COLORS.blue
    });
  }

  if (!comparison.comparable && comparison.statusReason) {
    cursor.drawCallout(cleanText(comparison.statusReason, 320), {
      bg: COLORS.amberBg,
      border: COLORS.amberBorder,
      color: COLORS.amber
    });
  }

  const rows = comparison.metrics.filter(m => m.currentValue !== null || m.comparisonValue !== null);
  if (rows.length === 0) return;

  const cols = [
    { x: MARGIN, w: 165, align: "left" as const, label: "Metric" },
    { x: MARGIN + 168, w: 82, align: "right" as const, label: "Current" },
    { x: MARGIN + 253, w: 82, align: "right" as const, label: "Reference" },
    { x: MARGIN + 338, w: 72, align: "right" as const, label: "Diff" },
    { x: MARGIN + 413, w: 94, align: "right" as const, label: "Change / Status" }
  ];

  const drawHeader = () => {
    cursor.ensureSpace(44);
    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, 20, 3).fillColor(COLORS.surface).fill();
    for (const c of cols) {
      cursor.text(c.label, c.x + 4, cursor.y + 6, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.muted, width: c.w - 6, align: c.align, lineBreak: false });
    }
    cursor.y += 23;
  };

  drawHeader();

  for (const r of rows) {
    if (cursor.y + 22 > CONTENT_BOTTOM) {
      cursor.addPage(false);
      drawHeader();
    }
    const diffStr = r.absoluteChange !== null
      ? `${r.absoluteChange >= 0 ? "+" : ""}${r.absoluteChange.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : "—";
    let statusStr = "Unavailable";
    let statusColor = COLORS.muted;
    if (r.baselineStatus === "zero_baseline") {
      statusStr = "Zero baseline";
    } else if (r.baselineStatus === "no_history") {
      statusStr = "No history";
    } else if (r.changePercent !== null) {
      const pct = `${r.changePercent >= 0 ? "+" : ""}${r.changePercent.toFixed(1)}%`;
      statusStr = r.isLossPosition ? `${pct} (Loss)` : pct;
      statusColor = r.outcome === "improved"
        ? (r.isLossPosition ? COLORS.amber : COLORS.green)
        : r.outcome === "declined"
          ? COLORS.red
          : COLORS.slate;
    }

    cursor.text(cleanText(r.name, 34), cols[0].x + 4, cursor.y + 3, { fontSize: 8, width: cols[0].w - 6, ellipsis: true, lineBreak: false });
    cursor.text(r.formattedCurrentValue || "Unavailable", cols[1].x + 4, cursor.y + 3, { fontSize: 8, width: cols[1].w - 6, align: "right", lineBreak: false });
    cursor.text(r.formattedComparisonValue || "N/A", cols[2].x + 4, cursor.y + 3, { fontSize: 8, fillColor: COLORS.muted, width: cols[2].w - 6, align: "right", lineBreak: false });
    cursor.text(diffStr, cols[3].x + 4, cursor.y + 3, { fontSize: 8, fillColor: COLORS.slate, width: cols[3].w - 6, align: "right", lineBreak: false });
    cursor.text(statusStr, cols[4].x + 4, cursor.y + 3, { font: "Helvetica-Bold", fontSize: 8, fillColor: statusColor, width: cols[4].w - 6, align: "right", lineBreak: false });
    cursor.doc.moveTo(MARGIN, cursor.y + 18).lineTo(PAGE_WIDTH - MARGIN, cursor.y + 18).strokeColor(COLORS.border).lineWidth(0.4).stroke();
    cursor.y += 20;
  }
  cursor.y += 8;
}

/* ============================================================================
 * 5. DAILY ALERTS & NOTIFICATIONS
 * ============================================================================ */

function renderAlertsSection(cursor: PdfLayoutCursor, alerts: DailyReportAlert[]): void {
  if (!alerts.length) return;

  cursor.drawSectionHeading("Daily Alerts & Notifications", `${alerts.length} domain-aware alert(s) evaluated for this reporting period`);

  for (const alert of alerts.slice(0, 12)) {
    const sevColor = alert.severity === "critical"
      ? COLORS.red
      : alert.severity === "warning"
        ? COLORS.amber
        : alert.severity === "positive"
          ? COLORS.green
          : COLORS.blue;
    const bg = alert.severity === "critical"
      ? COLORS.redBg
      : alert.severity === "warning"
        ? COLORS.amberBg
        : COLORS.white;

    const ackState = alert.acknowledgedAt ? "Acknowledged" : alert.isRead ? "Read" : "Unread";
    const metaLine = `${alert.metricLabel}: ${alert.metricValue}${alert.referenceValue !== null && alert.referenceValue !== undefined ? ` (Ref: ${alert.referenceValue})` : ""} · ${alert.periodLabel} · ${ackState}`;
    const msgH = cursor.measureHeight(cleanText(alert.message, 260), CONTENT_WIDTH - 24, 8);
    const cardH = msgH + 34;
    cursor.ensureSpace(cardH + 6);

    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, cardH, 5).fillColor(bg).fillAndStroke(COLORS.border);
    cursor.doc.rect(MARGIN, cursor.y, 4, cardH).fillColor(sevColor).fill();
    cursor.text(`[${alert.severity.toUpperCase()}] ${cleanText(alert.title, 70)}`, MARGIN + 12, cursor.y + 7, {
      font: "Helvetica-Bold",
      fontSize: 8.5,
      fillColor: COLORS.navy,
      width: CONTENT_WIDTH - 24,
      ellipsis: true,
      lineBreak: false
    });
    cursor.text(cleanText(alert.message, 260), MARGIN + 12, cursor.y + 19, {
      fontSize: 8,
      fillColor: COLORS.slate,
      width: CONTENT_WIDTH - 24,
      lineGap: 1.5
    });
    cursor.text(cleanText(metaLine, 120), MARGIN + 12, cursor.y + cardH - 13, {
      fontSize: 7,
      fillColor: COLORS.muted,
      width: CONTENT_WIDTH - 24,
      ellipsis: true,
      lineBreak: false
    });
    cursor.y += cardH + 6;
  }
}

/* ============================================================================
 * 6. ROOT CAUSE ANALYSIS
 * ============================================================================ */

function renderRootCauseSection(cursor: PdfLayoutCursor, rootCause: RootCauseAnalysisResult | null): void {
  if (!rootCause) return;

  cursor.drawSectionHeading("Root Cause Analysis", "Independent per-dimension contribution breakdown");

  if (!rootCause.available || rootCause.analyses.length === 0) {
    cursor.drawCallout(rootCause.unavailableReason || "Root cause breakdown is unavailable for this dataset or period.", {
      bg: COLORS.surface,
      border: COLORS.border,
      color: COLORS.muted
    });
    return;
  }

  for (const item of rootCause.analyses) {
    cursor.ensureSpace(50);
    cursor.text(
      `${item.metricName}: ${item.comparisonValue.toLocaleString("en-US")} -> ${item.currentValue.toLocaleString("en-US")} (${item.totalDelta >= 0 ? "+" : ""}${item.totalDelta.toLocaleString("en-US")})`,
      MARGIN,
      cursor.y,
      { font: "Helvetica-Bold", fontSize: 9.5, fillColor: COLORS.navy, width: CONTENT_WIDTH }
    );
    cursor.y += 14;
    const sumH = cursor.measureHeight(cleanText(item.summary, 300), CONTENT_WIDTH, 8);
    cursor.text(cleanText(item.summary, 300), MARGIN, cursor.y, { fontSize: 8, fillColor: COLORS.slate, width: CONTENT_WIDTH, lineGap: 1.5 });
    cursor.y += sumH + 6;

    const contributors = [...item.negativeContributors.slice(0, 4), ...item.positiveContributors.slice(0, 4)];
    if (contributors.length > 0) {
      cursor.ensureSpace(40);
      cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, 18, 3).fillColor(COLORS.surface).fill();
      cursor.text("Dimension & Group", MARGIN + 4, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.2, fillColor: COLORS.muted, width: 175, lineBreak: false });
      cursor.text("Ref", MARGIN + 185, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.2, fillColor: COLORS.muted, width: 65, align: "right", lineBreak: false });
      cursor.text("Current", MARGIN + 255, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.2, fillColor: COLORS.muted, width: 65, align: "right", lineBreak: false });
      cursor.text("Delta", MARGIN + 325, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.2, fillColor: COLORS.muted, width: 68, align: "right", lineBreak: false });
      cursor.text("Contrib / Note", MARGIN + 398, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.2, fillColor: COLORS.muted, width: 105, align: "right", lineBreak: false });
      cursor.y += 21;

      for (const c of contributors) {
        cursor.ensureSpace(20);
        const tag = c.appearance === "current_only" ? " [New]" : c.appearance === "comparison_only" ? " [Gone]" : "";
        const contrib = c.contributionPercent !== null ? `${c.contributionPercent >= 0 ? "+" : ""}${c.contributionPercent}%${tag}` : tag.trim() || "—";
        cursor.text(cleanText(`${c.dimensionLabel}: ${c.groupLabel}`, 38), MARGIN + 4, cursor.y + 2, { fontSize: 7.8, width: 178, ellipsis: true, lineBreak: false });
        cursor.text(c.comparisonValue.toLocaleString("en-US", { maximumFractionDigits: 2 }), MARGIN + 185, cursor.y + 2, { fontSize: 7.8, fillColor: COLORS.muted, width: 65, align: "right", lineBreak: false });
        cursor.text(c.currentValue.toLocaleString("en-US", { maximumFractionDigits: 2 }), MARGIN + 255, cursor.y + 2, { fontSize: 7.8, width: 65, align: "right", lineBreak: false });
        cursor.text(`${c.absoluteDelta >= 0 ? "+" : ""}${c.absoluteDelta.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, MARGIN + 325, cursor.y + 2, {
          font: "Helvetica-Bold",
          fontSize: 7.8,
          fillColor: c.direction === "positive" ? COLORS.green : COLORS.red,
          width: 68,
          align: "right",
          lineBreak: false
        });
        cursor.text(cleanText(contrib, 22), MARGIN + 398, cursor.y + 2, { fontSize: 7.5, fillColor: COLORS.slate, width: 105, align: "right", lineBreak: false });
        cursor.doc.moveTo(MARGIN, cursor.y + 16).lineTo(PAGE_WIDTH - MARGIN, cursor.y + 16).strokeColor(COLORS.border).lineWidth(0.4).stroke();
        cursor.y += 18;
      }
      cursor.y += 8;
    }
  }

  cursor.drawCallout(rootCause.causalityDisclaimer, {
    bg: COLORS.surface,
    border: COLORS.border,
    color: COLORS.muted,
    label: "Methodology Note"
  });
}

/* ============================================================================
 * 7. ACTIONABLE RECOMMENDATIONS
 * ============================================================================ */

function renderRecommendationsSection(cursor: PdfLayoutCursor, recommendations: ActionableRecommendation[]): void {
  if (!recommendations.length) return;

  cursor.drawSectionHeading("Actionable Recommendations", "Evidence-linked next steps derived from verified findings (not auto-executed)");

  for (const rec of recommendations.slice(0, 10)) {
    const prioColor = rec.priority === "critical" ? COLORS.red : rec.priority === "high" ? COLORS.amber : COLORS.blue;
    const body = [
      `Evidence: ${cleanText(rec.reason, 220)}`,
      rec.affectedDimension ? `Affected Area: ${cleanText(rec.affectedDimension, 120)}` : null,
      `Suggested Action: ${cleanText(rec.suggestedAction, 240)}`
    ].filter((l): l is string => Boolean(l)).join("\n");

    const bodyH = cursor.measureHeight(body, CONTENT_WIDTH - 24, 8, "Helvetica", 1.6);
    const cardH = bodyH + 28;
    cursor.ensureSpace(cardH + 6);

    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, cardH, 5).fillColor(COLORS.white).fillAndStroke(COLORS.border);
    cursor.doc.rect(MARGIN, cursor.y, 4, cardH).fillColor(prioColor).fill();
    cursor.text(`[${rec.priority.toUpperCase()}] ${cleanText(rec.title, 76)}`, MARGIN + 12, cursor.y + 7, {
      font: "Helvetica-Bold",
      fontSize: 8.5,
      fillColor: COLORS.navy,
      width: CONTENT_WIDTH - 105,
      ellipsis: true,
      lineBreak: false
    });
    cursor.text(`Evidence: ${rec.evidenceLevel}`, PAGE_WIDTH - MARGIN - 90, cursor.y + 8, {
      fontSize: 7,
      fillColor: COLORS.muted,
      width: 82,
      align: "right",
      lineBreak: false
    });
    cursor.text(body, MARGIN + 12, cursor.y + 20, {
      fontSize: 8,
      fillColor: COLORS.slate,
      width: CONTENT_WIDTH - 24,
      lineGap: 1.6
    });
    cursor.y += cardH + 6;
  }
}

/* ============================================================================
 * 8. DATA HEALTH MONITOR
 * ============================================================================ */

function renderDataHealthSection(cursor: PdfLayoutCursor, health: DataHealthReport | null, timezone: string): void {
  if (!health) return;

  cursor.drawSectionHeading(
    "Data Health Monitor",
    `Health Score: ${health.healthScore}/100 (${health.overallStatus.toUpperCase()}) · Expected cadence: ${health.expectedCadence}`
  );

  const freshnessSummary = [
    `Source Freshness: ${health.sourceFreshness.latestDate ? formatTimestamp(health.sourceFreshness.latestDate, timezone) : "Unknown"} (${health.sourceFreshness.status})`,
    `Report Generated: ${formatTimestamp(health.analysisGeneratedAt, timezone)}`,
    `Historical Coverage: ${health.historicalCoverage.earliestDate || "N/A"} to ${health.historicalCoverage.latestDate || "N/A"} (${health.historicalCoverage.coveredDays} day(s))`
  ].join("  ·  ");

  cursor.drawCallout(freshnessSummary, {
    bg: health.overallStatus === "critical" ? COLORS.redBg : health.overallStatus === "warning" ? COLORS.amberBg : COLORS.greenBg,
    border: health.overallStatus === "critical" ? COLORS.redBorder : health.overallStatus === "warning" ? COLORS.amberBorder : COLORS.greenBorder,
    color: COLORS.navy
  });

  if (health.historicalCoverage.expectedDatesMissing.length > 0) {
    cursor.drawCallout(
      `Missing expected reporting dates (${health.historicalCoverage.expectedDatesMissing.length}): ${health.historicalCoverage.expectedDatesMissing.slice(0, 10).join(", ")}${health.historicalCoverage.expectedDatesMissing.length > 10 ? "…" : ""}`,
      { bg: COLORS.amberBg, border: COLORS.amberBorder, color: COLORS.amber }
    );
  }

  for (const check of health.checks.slice(0, 10)) {
    const color = check.status === "critical" ? COLORS.red : check.status === "warning" ? COLORS.amber : check.status === "healthy" ? COLORS.green : COLORS.blue;
    const text = `${cleanText(check.explanation, 220)}${check.remediation && check.remediation !== "No action required." ? ` Remediation: ${cleanText(check.remediation, 150)}` : ""}`;
    const h = cursor.measureHeight(text, CONTENT_WIDTH - 24, 7.8) + 22;
    cursor.ensureSpace(h + 5);
    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, h, 4).fillColor(COLORS.white).fillAndStroke(COLORS.border);
    cursor.text(`[${check.status.toUpperCase()}] ${cleanText(check.title, 65)}${check.metricValue ? ` (${check.metricValue})` : ""}`, MARGIN + 10, cursor.y + 6, {
      font: "Helvetica-Bold",
      fontSize: 8,
      fillColor: color,
      width: CONTENT_WIDTH - 20,
      ellipsis: true,
      lineBreak: false
    });
    cursor.text(text, MARGIN + 10, cursor.y + 18, { fontSize: 7.8, fillColor: COLORS.slate, width: CONTENT_WIDTH - 20, lineGap: 1.4 });
    cursor.y += h + 5;
  }
}

/* ============================================================================
 * 9. NATIVE VECTOR CHARTS & HISTORICAL DASHBOARD CONTEXT
 * ============================================================================ */

function pickTrendSeries(timeSeries: TimeSeriesPoint[]): { metricKey: string; label: string; points: Array<{ date: string; value: number }> } | null {
  if (timeSeries.length < 2) return null;
  const preferredKeys = [
    "totalRevenue", "attributedRevenue", "totalIncome", "totalExpenses",
    "dau", "activeCustomers", "totalOrders", "clicks", "stockMovement", "onTimeDeliveryRate", "fulfillmentRate"
  ];
  const sampleKeys = Object.keys(timeSeries[0]?.metrics || {});
  const chosenKey = preferredKeys.find(k => sampleKeys.includes(k) && timeSeries.some(pt => typeof pt.metrics[k] === "number"))
    || sampleKeys.find(k => timeSeries.some(pt => typeof pt.metrics[k] === "number"));
  if (!chosenKey) return null;

  const points = timeSeries.map(pt => ({
    date: pt.date,
    value: safeNum(pt.metrics[chosenKey])
  }));
  const label = chosenKey.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
  return { metricKey: chosenKey, label, points };
}

function drawVectorTrendChart(
  cursor: PdfLayoutCursor,
  title: string,
  periodLabel: string,
  points: Array<{ date: string; value: number }>,
  color = COLORS.green
): void {
  if (points.length < 2) return;
  const chartH = 152;
  cursor.ensureSpace(chartH + 26);

  cursor.text(title, MARGIN, cursor.y, { font: "Helvetica-Bold", fontSize: 9.5, fillColor: COLORS.navy });
  cursor.text(`Period: ${periodLabel}`, PAGE_WIDTH - MARGIN - 180, cursor.y + 1, {
    fontSize: 7.5,
    fillColor: COLORS.muted,
    width: 180,
    align: "right",
    lineBreak: false
  });
  cursor.y += 15;

  const boxTop = cursor.y;
  cursor.doc.roundedRect(MARGIN, boxTop, CONTENT_WIDTH, chartH, 5).fillColor(COLORS.white).fillAndStroke(COLORS.border);

  const plotLeft = MARGIN + 52;
  const plotRight = PAGE_WIDTH - MARGIN - 16;
  const plotWidth = plotRight - plotLeft;
  const plotTop = boxTop + 18;
  const plotBottom = boxTop + chartH - 28;
  const plotHeight = plotBottom - plotTop;

  const values = points.map(p => p.value);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(...values, 1);
  const range = Math.max(maxVal - minVal, 1) * 1.12;
  const scaleMin = minVal < 0 ? minVal * 1.1 : 0;
  const scaleSpan = Math.max(range, 1);

  for (let i = 0; i <= 4; i += 1) {
    const gy = plotBottom - (i / 4) * plotHeight;
    const tickVal = scaleMin + (scaleSpan / 4) * i;
    cursor.doc.moveTo(plotLeft, gy).lineTo(plotRight, gy).strokeColor("#edf1f4").lineWidth(0.5).stroke();
    cursor.text(tickVal.toLocaleString("en-US", { maximumFractionDigits: 1 }), MARGIN + 4, gy - 4, {
      fontSize: 6.5,
      fillColor: COLORS.muted,
      width: 44,
      align: "right",
      lineBreak: false
    });
  }

  const plotted = points.map((p, idx) => ({
    x: plotLeft + (idx / Math.max(points.length - 1, 1)) * plotWidth,
    y: plotBottom - ((p.value - scaleMin) / scaleSpan) * plotHeight,
    date: p.date,
    value: p.value
  }));

  cursor.doc.moveTo(plotted[0].x, plotted[0].y);
  for (const pt of plotted.slice(1)) {
    cursor.doc.lineTo(pt.x, pt.y);
  }
  cursor.doc.strokeColor(color).lineWidth(1.8).stroke();

  if (plotted.length <= 35) {
    for (const pt of plotted) {
      cursor.doc.circle(pt.x, pt.y, 2.2).fillColor(color).fill();
    }
  }

  const step = Math.max(1, Math.ceil(plotted.length / 6));
  plotted.forEach((pt, idx) => {
    if (idx % step !== 0 && idx !== plotted.length - 1) return;
    cursor.text(pt.date.slice(5), pt.x - 24, plotBottom + 6, {
      fontSize: 6.8,
      fillColor: COLORS.muted,
      width: 48,
      align: "center",
      lineBreak: false
    });
  });

  cursor.y = boxTop + chartH + 12;
}

function drawHorizontalBreakdownChart(cursor: PdfLayoutCursor, breakdown: DimensionBreakdown): void {
  const items = breakdown.items.slice(0, 7);
  if (!items.length) return;
  const maxVal = Math.max(...items.map(i => Math.abs(i.primaryValue)), 1);
  const blockH = 26 + items.length * 19 + 10;
  cursor.ensureSpace(blockH);

  cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, blockH, 5).fillColor(COLORS.white).fillAndStroke(COLORS.border);
  cursor.text(`${breakdown.label} (${breakdown.sourceColumn})`, MARGIN + 10, cursor.y + 8, {
    font: "Helvetica-Bold",
    fontSize: 8.5,
    fillColor: COLORS.navy,
    width: CONTENT_WIDTH - 20,
    ellipsis: true,
    lineBreak: false
  });

  let rowY = cursor.y + 24;
  const labelW = 148;
  const barX = MARGIN + 162;
  const barMaxW = CONTENT_WIDTH - 266;
  const valX = PAGE_WIDTH - MARGIN - 96;

  for (const item of items) {
    const ratio = Math.min(1, Math.max(0.02, Math.abs(item.primaryValue) / maxVal));
    cursor.text(cleanText(item.label, 28), MARGIN + 10, rowY + 2, { fontSize: 7.8, fillColor: COLORS.ink, width: labelW, ellipsis: true, lineBreak: false });
    cursor.doc.roundedRect(barX, rowY + 4, barMaxW, 8, 2).fillColor("#edf1f4").fill();
    cursor.doc.roundedRect(barX, rowY + 4, Math.max(4, barMaxW * ratio), 8, 2).fillColor(COLORS.blue).fill();
    const valStr = `${item.primaryValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}${item.sharePercent !== null ? ` (${item.sharePercent.toFixed(0)}%)` : ""}`;
    cursor.text(valStr, valX, rowY + 2, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.slate, width: 88, align: "right", lineBreak: false });
    rowY += 19;
  }

  cursor.y += blockH + 10;
}

function renderHistoricalDashboardSection(
  cursor: PdfLayoutCursor,
  input: DynamicPdfReportInput
): void {
  const { metadata: meta, unified, historicalContext } = input;
  const primaryTrend = pickTrendSeries(unified.analysis.timeSeries);
  const hasPrimaryVisuals = Boolean(primaryTrend || unified.analysis.breakdowns.length > 0);

  if (hasPrimaryVisuals) {
    cursor.drawSectionHeading(
      "Performance Trends & Dimension Breakdowns (Primary Period)",
      `Primary Reporting Period: ${meta.periodLabel} · ${unified.analysis.source.rowCountInPeriod} record(s)`
    );
    if (primaryTrend) {
      drawVectorTrendChart(cursor, `${primaryTrend.label} Trend`, meta.periodLabel, primaryTrend.points, COLORS.green);
    }
    for (const breakdown of unified.analysis.breakdowns.slice(0, 4)) {
      drawHorizontalBreakdownChart(cursor, breakdown);
    }
  }

  // Clearly separated Historical Context section (e.g., Previous 30-Day Dashboard Context for Daily Reports)
  if (historicalContext) {
    cursor.drawSectionHeading(
      `Historical Dashboard & Statistics — ${historicalContext.label}`,
      `Historical Context Window: ${historicalContext.periodStart} to ${historicalContext.periodEnd} (${historicalContext.dayCount} days) — Separate from Primary Period (${meta.periodLabel})`
    );

    cursor.drawCallout(cleanText(historicalContext.sourceNote, 360), {
      bg: COLORS.blueBg,
      border: COLORS.border,
      color: COLORS.navy
    });

    if (historicalContext.metrics.length > 0) {
      renderKpiCards(
        cursor,
        historicalContext.metrics.slice(0, 6),
        `${historicalContext.label} — Key Statistics`,
        `${historicalContext.periodStart} to ${historicalContext.periodEnd} (${historicalContext.rowCount} record(s))`
      );
    }

    const histTrend = pickTrendSeries(historicalContext.timeSeries);
    if (histTrend) {
      drawVectorTrendChart(
        cursor,
        `${historicalContext.label} — ${histTrend.label} Trend`,
        `${historicalContext.periodStart} to ${historicalContext.periodEnd}`,
        histTrend.points,
        COLORS.blue
      );
    }

    for (const breakdown of historicalContext.breakdowns.slice(0, 2)) {
      drawHorizontalBreakdownChart(cursor, breakdown);
    }
  }
}

/* ============================================================================
 * 10. OPTIONAL ARCHIVED REPORT COMPARISON
 * ============================================================================ */

function renderArchivedComparisonSection(cursor: PdfLayoutCursor, cmp: ReportArchiveComparisonResult | null | undefined): void {
  if (!cmp) return;

  cursor.drawSectionHeading(
    "Archived Report Comparison",
    `Baseline: ${cmp.leftReport.periodStart} to ${cmp.leftReport.periodEnd} vs Selected: ${cmp.rightReport.periodStart} to ${cmp.rightReport.periodEnd}`
  );

  if (!cmp.compatible) {
    cursor.drawCallout(cmp.incompatibilityReason || "Selected archived reports are incompatible.", {
      bg: COLORS.redBg,
      border: COLORS.redBorder,
      color: COLORS.red
    });
    return;
  }

  cursor.drawCallout(cleanText(cmp.summary, 320), { bg: COLORS.blueBg, border: COLORS.border, color: COLORS.navy });

  if (cmp.compatibilityWarnings.length > 0) {
    cursor.drawCallout(cleanText(cmp.compatibilityWarnings.join(" | "), 320), {
      bg: COLORS.amberBg,
      border: COLORS.amberBorder,
      color: COLORS.amber,
      label: "Compatibility Note"
    });
  }

  if (cmp.newlyAvailableMetrics.length > 0) {
    cursor.drawCallout(cmp.newlyAvailableMetrics.join(", "), {
      bg: COLORS.greenBg,
      border: COLORS.greenBorder,
      color: COLORS.green,
      label: "Newly Available Metrics"
    });
  }

  if (cmp.becameUnavailableMetrics.length > 0) {
    cursor.drawCallout(cmp.becameUnavailableMetrics.join(", "), {
      bg: COLORS.amberBg,
      border: COLORS.amberBorder,
      color: COLORS.amber,
      label: "Became Unavailable"
    });
  }

  const comparedRows = cmp.metrics.filter(m => m.status === "compared" || m.status === "zero_baseline");
  if (comparedRows.length > 0) {
    cursor.ensureSpace(40);
    cursor.doc.roundedRect(MARGIN, cursor.y, CONTENT_WIDTH, 18, 3).fillColor(COLORS.surface).fill();
    cursor.text("Metric", MARGIN + 4, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.muted, width: 175, lineBreak: false });
    cursor.text("Baseline", MARGIN + 185, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.muted, width: 85, align: "right", lineBreak: false });
    cursor.text("Selected", MARGIN + 275, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.muted, width: 85, align: "right", lineBreak: false });
    cursor.text("Delta / %", MARGIN + 365, cursor.y + 5, { font: "Helvetica-Bold", fontSize: 7.5, fillColor: COLORS.muted, width: 138, align: "right", lineBreak: false });
    cursor.y += 21;

    for (const row of comparedRows) {
      cursor.ensureSpace(20);
      const deltaStr = row.status === "zero_baseline"
        ? `${row.absoluteDelta !== null ? (row.absoluteDelta >= 0 ? "+" : "") + row.absoluteDelta : "—"} (zero base)`
        : `${row.absoluteDelta !== null ? (row.absoluteDelta >= 0 ? "+" : "") + row.absoluteDelta : "—"} (${row.changePercent !== null ? (row.changePercent >= 0 ? "+" : "") + row.changePercent.toFixed(1) + "%" : "N/A"})`;
      cursor.text(cleanText(row.name, 34), MARGIN + 4, cursor.y + 2, { fontSize: 8, width: 178, ellipsis: true, lineBreak: false });
      cursor.text(row.formattedLeftValue || "N/A", MARGIN + 185, cursor.y + 2, { fontSize: 8, fillColor: COLORS.muted, width: 85, align: "right", lineBreak: false });
      cursor.text(row.formattedRightValue || "N/A", MARGIN + 275, cursor.y + 2, { fontSize: 8, width: 85, align: "right", lineBreak: false });
      cursor.text(cleanText(deltaStr, 28), MARGIN + 365, cursor.y + 2, { font: "Helvetica-Bold", fontSize: 7.8, fillColor: COLORS.slate, width: 138, align: "right", lineBreak: false });
      cursor.doc.moveTo(MARGIN, cursor.y + 16).lineTo(PAGE_WIDTH - MARGIN, cursor.y + 16).strokeColor(COLORS.border).lineWidth(0.4).stroke();
      cursor.y += 18;
    }
    cursor.y += 8;
  }
}

/* ============================================================================
 * PUBLIC RENDERER
 * ============================================================================ */

export async function renderDynamicAnalysisPdf(input: DynamicPdfReportInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    autoFirstPage: false,
    info: {
      Title: `QueryPilot X - ${input.metadata.domainName} Report (${input.metadata.periodLabel})`,
      Author: "QueryPilot X"
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const cursor = new PdfLayoutCursor(doc, input.metadata);

  // 1. Cover Page
  renderCoverPage(cursor, input);

  // 2. Executive Summary + Dynamic KPIs
  cursor.addPage(false);
  renderIntelligenceBrief(cursor, input.unified);
  renderKpiCards(
    cursor,
    input.unified.analysis.availableMetrics,
    `${input.metadata.domainName} — Key Performance Indicators`,
    `Primary Period: ${input.metadata.periodLabel} · Showing verified available metrics only`
  );
  renderDomainSpecificBlocks(cursor, input.unified);

  // 3. Smart Day Comparison
  renderSmartComparison(cursor, input.unified.tools.smartComparison);

  // 4. Daily Alerts & Notifications
  renderAlertsSection(cursor, input.unified.tools.alerts);

  // 5. Root Cause Analysis
  renderRootCauseSection(cursor, input.unified.tools.rootCause);

  // 6. Actionable Recommendations
  renderRecommendationsSection(cursor, input.unified.tools.recommendations);

  // 7. Data Health Monitor
  renderDataHealthSection(cursor, input.unified.tools.dataHealth, input.metadata.timezone);

  // 8. Historical Dashboard, Dynamic Vector Charts & 30-Day Historical Context
  renderHistoricalDashboardSection(cursor, input);

  // 9. Optional Explicitly Selected Archived Report Comparison
  renderArchivedComparisonSection(cursor, input.archivedComparison);

  // 10. Methodology & Governance Notes
  cursor.drawSectionHeading("Calculation Notes & Governance");
  const notes = [
    `All metrics are calculated from live read-only records in "${input.metadata.datasetTable}" (${input.metadata.timezone}).`,
    "Unavailable metrics caused by missing columns or insufficient records are explicitly excluded and never fabricated as zero.",
    "Percentage changes are shown only when the comparison baseline is non-zero and mathematically valid.",
    "Root Cause contributions reflect statistical decomposition across available dimensions and do not prove underlying causation.",
    "This report contains aggregated business metrics only; personal identifiers, credentials, and raw confidential records are excluded."
  ];
  for (const note of notes) {
    const h = cursor.measureHeight(`• ${note}`, CONTENT_WIDTH, 8);
    cursor.ensureSpace(h + 4);
    cursor.text(`• ${note}`, MARGIN, cursor.y, { fontSize: 8, fillColor: COLORS.muted, width: CONTENT_WIDTH, lineGap: 1.5 });
    cursor.y += h + 4;
  }

  doc.end();
  return finished;
}
