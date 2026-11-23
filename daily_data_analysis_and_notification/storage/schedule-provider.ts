import { addDaysToDate, assertValidTimezone, todayInTimezone } from "../metrics/math-and-periods";
import {
  currentClockInTimezone,
  DEFAULT_SCHEDULE_TIMEZONE,
  getPreviousCompletedPeriod,
  validateScheduledTime,
  type CompletedPeriod
} from "./schedule-periods";
import type { PersistentDailySettings, PersistentReportSummary, ReportFrequency, StorageCapabilityStatus } from "./types";

export type ScheduleProviderEngine =
  | "vercel_schedules"
  | "vercel_hobby_daily_cron"
  | "local_unconfigured";

export type VercelSchedulesReadiness = {
  sdkInstalled: boolean;
  queueConfigured: boolean;
  supportedByPlan: boolean;
  hobbyMinCadenceMinutes: number;
  hobbyMaxDynamicSchedulesPerCycle: number;
  hobbyMaxRunsPerCycle: number;
  requiredPackages: string[];
  requiredVercelConfig: string;
  blocker: string | null;
  docsUrl: string;
};

export type ScheduleProviderStatus = {
  engine: ScheduleProviderEngine;
  supportsExactMinutePrecision: boolean;
  supportsUserSelectedTime: boolean;
  fallbackCronExpression: string;
  precisionNotice: string;
  vercelSchedules: VercelSchedulesReadiness;
};

export type DynamicScheduleSyncResult = {
  action: "upserted" | "disabled" | "fallback_persisted";
  providerEngine: ScheduleProviderEngine;
  externalScheduleId: string | null;
  namespace: string;
  cronExpression: string;
  timezone: string;
  appliedExactTiming: boolean;
  notice: string;
};

export type NextScheduledExecutionInfo = {
  nextNominalRunDate: string;
  nextNominalRunTime: string;
  timezone: string;
  targetPeriod: CompletedPeriod;
  willExecuteImmediatelyOnNextTrigger: boolean;
  cronExpressionInOrgTimezone: string;
};

export type ScheduleRuntimeSummary = {
  active: boolean;
  persisted: boolean;
  providerStatus: ScheduleProviderStatus;
  nextExecution: NextScheduledExecutionInfo | null;
  latestAutomaticReport: PersistentReportSummary | null;
  lastSync: DynamicScheduleSyncResult | null;
};

export interface DynamicScheduleProvider {
  readonly engine: ScheduleProviderEngine;
  getProviderStatus(storageStatus: StorageCapabilityStatus): ScheduleProviderStatus;
  upsertSchedule(settings: PersistentDailySettings, storageStatus: StorageCapabilityStatus): Promise<DynamicScheduleSyncResult>;
  disableSchedule(organizationId: string, frequency: ReportFrequency, timezone: string): Promise<DynamicScheduleSyncResult>;
}

export const FALLBACK_VERCEL_HOBBY_CRON = "15 18 * * *";
export const VERCEL_SCHEDULES_DOCS_URL = "https://vercel.com/changelog/vercel-schedules-is-now-in-public-beta";

/**
 * Deterministic, tenant-isolated schedule name preventing duplicate schedule creation
 * per organisation + frequency.
 */
export function buildOrganizationScheduleKey(organizationId: string, frequency: ReportFrequency): {
  namespace: string;
  name: string;
  externalId: string;
} {
  const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "org";
  const namespace = `qp_org_${safeOrg}`;
  const name = `daily-analysis-${frequency}`;
  return {
    namespace,
    name,
    externalId: `${namespace}:${name}`
  };
}

/**
 * Translates a user-selected frequency + HH:mm wall-clock time into a standard 5-field
 * cron expression in the organisation's IANA timezone (compatible with Vercel Schedules
 * `expression: { type: "cron", cron, timezone }` when enabled):
 * - daily:   `<min> <hour> * * *`
 * - weekly:  `<min> <hour> * * 1` (Monday after completed Monday–Sunday week)
 * - monthly: `<min> <hour> 1 * *` (1st of month after completed calendar month)
 */
export function buildTimezoneCronExpression(frequency: ReportFrequency, scheduledTime: string): string {
  const valid = validateScheduledTime(scheduledTime);
  const [hourRaw, minuteRaw] = valid.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (frequency === "weekly") return `${minute} ${hour} * * 1`;
  if (frequency === "monthly") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

/**
 * Computes the next nominal execution date/time and the completed reporting period it will
 * cover in the organisation's configured IANA timezone. Never includes an incomplete period.
 */
export function computeNextScheduledExecution(
  settings: Pick<PersistentDailySettings, "frequency" | "scheduledTime" | "timezone" | "autoReportEnabled">,
  lastCompletedPeriodEnd: string | null,
  now = new Date()
): NextScheduledExecutionInfo | null {
  if (!settings.autoReportEnabled) return null;
  const tz = assertValidTimezone(settings.timezone || DEFAULT_SCHEDULE_TIMEZONE);
  const time = validateScheduledTime(settings.scheduledTime);
  const clock = currentClockInTimezone(tz, now);
  const latestCompleted = getPreviousCompletedPeriod(settings.frequency, tz, now);
  const cronExpressionInOrgTimezone = buildTimezoneCronExpression(settings.frequency, time);

  // If the latest completed period has not yet been generated, target it first
  if (!lastCompletedPeriodEnd || lastCompletedPeriodEnd < latestCompleted.periodEnd) {
    const nominalRunDate = addDaysToDate(latestCompleted.periodEnd, 1);
    const overdue = clock.date > nominalRunDate || (clock.date === nominalRunDate && clock.time >= time);
    return {
      nextNominalRunDate: overdue ? clock.date : nominalRunDate,
      nextNominalRunTime: time,
      timezone: tz,
      targetPeriod: latestCompleted,
      willExecuteImmediatelyOnNextTrigger: overdue,
      cronExpressionInOrgTimezone
    };
  }

  // Otherwise, compute the next future completed period and its first eligible run date
  const today = todayInTimezone(tz, now);
  if (settings.frequency === "daily") {
    const nextRunDate = addDaysToDate(today, 1);
    return {
      nextNominalRunDate: nextRunDate,
      nextNominalRunTime: time,
      timezone: tz,
      targetPeriod: {
        frequency: "daily",
        periodStart: today,
        periodEnd: today,
        reportingDate: today
      },
      willExecuteImmediatelyOnNextTrigger: false,
      cronExpressionInOrgTimezone
    };
  }

  if (settings.frequency === "weekly") {
    const ref = new Date(`${today}T00:00:00.000Z`);
    const isoDay = ref.getUTCDay() || 7; // Mon=1..Sun=7
    const currentWeekMonday = addDaysToDate(today, -(isoDay - 1));
    const currentWeekSunday = addDaysToDate(currentWeekMonday, 6);
    const nextMonday = addDaysToDate(currentWeekSunday, 1);
    return {
      nextNominalRunDate: nextMonday,
      nextNominalRunTime: time,
      timezone: tz,
      targetPeriod: {
        frequency: "weekly",
        periodStart: currentWeekMonday,
        periodEnd: currentWeekSunday,
        reportingDate: currentWeekSunday
      },
      willExecuteImmediatelyOnNextTrigger: false,
      cronExpressionInOrgTimezone
    };
  }

  // monthly: completes on last day of current month, runs on 1st of next month
  const ref = new Date(`${today}T00:00:00.000Z`);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth();
  const currentMonthFirst = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const currentMonthLast = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const nextMonthFirst = addDaysToDate(currentMonthLast, 1);
  return {
    nextNominalRunDate: nextMonthFirst,
    nextNominalRunTime: time,
    timezone: tz,
    targetPeriod: {
      frequency: "monthly",
      periodStart: currentMonthFirst,
      periodEnd: currentMonthLast,
      reportingDate: currentMonthLast
    },
    willExecuteImmediatelyOnNextTrigger: false,
    cronExpressionInOrgTimezone
  };
}

export function getVercelSchedulesReadiness(): VercelSchedulesReadiness {
  const queueTopicConfigured = Boolean(process.env.VERCEL_SCHEDULES_QUEUE_TOPIC?.trim());
  const sdkInstalled = false; // @vercel/schedules and @vercel/queue require explicit dependency approval
  return {
    sdkInstalled,
    queueConfigured: queueTopicConfigured,
    supportedByPlan: true, // Public beta announced 5 Nov 2026 supports dynamic schedules on all Vercel plans
    hobbyMinCadenceMinutes: 15,
    hobbyMaxDynamicSchedulesPerCycle: 500,
    hobbyMaxRunsPerCycle: 5000,
    requiredPackages: ["@vercel/schedules", "@vercel/queue"],
    requiredVercelConfig: "functions queue/v2beta trigger bound to a Vercel Queue topic",
    blocker:
      "Dynamic runtime scheduling via Vercel Schedules requires installing official packages (@vercel/schedules and @vercel/queue) and configuring a Vercel Queue topic with a queue/v2beta consumer trigger.",
    docsUrl: VERCEL_SCHEDULES_DOCS_URL
  };
}

/**
 * Production-safe fallback provider that integrates cleanly with Stage 4's persistent
 * schedule settings, durable execution ledger, and Stage 5's Hobby-compatible daily
 * Vercel Cron (`15 18 * * *` -> `/api/daily-analysis/scheduler/run`).
 *
 * It never falsely claims exact custom-minute execution when running on traditional Hobby Cron.
 */
export class VercelHobbyCronFallbackProvider implements DynamicScheduleProvider {
  readonly engine: ScheduleProviderEngine = "vercel_hobby_daily_cron";

  getProviderStatus(storageStatus: StorageCapabilityStatus): ScheduleProviderStatus {
    const vercelSchedules = getVercelSchedulesReadiness();
    if (!storageStatus.schedulerProductionReady) {
      return {
        engine: "local_unconfigured",
        supportsExactMinutePrecision: false,
        supportsUserSelectedTime: false,
        fallbackCronExpression: FALLBACK_VERCEL_HOBBY_CRON,
        precisionNotice:
          "Production scheduler environment variables are not configured yet. Schedule preferences are saved to the local development repository, while production automatic execution requires configuring the missing environment variables.",
        vercelSchedules
      };
    }

    return {
      engine: "vercel_hobby_daily_cron",
      supportsExactMinutePrecision: false,
      supportsUserSelectedTime: false,
      fallbackCronExpression: FALLBACK_VERCEL_HOBBY_CRON,
      precisionNotice:
        "Running on traditional Vercel Hobby daily Cron (15 18 * * * UTC, once per day within the 18:00–18:59 UTC / 00:00–00:59 Asia/Dhaka hour). Exact per-organisation custom minutes require either installing Vercel Schedules (@vercel/schedules + @vercel/queue with 15-minute Hobby jitter) or Vercel Pro / an external cron trigger.",
      vercelSchedules
    };
  }

  async upsertSchedule(
    settings: PersistentDailySettings,
    storageStatus: StorageCapabilityStatus
  ): Promise<DynamicScheduleSyncResult> {
    const key = buildOrganizationScheduleKey(settings.organizationId, settings.frequency);
    const cron = buildTimezoneCronExpression(settings.frequency, settings.scheduledTime);
    const activeEngine: ScheduleProviderEngine = storageStatus.schedulerProductionReady
      ? "vercel_hobby_daily_cron"
      : "local_unconfigured";

    return {
      action: "fallback_persisted",
      providerEngine: activeEngine,
      externalScheduleId: key.externalId,
      namespace: key.namespace,
      cronExpression: cron,
      timezone: settings.timezone,
      appliedExactTiming: false,
      notice: storageStatus.schedulerProductionReady
        ? `Saved ${settings.frequency} preference (${settings.scheduledTime} ${settings.timezone}) in durable storage. Execution is triggered by the protected daily Vercel Hobby Cron (15 18 * * * UTC, hourly precision window).`
        : `Saved ${settings.frequency} preference (${settings.scheduledTime} ${settings.timezone}) in local storage. Automatic background execution is inactive until production storage and scheduler secrets are configured.`
    };
  }

  async disableSchedule(
    organizationId: string,
    frequency: ReportFrequency,
    timezone: string
  ): Promise<DynamicScheduleSyncResult> {
    const key = buildOrganizationScheduleKey(organizationId, frequency);
    return {
      action: "disabled",
      providerEngine: this.engine,
      externalScheduleId: key.externalId,
      namespace: key.namespace,
      cronExpression: FALLBACK_VERCEL_HOBBY_CRON,
      timezone,
      appliedExactTiming: false,
      notice: `Automatic ${frequency} scheduling is paused for this organisation. The scheduler will skip future runs until re-enabled.`
    };
  }
}

/**
 * Tenant-isolated in-memory dynamic schedule registry mirroring the exact lifecycle of
 * `@vercel/schedules` (`Schedules.create`, `Schedules.update`, `Schedules.delete`) so
 * idempotent create/update/disable and duplicate-prevention behaviour can be verified in tests
 * and swapped directly to `@vercel/schedules` once the package is approved and installed.
 */
export class InMemoryDynamicScheduleProvider implements DynamicScheduleProvider {
  readonly engine: ScheduleProviderEngine = "vercel_schedules";
  private readonly schedules = new Map<string, {
    id: string;
    namespace: string;
    name: string;
    organizationId: string;
    frequency: ReportFrequency;
    cronExpression: string;
    timezone: string;
    enabled: boolean;
    updatedAt: string;
  }>();

  listForOrganization(organizationId: string) {
    return Array.from(this.schedules.values()).filter(item => item.organizationId === organizationId);
  }

  getProviderStatus(_storageStatus: StorageCapabilityStatus): ScheduleProviderStatus {
    return {
      engine: "vercel_schedules",
      supportsExactMinutePrecision: false, // Hobby jitter is 15 min
      supportsUserSelectedTime: true,
      fallbackCronExpression: FALLBACK_VERCEL_HOBBY_CRON,
      precisionNotice:
        "Dynamic per-organisation recurring schedules active (Hobby tier enforces a 15-minute jitter window and 15-minute minimum cadence).",
      vercelSchedules: {
        ...getVercelSchedulesReadiness(),
        sdkInstalled: true,
        queueConfigured: true,
        blocker: null
      }
    };
  }

  async upsertSchedule(
    settings: PersistentDailySettings,
    _storageStatus: StorageCapabilityStatus
  ): Promise<DynamicScheduleSyncResult> {
    const key = buildOrganizationScheduleKey(settings.organizationId, settings.frequency);
    const cron = buildTimezoneCronExpression(settings.frequency, settings.scheduledTime);

    // Disable any stale frequency schedules for the same org so switching Daily -> Weekly never leaves duplicates
    for (const freq of ["daily", "weekly", "monthly"] as const) {
      if (freq !== settings.frequency) {
        const otherKey = buildOrganizationScheduleKey(settings.organizationId, freq);
        this.schedules.delete(otherKey.externalId);
      }
    }

    this.schedules.set(key.externalId, {
      id: key.externalId,
      namespace: key.namespace,
      name: key.name,
      organizationId: settings.organizationId,
      frequency: settings.frequency,
      cronExpression: cron,
      timezone: settings.timezone,
      enabled: settings.autoReportEnabled,
      updatedAt: new Date().toISOString()
    });

    return {
      action: "upserted",
      providerEngine: "vercel_schedules",
      externalScheduleId: key.externalId,
      namespace: key.namespace,
      cronExpression: cron,
      timezone: settings.timezone,
      appliedExactTiming: true,
      notice: `Dynamic ${settings.frequency} schedule registered (${cron} ${settings.timezone}) under tenant namespace ${key.namespace}.`
    };
  }

  async disableSchedule(
    organizationId: string,
    frequency: ReportFrequency,
    timezone: string
  ): Promise<DynamicScheduleSyncResult> {
    const key = buildOrganizationScheduleKey(organizationId, frequency);
    for (const freq of ["daily", "weekly", "monthly"] as const) {
      this.schedules.delete(buildOrganizationScheduleKey(organizationId, freq).externalId);
    }
    return {
      action: "disabled",
      providerEngine: "vercel_schedules",
      externalScheduleId: key.externalId,
      namespace: key.namespace,
      cronExpression: FALLBACK_VERCEL_HOBBY_CRON,
      timezone,
      appliedExactTiming: true,
      notice: `Cancelled dynamic schedules for organisation namespace ${key.namespace}.`
    };
  }
}

export function getDefaultDynamicScheduleProvider(): DynamicScheduleProvider {
  return new VercelHobbyCronFallbackProvider();
}
