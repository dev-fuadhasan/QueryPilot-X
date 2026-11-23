CREATE TABLE IF NOT EXISTS app_daily_analysis_settings (
  organization_id TEXT PRIMARY KEY NOT NULL,
  selected_domain TEXT NOT NULL DEFAULT 'sales_ecommerce',
  selected_dataset TEXT,
  auto_report_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_report_enabled IN (0, 1)),
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  scheduled_time TEXT NOT NULL DEFAULT '00:15',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  comparison_preset TEXT NOT NULL DEFAULT 'previous_30_days',
  comparison_days INTEGER NOT NULL DEFAULT 30 CHECK (comparison_days >= 1 AND comparison_days <= 3650),
  expected_cadence TEXT NOT NULL DEFAULT 'irregular' CHECK (expected_cadence IN ('daily', 'weekdays', 'weekly', 'irregular')),
  alert_rules_json TEXT NOT NULL DEFAULT '{}',
  column_overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  report_payload_json TEXT NOT NULL,
  pdf_status TEXT NOT NULL DEFAULT 'not_generated' CHECK (pdf_status IN ('not_generated', 'generated', 'failed')),
  pdf_storage_key TEXT,
  pdf_filename TEXT,
  pdf_generated_at TEXT,
  pdf_size_bytes INTEGER CHECK (pdf_size_bytes IS NULL OR pdf_size_bytes >= 0),
  pdf_error TEXT,
  error_message TEXT,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_persistent_reports_exec_key
  ON app_persistent_reports(organization_id, execution_key)
  WHERE execution_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_persistent_reports_org_date
  ON app_persistent_reports(organization_id, reporting_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_persistent_reports_org_domain_table
  ON app_persistent_reports(organization_id, domain_id, dataset_table, reporting_date DESC);

CREATE INDEX IF NOT EXISTS idx_app_persistent_reports_org_type
  ON app_persistent_reports(organization_id, generation_type, reporting_date DESC);

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
  started_at TEXT,
  completed_at TEXT,
  lease_expires_at TEXT,
  next_retry_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_schedule_executions_org_status
  ON app_schedule_executions(organization_id, status, period_end DESC);

CREATE TABLE IF NOT EXISTS app_schedule_cursors (
  organization_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  last_completed_period_end TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, frequency)
);
