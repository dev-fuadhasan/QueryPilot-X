import { NextRequest, NextResponse } from "next/server";
import { deriveUserIdFromSession } from "@/lib/storage/session-auth";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import {
  computeNextScheduledExecution,
  getDefaultDailySettings,
  getDefaultDynamicScheduleProvider,
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  validateAndMergeSettings,
  type DynamicScheduleSyncResult,
  type PersistentDailySettings,
  type PersistentReportSummary,
  type ScheduleRuntimeSummary
} from "@/../daily_data_analysis_and_notification/storage";
import {
  listDailyPdfsFromSharedStorage,
  loadSharedSettingsEnvelope,
  saveSharedSettingsEnvelope
} from "@/../daily_data_analysis_and_notification/storage/shared-cloud-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function buildScheduleSummary(input: {
  organizationId: string;
  storageUserId: string;
  settings: PersistentDailySettings;
  persisted: boolean;
  storageStatus: ReturnType<typeof getStorageCapabilityStatus>;
  lastSync: DynamicScheduleSyncResult | null;
  sharedCursor?: string | null;
}): Promise<ScheduleRuntimeSummary> {
  const provider = getDefaultDynamicScheduleProvider();
  const providerStatus = provider.getProviderStatus(input.storageStatus);
  let lastCompletedPeriodEnd: string | null = input.sharedCursor ?? null;
  let latestAutomaticReport: PersistentReportSummary | null = null;

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
    lastCompletedPeriodEnd = cursor || lastCompletedPeriodEnd;
    latestAutomaticReport = autoList.items[0] || null;
  } catch {
    // Fallback to shared Supabase Storage report list (works without Postgres/SQLite)
    try {
      const cloudReports = await listDailyPdfsFromSharedStorage(input.storageUserId, input.organizationId);
      latestAutomaticReport = cloudReports.find(r => r.generationType === "automatic") || cloudReports[0] || null;
    } catch {
      latestAutomaticReport = null;
    }
  }

  return {
    active: Boolean(input.settings.autoReportEnabled),
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
  const storageUserId = deriveUserIdFromSession(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);

  try {
    const repository = getPersistentReportRepository();
    const saved = await repository.getSettings(organizationId);
    const settings = saved || getDefaultDailySettings(organizationId);
    const scheduleSummary = await buildScheduleSummary({
      organizationId,
      storageUserId,
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
  } catch {
    // Fallback cleanly to shared Supabase Storage settings (no Postgres/SQLite required)
    const envelope = await loadSharedSettingsEnvelope(storageUserId).catch(() => null);
    const settings = envelope?.settings || getDefaultDailySettings(organizationId);
    const sharedCursor = envelope?.cursors?.[settings.frequency] ?? null;
    const scheduleSummary = await buildScheduleSummary({
      organizationId,
      storageUserId,
      settings,
      persisted: Boolean(envelope),
      storageStatus,
      lastSync: null,
      sharedCursor
    });

    return access.applyCookie(NextResponse.json(
      {
        settings,
        persisted: Boolean(envelope),
        storageStatus,
        schedulerActive: scheduleSummary.active,
        scheduleSummary
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
  const storageUserId = deriveUserIdFromSession(access.session);
  const storageStatus = getStorageCapabilityStatus(organizationId);

  try {
    let saved: PersistentDailySettings;
    let sharedCursor: string | null = null;

    try {
      const repository = getPersistentReportRepository();
      const existing = (await repository.getSettings(organizationId)) || getDefaultDailySettings(organizationId);
      const validated = validateAndMergeSettings(organizationId, body, existing);
      saved = await repository.saveSettings(validated);
      // Mirror settings into shared cloud storage as well for cross-device resilience
      await saveSharedSettingsEnvelope(storageUserId, saved).catch(() => undefined);
    } catch {
      const envelope = await loadSharedSettingsEnvelope(storageUserId).catch(() => null);
      const existing = envelope?.settings || getDefaultDailySettings(organizationId);
      const validated = validateAndMergeSettings(organizationId, body, existing);
      const storedEnvelope = await saveSharedSettingsEnvelope(storageUserId, validated);
      saved = storedEnvelope.settings;
      sharedCursor = storedEnvelope.cursors?.[saved.frequency] ?? null;
    }

    const provider = getDefaultDynamicScheduleProvider();
    const syncOutcome = saved.autoReportEnabled
      ? await provider.upsertSchedule(saved, storageStatus)
      : await provider.disableSchedule(organizationId, saved.frequency, saved.timezone);

    const scheduleSummary = await buildScheduleSummary({
      organizationId,
      storageUserId,
      settings: saved,
      persisted: true,
      storageStatus,
      lastSync: syncOutcome,
      sharedCursor
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
    const message = error instanceof Error ? error.message : "Could not save settings.";
    const status = /must be|Invalid|required|24-hour/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
