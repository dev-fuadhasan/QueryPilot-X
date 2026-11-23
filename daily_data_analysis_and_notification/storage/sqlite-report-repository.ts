import type Database from "better-sqlite3";
import { addDaysToDate } from "../metrics/math-and-periods";
import type { BusinessDomainId } from "../profiler/types";
import type { ComparisonPreset } from "../metrics/types";
import type { ExpectedReportingCadence } from "../intelligence/types";
import type {
  ClaimExecutionResult,
  PaginatedReportList,
  PdfMetadataUpdate,
  PersistentDailySettings,
  PersistentReportListQuery,
  PersistentReportRecord,
  PersistentReportRepository,
  PersistentReportSummary,
  ReportFrequency,
  ScheduleExecutionRecord
} from "./types";

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapSettingsRow(row: Record<string, unknown>): PersistentDailySettings {
  return {
    organizationId: String(row.organization_id),
    selectedDomain: String(row.selected_domain || "sales_ecommerce") as BusinessDomainId,
    selectedDataset: row.selected_dataset ? String(row.selected_dataset) : null,
    autoReportEnabled: Number(row.auto_report_enabled) === 1,
    frequency: String(row.frequency || "daily") as ReportFrequency,
    scheduledTime: String(row.scheduled_time || "00:15"),
    timezone: String(row.timezone || "Asia/Dhaka"),
    comparisonPreset: String(row.comparison_preset || "previous_30_days") as ComparisonPreset,
    comparisonDays: Number(row.comparison_days || 30),
    expectedCadence: String(row.expected_cadence || "irregular") as ExpectedReportingCadence,
    alertRules: safeJsonParse<Record<string, unknown>>(row.alert_rules_json, {}),
    columnOverrides: safeJsonParse<Record<string, string>>(row.column_overrides_json, {}),
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined
  };
}

function mapReportSummary(row: Record<string, unknown>): PersistentReportSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    ownerRef: row.owner_ref ? String(row.owner_ref) : null,
    domainId: String(row.domain_id) as BusinessDomainId,
    domainName: String(row.domain_name),
    datasetTable: String(row.dataset_table),
    reportingDate: String(row.reporting_date),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    comparisonStart: row.comparison_start ? String(row.comparison_start) : null,
    comparisonEnd: row.comparison_end ? String(row.comparison_end) : null,
    comparisonPreset: row.comparison_preset ? String(row.comparison_preset) : null,
    frequency: String(row.frequency) as PersistentReportRecord["frequency"],
    generationType: String(row.generation_type) as PersistentReportRecord["generationType"],
    executionKey: row.execution_key ? String(row.execution_key) : null,
    status: String(row.status) as PersistentReportRecord["status"],
    summaryText: String(row.summary_text || ""),
    pdfStatus: String(row.pdf_status || "not_generated") as PersistentReportRecord["pdfStatus"],
    pdfStorageKey: row.pdf_storage_key ? String(row.pdf_storage_key) : null,
    pdfFilename: row.pdf_filename ? String(row.pdf_filename) : null,
    pdfGeneratedAt: row.pdf_generated_at ? String(row.pdf_generated_at) : null,
    pdfSizeBytes: row.pdf_size_bytes === null || row.pdf_size_bytes === undefined ? null : Number(row.pdf_size_bytes),
    pdfError: row.pdf_error ? String(row.pdf_error) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    generatedAt: String(row.generated_at),
    createdAt: String(row.created_at)
  };
}

function mapReportRecord(row: Record<string, unknown>): PersistentReportRecord {
  return {
    ...mapReportSummary(row),
    reportPayload: safeJsonParse<Record<string, unknown>>(row.report_payload_json, {})
  };
}

function mapExecutionRow(row: Record<string, unknown>): ScheduleExecutionRecord {
  return {
    executionKey: String(row.execution_key),
    organizationId: String(row.organization_id),
    scheduleId: String(row.schedule_id),
    frequency: String(row.frequency) as ReportFrequency,
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    reportId: row.report_id ? String(row.report_id) : null,
    attemptCount: Number(row.attempt_count || 0),
    status: String(row.status) as ScheduleExecutionRecord["status"],
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
    errorMessage: row.error_message ? String(row.error_message) : null
  };
}

/**
 * Application-owned SQLite repository adapter (local development & test durable storage).
 * Strictly enforces tenant isolation (`organization_id`) on every read/write query.
 */
export class SqliteReportRepository implements PersistentReportRepository {
  readonly backendName = "sqlite" as const;
  readonly isProductionPersistent = false;

  constructor(private readonly db: Database.Database) {}

  async getSettings(organizationId: string): Promise<PersistentDailySettings | null> {
    const row = this.db.prepare(
      "SELECT * FROM app_daily_analysis_settings WHERE organization_id = ?"
    ).get(organizationId) as Record<string, unknown> | undefined;
    return row ? mapSettingsRow(row) : null;
  }

  async saveSettings(settings: PersistentDailySettings): Promise<PersistentDailySettings> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_daily_analysis_settings (
        organization_id, selected_domain, selected_dataset, auto_report_enabled,
        frequency, scheduled_time, timezone, comparison_preset, comparison_days,
        expected_cadence, alert_rules_json, column_overrides_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id) DO UPDATE SET
        selected_domain = excluded.selected_domain,
        selected_dataset = excluded.selected_dataset,
        auto_report_enabled = excluded.auto_report_enabled,
        frequency = excluded.frequency,
        scheduled_time = excluded.scheduled_time,
        timezone = excluded.timezone,
        comparison_preset = excluded.comparison_preset,
        comparison_days = excluded.comparison_days,
        expected_cadence = excluded.expected_cadence,
        alert_rules_json = excluded.alert_rules_json,
        column_overrides_json = excluded.column_overrides_json,
        updated_at = excluded.updated_at
    `).run(
      settings.organizationId,
      settings.selectedDomain,
      settings.selectedDataset,
      settings.autoReportEnabled ? 1 : 0,
      settings.frequency,
      settings.scheduledTime,
      settings.timezone,
      settings.comparisonPreset,
      settings.comparisonDays,
      settings.expectedCadence,
      JSON.stringify(settings.alertRules || {}),
      JSON.stringify(settings.columnOverrides || {}),
      now,
      now
    );
    return (await this.getSettings(settings.organizationId))!;
  }

  async listActiveScheduledSettings(): Promise<PersistentDailySettings[]> {
    const rows = this.db.prepare(
      "SELECT * FROM app_daily_analysis_settings WHERE auto_report_enabled = 1 AND selected_dataset IS NOT NULL AND TRIM(selected_dataset) != '' ORDER BY organization_id ASC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map(mapSettingsRow);
  }

  async saveReport(record: Omit<PersistentReportRecord, "createdAt">): Promise<PersistentReportRecord> {
    if (record.executionKey) {
      const existing = await this.getReportByExecutionKey(record.organizationId, record.executionKey);
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_persistent_reports (
        id, organization_id, owner_ref, domain_id, domain_name, dataset_table,
        reporting_date, period_start, period_end, comparison_start, comparison_end,
        comparison_preset, frequency, generation_type, execution_key, status,
        summary_text, report_payload_json, pdf_status, pdf_storage_key,
        pdf_filename, pdf_generated_at, pdf_size_bytes, pdf_error, error_message,
        generated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.organizationId,
      record.ownerRef,
      record.domainId,
      record.domainName,
      record.datasetTable,
      record.reportingDate,
      record.periodStart,
      record.periodEnd,
      record.comparisonStart,
      record.comparisonEnd,
      record.comparisonPreset,
      record.frequency,
      record.generationType,
      record.executionKey,
      record.status,
      record.summaryText,
      JSON.stringify(record.reportPayload),
      record.pdfStatus,
      record.pdfStorageKey,
      record.pdfFilename,
      record.pdfGeneratedAt,
      record.pdfSizeBytes,
      record.pdfError,
      record.errorMessage,
      record.generatedAt,
      now
    );

    return (await this.getReportById(record.organizationId, record.id))!;
  }

  async getReportById(organizationId: string, reportId: string): Promise<PersistentReportRecord | null> {
    const row = this.db.prepare(
      "SELECT * FROM app_persistent_reports WHERE organization_id = ? AND id = ?"
    ).get(organizationId, reportId) as Record<string, unknown> | undefined;
    return row ? mapReportRecord(row) : null;
  }

  async getReportByExecutionKey(organizationId: string, executionKey: string): Promise<PersistentReportRecord | null> {
    const row = this.db.prepare(
      "SELECT * FROM app_persistent_reports WHERE organization_id = ? AND execution_key = ?"
    ).get(organizationId, executionKey) as Record<string, unknown> | undefined;
    return row ? mapReportRecord(row) : null;
  }

  async listReports(query: PersistentReportListQuery): Promise<PaginatedReportList> {
    const page = Math.max(1, Math.trunc(query.page || 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize || 20), 100));
    const defaultDays = query.defaultDays === undefined ? 30 : query.defaultDays;
    const refDate = query.referenceDate || new Date().toISOString().slice(0, 10);

    const appliedStartDate = query.startDate
      || (!query.endDate && defaultDays > 0 ? addDaysToDate(refDate, -(defaultDays - 1)) : null);
    const appliedEndDate = query.endDate || null;

    const where: string[] = ["organization_id = ?"];
    const params: unknown[] = [query.organizationId];

    if (appliedStartDate) {
      where.push("reporting_date >= ?");
      params.push(appliedStartDate);
    }
    if (appliedEndDate) {
      where.push("reporting_date <= ?");
      params.push(appliedEndDate);
    }
    if (query.domainId) {
      where.push("domain_id = ?");
      params.push(query.domainId);
    }
    if (query.datasetTable) {
      where.push("dataset_table = ?");
      params.push(query.datasetTable);
    }
    if (query.generationType) {
      where.push("generation_type = ?");
      params.push(query.generationType);
    }
    if (query.frequency) {
      where.push("frequency = ?");
      params.push(query.frequency);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM app_persistent_reports WHERE ${whereSql}`
    ).get(...params) as { count: number };
    const total = Number(totalRow?.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const rows = this.db.prepare(`
      SELECT
        id, organization_id, owner_ref, domain_id, domain_name, dataset_table,
        reporting_date, period_start, period_end, comparison_start, comparison_end,
        comparison_preset, frequency, generation_type, execution_key, status,
        summary_text, pdf_status, pdf_storage_key, pdf_filename, pdf_generated_at,
        pdf_size_bytes, pdf_error, error_message, generated_at, created_at
      FROM app_persistent_reports
      WHERE ${whereSql}
      ORDER BY reporting_date DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map(mapReportSummary),
      total,
      page,
      pageSize,
      totalPages,
      appliedStartDate,
      appliedEndDate
    };
  }

  async updateReportPdfMetadata(organizationId: string, reportId: string, update: PdfMetadataUpdate): Promise<void> {
    this.db.prepare(`
      UPDATE app_persistent_reports
      SET pdf_status = ?,
          pdf_storage_key = COALESCE(?, pdf_storage_key),
          pdf_filename = COALESCE(?, pdf_filename),
          pdf_generated_at = COALESCE(?, pdf_generated_at),
          pdf_size_bytes = COALESCE(?, pdf_size_bytes),
          pdf_error = ?
      WHERE organization_id = ? AND id = ?
    `).run(
      update.pdfStatus,
      update.pdfStorageKey ?? null,
      update.pdfFilename ?? null,
      update.pdfGeneratedAt ?? null,
      update.pdfSizeBytes ?? null,
      update.pdfError ?? null,
      organizationId,
      reportId
    );
  }

  async claimExecution(input: {
    executionKey: string;
    organizationId: string;
    scheduleId: string;
    frequency: ReportFrequency;
    periodStart: string;
    periodEnd: string;
    leaseMinutes?: number;
    now?: Date;
  }): Promise<ClaimExecutionResult> {
    const now = input.now || new Date();
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + (input.leaseMinutes || 15) * 60_000).toISOString();

    const tx = this.db.transaction((): ClaimExecutionResult => {
      const existing = this.db.prepare(
        "SELECT * FROM app_schedule_executions WHERE execution_key = ?"
      ).get(input.executionKey) as Record<string, unknown> | undefined;

      if (existing) {
        const mapped = mapExecutionRow(existing);
        if (mapped.status === "succeeded") {
          return { outcome: "already_succeeded", record: mapped };
        }
        if (mapped.status === "running" && mapped.leaseExpiresAt && mapped.leaseExpiresAt > nowIso) {
          return { outcome: "in_progress", record: mapped };
        }
      }

      this.db.prepare(`
        INSERT INTO app_schedule_executions (
          execution_key, organization_id, schedule_id, frequency, period_start, period_end,
          attempt_count, status, started_at, lease_expires_at, next_retry_at, error_message, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'running', ?, ?, NULL, NULL, ?)
        ON CONFLICT (execution_key) DO UPDATE SET
          status = 'running',
          attempt_count = app_schedule_executions.attempt_count + 1,
          started_at = excluded.started_at,
          lease_expires_at = excluded.lease_expires_at,
          next_retry_at = NULL,
          error_message = NULL,
          updated_at = excluded.updated_at
      `).run(
        input.executionKey,
        input.organizationId,
        input.scheduleId,
        input.frequency,
        input.periodStart,
        input.periodEnd,
        nowIso,
        leaseIso,
        nowIso
      );

      const updated = this.db.prepare(
        "SELECT * FROM app_schedule_executions WHERE execution_key = ?"
      ).get(input.executionKey) as Record<string, unknown>;
      return { outcome: "claimed", record: mapExecutionRow(updated) };
    }).immediate;

    return tx();
  }

  async completeExecution(input: {
    executionKey: string;
    status: "succeeded" | "failed";
    reportId?: string | null;
    errorMessage?: string | null;
    nextRetryAt?: string | null;
    now?: Date;
  }): Promise<void> {
    const nowIso = (input.now || new Date()).toISOString();
    this.db.prepare(`
      UPDATE app_schedule_executions
      SET status = ?,
          report_id = COALESCE(?, report_id),
          completed_at = ?,
          lease_expires_at = NULL,
          next_retry_at = ?,
          error_message = ?,
          updated_at = ?
      WHERE execution_key = ?
    `).run(
      input.status,
      input.reportId ?? null,
      nowIso,
      input.nextRetryAt ?? null,
      input.errorMessage ?? null,
      nowIso,
      input.executionKey
    );
  }

  async getExecution(executionKey: string): Promise<ScheduleExecutionRecord | null> {
    const row = this.db.prepare(
      "SELECT * FROM app_schedule_executions WHERE execution_key = ?"
    ).get(executionKey) as Record<string, unknown> | undefined;
    return row ? mapExecutionRow(row) : null;
  }

  async getScheduleCursor(organizationId: string, frequency: ReportFrequency): Promise<string | null> {
    const row = this.db.prepare(
      "SELECT last_completed_period_end FROM app_schedule_cursors WHERE organization_id = ? AND frequency = ?"
    ).get(organizationId, frequency) as { last_completed_period_end: string } | undefined;
    return row?.last_completed_period_end || null;
  }

  async setScheduleCursor(organizationId: string, frequency: ReportFrequency, lastCompletedPeriodEnd: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_schedule_cursors (organization_id, frequency, last_completed_period_end, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, frequency) DO UPDATE SET
        last_completed_period_end = excluded.last_completed_period_end,
        updated_at = excluded.updated_at
    `).run(organizationId, frequency, lastCompletedPeriodEnd, nowIso);
  }
}
