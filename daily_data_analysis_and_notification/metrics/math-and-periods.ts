import type {
  ComparisonPreset,
  ComparisonWindow,
  MetricFormat,
  MetricUnit,
  PeriodWindow,
  TrendDirection
} from "./types";

const DEFAULT_TIMEZONE = "Asia/Dhaka";

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertValidTimezone(timezone: string): string {
  const tz = timezone.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new Error(`Invalid IANA timezone: "${timezone}".`);
  }
}

export function todayInTimezone(timezone = DEFAULT_TIMEZONE, now = new Date()): string {
  const tz = assertValidTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDaysToDate(date: string, deltaDays: number): string {
  if (!isValidIsoDate(date)) throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD.`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start: string, end: string): number {
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    throw new Error("Dates must use YYYY-MM-DD.");
  }
  if (start > end) {
    throw new Error("Start date must not be after end date.");
  }
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

export function enumerateDates(start: string, end: string): string[] {
  const count = daysBetweenInclusive(start, end);
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(addDaysToDate(start, i));
  }
  return result;
}

export function toDateKeyInTimezone(value: unknown, timezone = DEFAULT_TIMEZONE): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : todayInTimezone(timezone, value);
  }
  const text = String(value).trim();
  if (!text) return null;
  const plain = text.slice(0, 10);
  if (isValidIsoDate(plain) && (text.length === 10 || /^[T ]00:00:00(?:\.0+)?Z?$/.test(text.slice(10)))) {
    return plain;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return todayInTimezone(timezone, parsed);
}

export function parseTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  const text = String(value).trim();
  if (!text) return null;
  if (isValidIsoDate(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function buildPeriodWindow(start: string, end: string, timezone = DEFAULT_TIMEZONE): PeriodWindow {
  const tz = assertValidTimezone(timezone);
  const dayCount = daysBetweenInclusive(start, end);
  return {
    start,
    end,
    timezone: tz,
    dayCount,
    label: start === end ? start : `${start} to ${end}`
  };
}

function previousCompletedMonthWindow(referenceDate: string): { start: string; end: string } {
  const ref = new Date(`${referenceDate}T00:00:00.000Z`);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth(); // 0-indexed; previous month is month - 1
  const firstOfPrev = new Date(Date.UTC(year, month - 1, 1));
  const lastOfPrev = new Date(Date.UTC(year, month, 0));
  return {
    start: firstOfPrev.toISOString().slice(0, 10),
    end: lastOfPrev.toISOString().slice(0, 10)
  };
}

function previousCompletedWeekWindow(referenceDate: string): { start: string; end: string } {
  const ref = new Date(`${referenceDate}T00:00:00.000Z`);
  // ISO week starts Monday (1) .. Sunday (7)
  const isoDay = ref.getUTCDay() || 7;
  const startOfCurrentWeek = addDaysToDate(referenceDate, -(isoDay - 1));
  const end = addDaysToDate(startOfCurrentWeek, -1);
  const start = addDaysToDate(end, -6);
  return { start, end };
}

export function resolveComparisonWindow(
  period: PeriodWindow,
  preset: ComparisonPreset = "previous_30_days",
  customStart?: string,
  customEnd?: string
): ComparisonWindow | null {
  if (preset === "none") return null;

  if (preset === "custom") {
    if (!customStart || !customEnd || !isValidIsoDate(customStart) || !isValidIsoDate(customEnd) || customStart > customEnd) {
      throw new Error("Custom comparison period requires valid YYYY-MM-DD start and end dates with start <= end.");
    }
    const dayCount = daysBetweenInclusive(customStart, customEnd);
    return {
      preset,
      start: customStart,
      end: customEnd,
      timezone: period.timezone,
      dayCount,
      label: customStart === customEnd ? customStart : `${customStart} to ${customEnd}`
    };
  }

  if (preset === "same_weekday_previous_weeks") {
    const weeks = 4;
    const matchingDates: string[] = [];
    for (let week = weeks; week >= 1; week -= 1) {
      const targetStart = addDaysToDate(period.start, -7 * week);
      const targetEnd = addDaysToDate(period.end, -7 * week);
      matchingDates.push(...enumerateDates(targetStart, targetEnd));
    }
    const uniqueDates = [...new Set(matchingDates)].sort();
    const start = uniqueDates[0];
    const end = uniqueDates[uniqueDates.length - 1];
    return {
      preset,
      start,
      end,
      timezone: period.timezone,
      dayCount: uniqueDates.length,
      label: `Same weekday (previous ${weeks} weeks)`,
      matchingDates: uniqueDates
    };
  }

  let start: string;
  let end: string;
  let label: string;

  switch (preset) {
    case "previous_day": {
      end = addDaysToDate(period.start, -1);
      start = end;
      label = `Previous day (${start})`;
      break;
    }
    case "previous_week": {
      const prevWeek = previousCompletedWeekWindow(period.start);
      start = prevWeek.start;
      end = prevWeek.end;
      label = `Previous week (${start} to ${end})`;
      break;
    }
    case "previous_month": {
      const prevMonth = previousCompletedMonthWindow(period.start);
      start = prevMonth.start;
      end = prevMonth.end;
      label = `Previous month (${start} to ${end})`;
      break;
    }
    case "previous_7_days": {
      end = addDaysToDate(period.start, -1);
      start = addDaysToDate(period.start, -7);
      label = `Previous 7 days (${start} to ${end})`;
      break;
    }
    case "previous_30_days": {
      end = addDaysToDate(period.start, -1);
      start = addDaysToDate(period.start, -30);
      label = `Previous 30 days (${start} to ${end})`;
      break;
    }
    case "previous_90_days": {
      end = addDaysToDate(period.start, -1);
      start = addDaysToDate(period.start, -90);
      label = `Previous 90 days (${start} to ${end})`;
      break;
    }
    case "previous_365_days": {
      end = addDaysToDate(period.start, -1);
      start = addDaysToDate(period.start, -365);
      label = `Previous 365 days (${start} to ${end})`;
      break;
    }
  }

  return {
    preset,
    start,
    end,
    timezone: period.timezone,
    dayCount: daysBetweenInclusive(start, end),
    label
  };
}

/**
 * Precision-safe rounding to mitigate floating-point drift in financial sums/ratios.
 */
export function safeRound(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Sums monetary/decimal values using scaled integer arithmetic where safe to minimize IEEE-754 drift.
 */
export function safeSum(values: number[], decimals = 4): number {
  const factor = 10 ** decimals;
  let scaledTotal = 0;
  let useFloatFallback = false;

  for (const val of values) {
    if (!Number.isFinite(val)) continue;
    const scaled = Math.round(val * factor);
    if (!Number.isSafeInteger(scaled) || !Number.isSafeInteger(scaledTotal + scaled)) {
      useFloatFallback = true;
      break;
    }
    scaledTotal += scaled;
  }

  if (!useFloatFallback) {
    return safeRound(scaledTotal / factor, 2);
  }
  return safeRound(values.reduce((acc, v) => (Number.isFinite(v) ? acc + v : acc), 0), 2);
}

export function safeDivide(numerator: number | null, denominator: number | null, decimals = 2): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? safeRound(result, decimals) : null;
}

export function safePercent(numerator: number | null, denominator: number | null, decimals = 2): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const result = (numerator / denominator) * 100;
  return Number.isFinite(result) ? safeRound(result, decimals) : null;
}

/**
 * Computes percentage change only when the comparison baseline is strictly non-zero and finite.
 */
export function safeChangePercent(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(comparison) || comparison === 0) return null;
  const delta = ((current - comparison) / Math.abs(comparison)) * 100;
  return Number.isFinite(delta) ? safeRound(delta, 2) : null;
}

export function determineTrendDirection(changePercent: number | null): TrendDirection {
  if (changePercent === null || !Number.isFinite(changePercent)) return "unavailable";
  if (Math.abs(changePercent) < 0.05) return "flat";
  return changePercent > 0 ? "up" : "down";
}

export function formatMetricValue(value: number | null, format: MetricFormat, unit: MetricUnit): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  switch (format) {
    case "currency":
      return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "percentage":
      return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;
    case "count":
    case "quantity":
      return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    case "ratio":
      return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
    case "duration": {
      const formatted = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (unit === "hours") return `${formatted} hrs`;
      if (unit === "days") return `${formatted} days`;
      if (unit === "seconds") return `${formatted} s`;
      return formatted;
    }
  }
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "t"].includes(text)) return true;
  if (["false", "0", "no", "n", "f"].includes(text)) return false;
  return null;
}

export function toCleanString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}
