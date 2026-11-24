import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import {
  computeNextScheduledExecution,
  getDefaultDailySettings,
  getDefaultDynamicScheduleProvider,
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  validateAndMergeSettings,
  type DynamicScheduleSyncResult,
  type ScheduleRuntimeSummary
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function buildScheduleSummary(input: {
  organizationId: string;
  settings: ReturnType<typeof getDefaultDailySettings>;
  persisted: boolean;
  storageStatus: ReturnType<typeof getStorageCapabilityStatus>;
  lastSync: DynamicScheduleSyncResult | null;
}): Promise<ScheduleRuntimeSummary> {
  const provider = getDefaultDynamicScheduleProvider();
  const providerStatus = provider.getProviderStatus(input.storageStatus);
  let lastCompletedPeriodEnd: string | null = null;
  let latestAutomaticReport = null;

  try {
    const repository = getPersistentReportRepository();
    const [cursor, autoList] = await Promise.all([
      repository.getScheduleCursor(input.organizationId, input.settings.frequency),
      repository.listReports({
        organizationId: input.organizationId,
        generationType: "automatic",
        defaultDays: 0,
        page: 1,
        pageSize: 1
      })
    ]);
    lastCompletedPeriodEnd = cursor;
    latestAutomaticReport = autoList.items[0] || null;
  } catch {
    // Repository unavailable — surface cleanly in storageStatus
  }

  return {
    active: Boolean(input.settings.autoReportEnabled && input.storageStatus.schedulerProductionReady),
    persisted: input.persisted,
    providerStatus,
    nextExecution: computeNextScheduledExecution(input.settings, lastCompletedPeriodEnd),
    latestAutomaticReport,
    lastSync: input.lastSync
  };
}

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const organizationId = deriveOrganizationId(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);

  try {
    const repository = getPersistentReportRepository();
    const saved = await repository.getSettings(organizationId);
    const settings = saved || getDefaultDailySettings(organizationId);
    const scheduleSummary = await buildScheduleSummary({
      organizationId,
      settings,
      persisted: Boolean(saved),
      storageStatus,
      lastSync: null
    });
    return access.applyCookie(NextResponse.json(
      {
        settings,
        persisted: Boolean(saved),
        storageStatus,
        schedulerActive: scheduleSummary.active,
        scheduleSummary
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const defaults = getDefaultDailySettings(organizationId);
    const provider = getDefaultDynamicScheduleProvider();
    return access.applyCookie(NextResponse.json(
      {
        settings: defaults,
        persisted: false,
        storageStatus,
        schedulerActive: false,
        scheduleSummary: {
          active: false,
          persisted: false,
          providerStatus: provider.getProviderStatus(storageStatus),
          nextExecution: null,
          latestAutomaticReport: null,
          lastSync: null
        } satisfies ScheduleRuntimeSummary,
        warning: error instanceof Error ? error.message : "Persistent settings storage is not configured in this environment."
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  }
}

export async function PUT(request: NextRequest) {
  const access = await readDailyAnalysisSession(request, true);
  if ("response" in access) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A valid JSON payload is required." }, { status: 400 });
  }

  const organizationId = deriveOrganizationId(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);

  try {
    const repository = getPersistentReportRepository();
    const existing = (await repository.getSettings(organizationId)) || getDefaultDailySettings(organizationId);
    const validated = validateAndMergeSettings(organizationId, body, existing);
    const saved = await repository.saveSettings(validated);

    const provider = getDefaultDynamicScheduleProvider();
    const syncOutcome = saved.autoReportEnabled
      ? await provider.upsertSchedule(saved, storageStatus)
      : await provider.disableSchedule(organizationId, saved.frequency, saved.timezone);

    const scheduleSummary = await buildScheduleSummary({
      organizationId,
      settings: saved,
      persisted: true,
      storageStatus,
      lastSync: syncOutcome
    });

    return access.applyCookie(NextResponse.json(
      {
        settings: saved,
        storageStatus,
        schedulerActive: scheduleSummary.active,
        scheduleSummary
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save Daily Analysis settings.";
    const status = /development mode|not configured/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message, storageStatus }, { status });
  }
}
