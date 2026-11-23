import { Pool } from "pg";
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

export const POSTGRES_PERSISTENT_STORAGE_DDL = `
CREATE TABLE IF NOT EXISTS app_daily_analysis_settings (
  organization_id TEXT PRIMARY KEY NOT NULL,
  selected_domain TEXT NOT NULL DEFAULT 'sales_ecommerce',
  selected_dataset TEXT,
  auto_report_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  scheduled_time TEXT NOT NULL DEFAULT '00:15',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  comparison_preset TEXT NOT NULL DEFAULT 'previous_30_days',
  comparison_days INTEGER NOT NULL DEFAULT 30 CHECK (comparison_days >= 1 AND comparison_days <= 3650),
  expected_cadence TEXT NOT NULL DEFAULT 'irregular' CHECK (expected_cadence IN ('daily', 'weekdays', 'weekly', 'irregular')),
  alert_rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  column_overrides_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_persistent_reports (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  owner_ref TEXT,
  domain_id TEXT NOT NULL,
  domain_name TEXT NOT NULL,
  dataset_table TEXT NOT NULL,
  reporting_date TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  comparison_start TEXT,
  comparison_end TEXT,
  comparison_preset TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'manual')),
  generation_type TEXT NOT NULL CHECK (generation_type IN ('automatic', 'manual')),
  execution_key TEXT,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'failed')),
  summary_text TEXT NOT NULL DEFAULT '',
  report_payload_json JSONB NOT NULL,
  pdf_status TEXT NOT NULL DEFAULT 'not_generated' CHECK (pdf_status IN ('not_generated', 'generated', 'failed')),
  pdf_storage_key TEXT,
  pdf_filename TEXT,
  pdf_generated_at TIMESTAMPTZ,
  pdf_size_bytes INTEGER CHECK (pdf_size_bytes IS NULL OR pdf_size_bytes >= 0),
  pdf_error TEXT,
  error_message TEXT,
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_persistent_reports_exec_key
  ON app_persistent_reports(organization_id, execution_key)
  WHERE execution_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_persistent_reports_org_date
  ON app_persistent_reports(organization_id, reporting_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_persistent_reports_org_domain_table
  ON app_persistent_reports(organization_id, domain_id, dataset_table, reporting_date DESC);

CREATE TABLE IF NOT EXISTS app_schedule_executions (
  execution_key TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  report_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_schedule_cursors (
  organization_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  last_completed_period_end TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, frequency)
);
`.trim();

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapSettingsRow(row: Record<string, unknown>): PersistentDailySettings {
  return {
    organizationId: String(row.organization_id),
    selectedDomain: String(row.selected_domain || "sales_ecommerce") as BusinessDomainId,
    selectedDataset: row.selected_dataset ? String(row.selected_dataset) : null,
    autoReportEnabled: Boolean(row.auto_report_enabled),
    frequency: String(row.frequency || "daily") as ReportFrequency,
    scheduledTime: String(row.scheduled_time || "00:15"),
    timezone: String(row.timezone || "Asia/Dhaka"),
    comparisonPreset: String(row.comparison_preset || "previous_30_days") as ComparisonPreset,
    comparisonDays: Number(row.comparison_days || 30),
    expectedCadence: String(row.expected_cadence || "irregular") as ExpectedReportingCadence,
    alertRules: (row.alert_rules_json && typeof row.alert_rules_json === "object" ? row.alert_rules_json : {}) as Record<string, unknown>,
    columnOverrides: (row.column_overrides_json && typeof row.column_overrides_json === "object" ? row.column_overrides_json : {}) as Record<string, string>,
    createdAt: toIso(row.created_at) || undefined,
    updatedAt: toIso(row.updated_at) || undefined
  };
}

function mapSummaryRow(row: Record<string, unknown>): PersistentReportSummary {
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
    pdfGeneratedAt: toIso(row.pdf_generated_at),
    pdfSizeBytes: row.pdf_size_bytes === null || row.pdf_size_bytes === undefined ? null : Number(row.pdf_size_bytes),
    pdfError: row.pdf_error ? String(row.pdf_error) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    generatedAt: toIso(row.generated_at) || new Date().toISOString(),
    createdAt: toIso(row.created_at) || new Date().toISOString()
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
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    leaseExpiresAt: toIso(row.lease_expires_at),
    nextRetryAt: toIso(row.next_retry_at),
    errorMessage: row.error_message ? String(row.error_message) : null
  };
}

/**
 * Production application-owned PostgreSQL repository adapter.
 * Connects strictly to QueryPilot-X's own application database (`QUERYPILOT_APP_DATABASE_URL`),
 * NEVER to the organisation's connected read-only source database.
 */
export class PostgresReportRepository implements PersistentReportRepository {
  readonly backendName = "postgres" as const;
  readonly isProductionPersistent = true;
  private readonly pool: Pool;
  private schemaReadyPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new Error("QUERYPILOT_APP_DATABASE_URL must be a valid PostgreSQL connection string.");
    }
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 8_000,
      ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: false }
    });
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = this.pool.query(POSTGRES_PERSISTENT_STORAGE_DDL).then(() => undefined);
    }
    await this.schemaReadyPromise;
  }

  async getSettings(organizationId: string): Promise<PersistentDailySettings | null> {
    await this.ensureSchema();
    const res = await this.pool.query("SELECT * FROM app_daily_analysis_settings WHERE organization_id = $1", [organizationId]);
    return res.rows[0] ? mapSettingsRow(res.rows[0]) : null;
  }

  async saveSettings(settings: PersistentDailySettings): Promise<PersistentDailySettings> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `INSERT INTO app_daily_analysis_settings (
        organization_id, selected_domain, selected_dataset, auto_report_enabled,
        frequency, scheduled_time, timezone, comparison_preset, comparison_days,
        expected_cadence, alert_rules_json, column_overrides_json, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,NOW())
      ON CONFLICT (organization_id) DO UPDATE SET
        selected_domain = EXCLUDED.selected_domain,
        selected_dataset = EXCLUDED.selected_dataset,
        auto_report_enabled = EXCLUDED.auto_report_enabled,
        frequency = EXCLUDED.frequency,
        scheduled_time = EXCLUDED.scheduled_time,
        timezone = EXCLUDED.timezone,
        comparison_preset = EXCLUDED.comparison_preset,
        comparison_days = EXCLUDED.comparison_days,
        expected_cadence = EXCLUDED.expected_cadence,
        alert_rules_json = EXCLUDED.alert_rules_json,
        column_overrides_json = EXCLUDED.column_overrides_json,
        updated_at = NOW()
      RETURNING *`,
      [
        settings.organizationId,
        settings.selectedDomain,
        settings.selectedDataset,
        settings.autoReportEnabled,
        settings.frequency,
        settings.scheduledTime,
        settings.timezone,
        settings.comparisonPreset,
        settings.comparisonDays,
        settings.expectedCadence,
        JSON.stringify(settings.alertRules || {}),
        JSON.stringify(settings.columnOverrides || {})
      ]
    );
    return mapSettingsRow(res.rows[0]);
  }

  async listActiveScheduledSettings(): Promise<PersistentDailySettings[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      "SELECT * FROM app_daily_analysis_settings WHERE auto_report_enabled = TRUE AND selected_dataset IS NOT NULL AND TRIM(selected_dataset) != '' ORDER BY organization_id ASC"
    );
    return res.rows.map(mapSettingsRow);
  }

  async saveReport(record: Omit<PersistentReportRecord, "createdAt">): Promise<PersistentReportRecord> {
    await this.ensureSchema();
    if (record.executionKey) {
      const existing = await this.getReportByExecutionKey(record.organizationId, record.executionKey);
      if (existing) return existing;
    }

    const res = await this.pool.query(
      `INSERT INTO app_persistent_reports (
        id, organization_id, owner_ref, domain_id, domain_name, dataset_table,
        reporting_date, period_start, period_end, comparison_start, comparison_end,
        comparison_preset, frequency, generation_type, execution_key, status,
        summary_text, report_payload_json, pdf_status, pdf_storage_key,
        pdf_filename, pdf_generated_at, pdf_size_bytes, pdf_error, error_message,
        generated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26
      ) RETURNING *`,
      [
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
        record.generatedAt
      ]
    );
    const row = res.rows[0];
    return {
      ...mapSummaryRow(row),
      reportPayload: (row.report_payload_json || {}) as Record<string, unknown>
    };
  }

  async getReportById(organizationId: string, reportId: string): Promise<PersistentReportRecord | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      "SELECT * FROM app_persistent_reports WHERE organization_id = $1 AND id = $2",
      [organizationId, reportId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...mapSummaryRow(row), reportPayload: (row.report_payload_json || {}) as Record<string, unknown> };
  }

  async getReportByExecutionKey(organizationId: string, executionKey: string): Promise<PersistentReportRecord | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      "SELECT * FROM app_persistent_reports WHERE organization_id = $1 AND execution_key = $2",
      [organizationId, executionKey]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...mapSummaryRow(row), reportPayload: (row.report_payload_json || {}) as Record<string, unknown> };
  }

  async listReports(query: PersistentReportListQuery): Promise<PaginatedReportList> {
    await this.ensureSchema();
    const page = Math.max(1, Math.trunc(query.page || 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize || 20), 100));
    const defaultDays = query.defaultDays === undefined ? 30 : query.defaultDays;
    const refDate = query.referenceDate || new Date().toISOString().slice(0, 10);

    const appliedStartDate = query.startDate
      || (!query.endDate && defaultDays > 0 ? addDaysToDate(refDate, -(defaultDays - 1)) : null);
    const appliedEndDate = query.endDate || null;

    const where: string[] = ["organization_id = $1"];
    const params: unknown[] = [query.organizationId];
    const pushCond = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };

    if (appliedStartDate) pushCond("reporting_date >= ?", appliedStartDate);
    if (appliedEndDate) pushCond("reporting_date <= ?", appliedEndDate);
    if (query.domainId) pushCond("domain_id = ?", query.domainId);
    if (query.datasetTable) pushCond("dataset_table = ?", query.datasetTable);
    if (query.generationType) pushCond("generation_type = ?", query.generationType);
    if (query.frequency) pushCond("frequency = ?", query.frequency);

    const whereSql = where.join(" AND ");
    const countRes = await this.pool.query(`SELECT COUNT(*)::int AS count FROM app_persistent_reports WHERE ${whereSql}`, params);
    const total = Number(countRes.rows[0]?.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const listParams = [...params, pageSize, offset];
    const listRes = await this.pool.query(
      `SELECT
        id, organization_id, owner_ref, domain_id, domain_name, dataset_table,
        reporting_date, period_start, period_end, comparison_start, comparison_end,
        comparison_preset, frequency, generation_type, execution_key, status,
        summary_text, pdf_status, pdf_storage_key, pdf_filename, pdf_generated_at,
        pdf_size_bytes, pdf_error, error_message, generated_at, created_at
      FROM app_persistent_reports
      WHERE ${whereSql}
      ORDER BY reporting_date DESC, created_at DESC, id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    return {
      items: listRes.rows.map(mapSummaryRow),
      total,
      page,
      pageSize,
      totalPages,
      appliedStartDate,
      appliedEndDate
    };
  }

  async updateReportPdfMetadata(organizationId: string, reportId: string, update: PdfMetadataUpdate): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE app_persistent_reports
       SET pdf_status = $1,
           pdf_storage_key = COALESCE($2, pdf_storage_key),
           pdf_filename = COALESCE($3, pdf_filename),
           pdf_generated_at = COALESCE($4, pdf_generated_at),
           pdf_size_bytes = COALESCE($5, pdf_size_bytes),
           pdf_error = $6
       WHERE organization_id = $7 AND id = $8`,
      [
        update.pdfStatus,
        update.pdfStorageKey ?? null,
        update.pdfFilename ?? null,
        update.pdfGeneratedAt ?? null,
        update.pdfSizeBytes ?? null,
        update.pdfError ?? null,
        organizationId,
        reportId
      ]
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
    await this.ensureSchema();
    const now = input.now || new Date();
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + (input.leaseMinutes || 15) * 60_000).toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingRes = await client.query(
        "SELECT * FROM app_schedule_executions WHERE execution_key = $1 FOR UPDATE",
        [input.executionKey]
      );
      if (existingRes.rows[0]) {
        const mapped = mapExecutionRow(existingRes.rows[0]);
        if (mapped.status === "succeeded") {
          await client.query("COMMIT");
          return { outcome: "already_succeeded", record: mapped };
        }
        if (mapped.status === "running" && mapped.leaseExpiresAt && mapped.leaseExpiresAt > nowIso) {
          await client.query("COMMIT");
          return { outcome: "in_progress", record: mapped };
        }
      }

      const upsertRes = await client.query(
        `INSERT INTO app_schedule_executions (
          execution_key, organization_id, schedule_id, frequency, period_start, period_end,
          attempt_count, status, started_at, lease_expires_at, next_retry_at, error_message, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,1,'running',$7,$8,NULL,NULL,$7)
        ON CONFLICT (execution_key) DO UPDATE SET
          status = 'running',
          attempt_count = app_schedule_executions.attempt_count + 1,
          started_at = EXCLUDED.started_at,
          lease_expires_at = EXCLUDED.lease_expires_at,
          next_retry_at = NULL,
          error_message = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          input.executionKey,
          input.organizationId,
          input.scheduleId,
          input.frequency,
          input.periodStart,
          input.periodEnd,
          nowIso,
          leaseIso
        ]
      );
      await client.query("COMMIT");
      return { outcome: "claimed", record: mapExecutionRow(upsertRes.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeExecution(input: {
    executionKey: string;
    status: "succeeded" | "failed";
    reportId?: string | null;
    errorMessage?: string | null;
    nextRetryAt?: string | null;
    now?: Date;
  }): Promise<void> {
    await this.ensureSchema();
    const nowIso = (input.now || new Date()).toISOString();
    await this.pool.query(
      `UPDATE app_schedule_executions
       SET status = $1,
           report_id = COALESCE($2, report_id),
           completed_at = $3,
           lease_expires_at = NULL,
           next_retry_at = $4,
           error_message = $5,
           updated_at = $3
       WHERE execution_key = $6`,
      [
        input.status,
        input.reportId ?? null,
        nowIso,
        input.nextRetryAt ?? null,
        input.errorMessage ?? null,
        input.executionKey
      ]
    );
  }

  async getExecution(executionKey: string): Promise<ScheduleExecutionRecord | null> {
    await this.ensureSchema();
    const res = await this.pool.query("SELECT * FROM app_schedule_executions WHERE execution_key = $1", [executionKey]);
    return res.rows[0] ? mapExecutionRow(res.rows[0]) : null;
  }

  async getScheduleCursor(organizationId: string, frequency: ReportFrequency): Promise<string | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      "SELECT last_completed_period_end FROM app_schedule_cursors WHERE organization_id = $1 AND frequency = $2",
      [organizationId, frequency]
    );
    return res.rows[0]?.last_completed_period_end ? String(res.rows[0].last_completed_period_end) : null;
  }

  async setScheduleCursor(organizationId: string, frequency: ReportFrequency, lastCompletedPeriodEnd: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO app_schedule_cursors (organization_id, frequency, last_completed_period_end, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (organization_id, frequency) DO UPDATE SET
         last_completed_period_end = EXCLUDED.last_completed_period_end,
         updated_at = NOW()`,
      [organizationId, frequency, lastCompletedPeriodEnd]
    );
  }
}
