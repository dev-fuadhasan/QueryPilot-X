import { NextRequest, NextResponse } from "next/server";
import { deriveOrganizationId, readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import {
  getDefaultDailySettings,
  getPersistentReportRepository,
  getStorageCapabilityStatus,
  validateAndMergeSettings
} from "@/../daily_data_analysis_and_notification/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const organizationId = deriveOrganizationId(access.session);
  const storageStatus = getStorageCapabilityStatus();

  try {
    const repository = getPersistentReportRepository();
    const saved = await repository.getSettings(organizationId);
    const settings = saved || getDefaultDailySettings(organizationId);
    return access.applyCookie(NextResponse.json(
      {
        settings,
        persisted: Boolean(saved),
        storageStatus,
        schedulerActive: Boolean(settings.autoReportEnabled && storageStatus.schedulerProductionReady)
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const defaults = getDefaultDailySettings(organizationId);
    return access.applyCookie(NextResponse.json(
      {
        settings: defaults,
        persisted: false,
        storageStatus,
        schedulerActive: false,
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
  const storageStatus = getStorageCapabilityStatus();

  try {
    const repository = getPersistentReportRepository();
    const existing = (await repository.getSettings(organizationId)) || getDefaultDailySettings(organizationId);
    const validated = validateAndMergeSettings(organizationId, body, existing);
    const saved = await repository.saveSettings(validated);
    return access.applyCookie(NextResponse.json(
      {
        settings: saved,
        storageStatus,
        schedulerActive: Boolean(saved.autoReportEnabled && storageStatus.schedulerProductionReady)
      },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save Daily Analysis settings.";
    const status = /development mode|not configured/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message, storageStatus }, { status });
  }
}
