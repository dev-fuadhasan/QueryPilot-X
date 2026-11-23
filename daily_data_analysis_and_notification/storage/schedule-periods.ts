import {
  addDaysToDate,
  assertValidTimezone,
  isValidIsoDate,
  todayInTimezone
} from "../metrics/math-and-periods";
import type { ManualQuickRange, PersistentDailySettings, ReportFrequency } from "./types";

export const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Dhaka";
export const DEFAULT_SCHEDULE_TIME = "00:15";

export type CompletedPeriod = {
  frequency: ReportFrequency;
  periodStart: string;
  periodEnd: string;
  reportingDate: string;
};

export function currentClockInTimezone(timezone = DEFAULT_SCHEDULE_TIMEZONE, now = new Date()): {
  date: string;
  time: string;
  hour: number;
  minute: number;
} {
  const tz = assertValidTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const hourStr = (parts.hour === "24" ? "00" : parts.hour || "00").padStart(2, "0");
  const minStr = (parts.minute || "00").padStart(2, "0");
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hourStr}:${minStr}`,
    hour: Number(hourStr),
    minute: Number(minStr)
  };
}

export function validateScheduledTime(value: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    throw new Error("scheduledTime must use 24-hour HH:mm format.");
  }
  return value.trim();
}

/**
 * Computes the latest COMPLETED calendar period in the organisation's IANA timezone:
 * - daily: previous completed calendar day (yesterday)
 * - weekly: previous completed Monday..Sunday calendar week
 * - monthly: previous completed calendar month (1st..last day)
 * Never includes the incomplete current day, week, or month.
 */
export function getPreviousCompletedPeriod(
  frequency: ReportFrequency,
  timezone = DEFAULT_SCHEDULE_TIMEZONE,
  now = new Date()
): CompletedPeriod {
  const today = todayInTimezone(timezone, now);

  if (frequency === "daily") {
    const yesterday = addDaysToDate(today, -1);
    return {
      frequency,
      periodStart: yesterday,
      periodEnd: yesterday,
      reportingDate: yesterday
    };
  }

  if (frequency === "weekly") {
    const ref = new Date(`${today}T00:00:00.000Z`);
    // Monday=1 .. Sunday=7
    const isoDay = ref.getUTCDay() || 7;
    const currentWeekMonday = addDaysToDate(today, -(isoDay - 1));
    const prevWeekSunday = addDaysToDate(currentWeekMonday, -1);
    const prevWeekMonday = addDaysToDate(prevWeekSunday, -6);
    return {
      frequency,
      periodStart: prevWeekMonday,
      periodEnd: prevWeekSunday,
      reportingDate: prevWeekSunday
    };
  }

  // monthly: previous completed calendar month
  const ref = new Date(`${today}T00:00:00.000Z`);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth(); // 0..11; Date.UTC(year, month, 0) is last day of previous month
  const firstOfPrev = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const lastOfPrev = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    frequency,
    periodStart: firstOfPrev,
    periodEnd: lastOfPrev,
    reportingDate: lastOfPrev
  };
}

function nextPeriodAfter(frequency: ReportFrequency, periodEnd: string): CompletedPeriod {
  if (frequency === "daily") {
    const nextDay = addDaysToDate(periodEnd, 1);
    return { frequency, periodStart: nextDay, periodEnd: nextDay, reportingDate: nextDay };
  }
  if (frequency === "weekly") {
    const nextMon = addDaysToDate(periodEnd, 1);
    const nextSun = addDaysToDate(nextMon, 6);
    return { frequency, periodStart: nextMon, periodEnd: nextSun, reportingDate: nextSun };
  }
  // monthly: periodEnd is the last day of a month; +1 day is the 1st of the next month
  const nextFirst = addDaysToDate(periodEnd, 1);
  const dt = new Date(`${nextFirst}T00:00:00.000Z`);
  const nextLast = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { frequency, periodStart: nextFirst, periodEnd: nextLast, reportingDate: nextLast };
}

/**
 * Enumerates all missed completed periods in chronological order between `lastCompletedPeriodEnd`
 * and `latestCompletedPeriod` (bounded safely by `maxCatchUp` to prevent runaway catch-up storms).
 */
export function enumerateDuePeriods(
  frequency: ReportFrequency,
  lastCompletedPeriodEnd: string | null,
  timezone = DEFAULT_SCHEDULE_TIMEZONE,
  now = new Date(),
  maxCatchUp = 14
): CompletedPeriod[] {
  const latest = getPreviousCompletedPeriod(frequency, timezone, now);
  if (!lastCompletedPeriodEnd) {
    return [latest];
  }
  if (lastCompletedPeriodEnd >= latest.periodEnd) {
    return [];
  }

  const periods: CompletedPeriod[] = [];
  let cursor = nextPeriodAfter(frequency, lastCompletedPeriodEnd);
  while (cursor.periodEnd <= latest.periodEnd && periods.length < Math.max(1, maxCatchUp)) {
    periods.push(cursor);
    cursor = nextPeriodAfter(frequency, cursor.periodEnd);
  }
  return periods;
}

/**
 * Determines whether a scheduled configuration is due to execute at `now` in its configured timezone:
 * - For the current completed period, checks that local wall clock time >= `scheduledTime` (or that
 *   a previous day/week/month was already missed and needs catch-up immediately).
 */
export function isScheduleDueNow(
  settings: Pick<PersistentDailySettings, "frequency" | "scheduledTime" | "timezone" | "autoReportEnabled">,
  lastCompletedPeriodEnd: string | null,
  now = new Date()
): boolean {
  if (!settings.autoReportEnabled) return false;
  const latest = getPreviousCompletedPeriod(settings.frequency, settings.timezone, now);
  if (lastCompletedPeriodEnd && lastCompletedPeriodEnd >= latest.periodEnd) {
    return false;
  }

  const clock = currentClockInTimezone(settings.timezone, now);
  const dueTime = validateScheduledTime(settings.scheduledTime);

  // For daily reports, the period ended yesterday, so today is the generation day: wait until clock.time >= dueTime
  // If more than 1 period was missed, run immediately for catch-up!
  const expectedRunDate = addDaysToDate(latest.periodEnd, 1);
  if (clock.date > expectedRunDate) return true;
  if (clock.date === expectedRunDate) return clock.time >= dueTime;
  return false;
}

export function buildScheduledExecutionKey(input: {
  organizationId: string;
  frequency: ReportFrequency;
  periodStart: string;
  periodEnd: string;
  domainId: string;
  datasetTable: string;
}): string {
  return [
    "sched",
    input.organizationId,
    input.frequency,
    input.periodStart,
    input.periodEnd,
    input.domainId,
    input.datasetTable
  ].join("|");
}

/**
 * Resolves manual report quick ranges or custom start/end dates in the organisation timezone.
 * Rejects malformed ranges, inverted ranges, and future dates beyond today in the org timezone.
 */
export function resolveManualReportPeriod(input: {
  quickRange: ManualQuickRange;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  earliestAvailableDate?: string | null;
  latestAvailableDate?: string | null;
  now?: Date;
}): { periodStart: string; periodEnd: string; reportingDate: string } {
  const tz = assertValidTimezone(input.timezone || DEFAULT_SCHEDULE_TIMEZONE);
  const today = todayInTimezone(tz, input.now || new Date());

  if (input.quickRange === "custom") {
    const start = input.startDate?.trim() || "";
    const end = input.endDate?.trim() || "";
    if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
      throw new Error("Custom manual reports require valid YYYY-MM-DD startDate and endDate.");
    }
    if (start > end) {
      throw new Error("startDate must not be after endDate.");
    }
    if (end > today) {
      throw new Error(`endDate (${end}) cannot be in the future beyond ${today} (${tz}).`);
    }
    return { periodStart: start, periodEnd: end, reportingDate: end };
  }

  const latest = input.latestAvailableDate && isValidIsoDate(input.latestAvailableDate) && input.latestAvailableDate <= today
    ? input.latestAvailableDate
    : today;

  if (input.quickRange === "all_history") {
    const earliest = input.earliestAvailableDate && isValidIsoDate(input.earliestAvailableDate)
      ? input.earliestAvailableDate
      : latest;
    const periodStart = earliest <= latest ? earliest : latest;
    return { periodStart, periodEnd: latest, reportingDate: latest };
  }

  const lookbackDays: Record<Exclude<ManualQuickRange, "custom" | "all_history">, number> = {
    last_7_days: 6,
    last_30_days: 29,
    last_90_days: 89,
    last_365_days: 364
  };
  const end = today;
  const start = addDaysToDate(end, -lookbackDays[input.quickRange]);
  return { periodStart: start, periodEnd: end, reportingDate: end };
}
