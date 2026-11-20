import type { Session } from "@/lib/session";
import { executeFraudQuery } from "./fraud-db";
import {
  detectSuspiciousChanges,
  type AuditChange,
  isSensitiveColumn,
} from "./fraudDetection";
import type {
  ColumnInfo,
  TableProfile,
  UniversalAlert,
  ScanOptions,
  BusinessProfileType,
} from "./types";
import { BUSINESS_PROFILES, detectBestProfile } from "./business-profiles";

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return `"${value}"`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

export async function discoverDatabaseSchema(
  session: Session
): Promise<{
  tables: TableProfile[];
  suggestedProfile: BusinessProfileType;
  auditTables: string[];
}> {
  const sql = `
    SELECT 
      c.table_name,
      c.column_name,
      c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t 
      ON c.table_schema = t.table_schema 
     AND c.table_name = t.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY c.table_name, c.ordinal_position
    LIMIT 1000
  `;

  const rows = await executeFraudQuery(session, sql);

  const tableMap = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    const tableName = String(row.table_name);
    const columnName = String(row.column_name);
    const dataType = String(row.data_type).toLowerCase();

    if (!tableMap.has(tableName)) {
      tableMap.set(tableName, []);
    }

    const norm = normalize(columnName);

    const isNumeric = [
      "numeric",
      "integer",
      "bigint",
      "smallint",
      "decimal",
      "real",
      "double precision",
    ].some((t) => dataType.includes(t));

    const isIdentity = [
      "id",
      "uuid",
      "sale_id",
      "order_id",
      "transaction_id",
      "user_id",
      "customer_id",
      "account_id",
      "record_id",
    ].includes(norm);

    const isTimestamp =
      dataType.includes("timestamp") ||
      dataType.includes("date") ||
      ["date", "time", "created_at", "updated_at", "changed_at", "sale_date"].some((k) =>
        norm.includes(k)
      );

    const isCategorical =
      (dataType.includes("text") ||
        dataType.includes("char") ||
        dataType.includes("varchar")) &&
      ["status", "type", "role", "action", "event", "category", "gender"].some((k) =>
        norm.includes(k)
      );

    const isSensitive = isSensitiveColumn(columnName);

    tableMap.get(tableName)?.push({
      name: columnName,
      dataType,
      isNumeric,
      isIdentity,
      isTimestamp,
      isCategorical,
      isSensitive,
    });
  }

  const allTableNames = Array.from(tableMap.keys());
  const auditTables = allTableNames.filter((name) =>
    ["audit", "log", "history"].some((k) => name.toLowerCase().includes(k))
  );

  const suggestedProfile = detectBestProfile(allTableNames);

  const profiles: TableProfile[] = [];

  for (const [tableName, columns] of tableMap.entries()) {
    const normTable = tableName.toLowerCase();

    // Skip purely audit or internal tables for standard table profiling
    const isAuditTable = auditTables.includes(tableName);

    let suggestedRole: TableProfile["suggestedRole"] = "other";
    if (isAuditTable) {
      suggestedRole = "audit";
    } else if (
      ["user", "account", "profile", "member", "customer"].some((k) =>
        normTable.includes(k)
      )
    ) {
      suggestedRole = "users";
    } else if (
      ["sale", "order", "transaction", "payment", "invoice", "transfer"].some((k) =>
        normTable.includes(k)
      )
    ) {
      suggestedRole = "transactions";
    }

    // Find candidate columns
    const idCol =
      columns.find((c) => c.name.toLowerCase() === "id") ||
      columns.find((c) => c.isIdentity);

    const amountCol = columns.find(
      (c) =>
        c.isNumeric &&
        ["amount", "total", "price", "revenue", "balance", "cost", "value"].some((k) =>
          c.name.toLowerCase().includes(k)
        )
    );

    const actorCol = columns.find(
      (c) =>
        c.name.toLowerCase() !== "id" &&
        ["user", "customer", "account", "client", "buyer", "email", "author"].some((k) =>
          c.name.toLowerCase().includes(k)
        )
    );

    const timestampCol = columns.find((c) => c.isTimestamp);
    const statusCol = columns.find(
      (c) => c.name.toLowerCase().includes("status") || c.name.toLowerCase() === "state"
    );
    const roleCol = columns.find((c) => c.name.toLowerCase().includes("role"));

    profiles.push({
      name: tableName,
      rowCount: 0,
      columns,
      suggestedRole,
      idColumn: idCol?.name || null,
      amountColumn: amountCol?.name || null,
      actorColumn: actorCol?.name || null,
      timestampColumn: timestampCol?.name || null,
      statusColumn: statusCol?.name || null,
      roleColumn: roleCol?.name || null,
    });
  }

  return {
    tables: profiles,
    suggestedProfile,
    auditTables,
  };
}

export async function runUniversalScan(
  session: Session,
  options: ScanOptions = {}
): Promise<{
  alerts: UniversalAlert[];
  scannedTables: string[];
  totalRecordsAnalyzed: number;
  profile: BusinessProfileType;
}> {
  const alerts: UniversalAlert[] = [];
  let totalRecordsAnalyzed = 0;

  const { tables, auditTables, suggestedProfile } =
    await discoverDatabaseSchema(session);

  const profileType = options.profile || suggestedProfile;
  const profileConfig = BUSINESS_PROFILES[profileType] || BUSINESS_PROFILES.universal;

  const targetTableNames =
    options.tableNames && options.tableNames.length > 0
      ? options.tableNames
      : tables.map((t) => t.name);

  // Multiplier for outlier Z-score based on sensitivity
  const sensitivityMultiplier =
    options.sensitivity === "high"
      ? 2.2
      : options.sensitivity === "low"
      ? 3.8
      : 3.0;

  for (const table of tables) {
    if (!targetTableNames.includes(table.name)) continue;

    // Check if table is an audit table
    if (auditTables.includes(table.name)) {
      try {
        const auditAlerts = await scanAuditTable(session, table.name);
        alerts.push(...auditAlerts);
        totalRecordsAnalyzed += auditAlerts.length;
      } catch (err) {
        console.warn(`Could not scan audit table ${table.name}:`, err);
      }
      continue;
    }

    // Standard business table scan
    try {
      const qTable = quoteIdentifier(table.name);

      // 1. OUTLIER / ABNORMAL AMOUNT SCAN
      if (
        profileConfig.rules.includes("OUTLIER_AMOUNT") &&
        table.amountColumn
      ) {
        const qAmount = quoteIdentifier(table.amountColumn);
        const statsSql = `
          SELECT 
            COUNT(*) AS total_count,
            AVG(CAST(${qAmount} AS double precision)) AS avg_val,
            STDDEV(CAST(${qAmount} AS double precision)) AS std_val,
            MAX(CAST(${qAmount} AS double precision)) AS max_val,
            MIN(CAST(${qAmount} AS double precision)) AS min_val
          FROM public.${qTable}
          WHERE ${qAmount} IS NOT NULL
        `;

        const statsResult = await executeFraudQuery(session, statsSql);
        const statRow = statsResult[0];

        if (statRow && Number(statRow.total_count) > 0) {
          const totalCount = Number(statRow.total_count);
          totalRecordsAnalyzed += totalCount;

          const avgVal = Number(statRow.avg_val) || 0;
          const stdVal = Number(statRow.std_val) || 0;
          const minVal = Number(statRow.min_val) || 0;

          // Check negative value anomaly
          if (minVal < 0) {
            const idCol = table.idColumn ? quoteIdentifier(table.idColumn) : "1";
            const negSql = `
              SELECT ${idCol} AS rec_id, ${qAmount} AS val
              FROM public.${qTable}
              WHERE ${qAmount} < 0
              LIMIT 5
            `;
            const negRows = await executeFraudQuery(session, negSql);
            for (const r of negRows) {
              alerts.push({
                id: `neg-${table.name}-${r.rec_id || Math.random().toString(36).slice(2, 7)}`,
                ruleCategory: "OUTLIER_AMOUNT",
                title: `Negative Value in ${table.name}.${table.amountColumn}`,
                severity: "high",
                tableName: table.name,
                recordId: String(r.rec_id ?? "unknown"),
                columnName: table.amountColumn,
                newValue: r.val,
                timestamp: new Date().toISOString(),
                reason: `Negative value (${r.val}) detected in ${table.name}.${table.amountColumn}. Unexpected negative amount.`,
                recommendation:
                  "Investigate whether this is an unauthorized refund, balance drain, or data corruption.",
              });
            }
          }

          // Check high statistical outliers if we have enough variance
          if (stdVal > 0 && totalCount >= 3) {
            const outlierThreshold = avgVal + sensitivityMultiplier * stdVal;
            const idCol = table.idColumn ? quoteIdentifier(table.idColumn) : "1";
            const actorCol = table.actorColumn
              ? quoteIdentifier(table.actorColumn)
              : "NULL";
            const timeCol = table.timestampColumn
              ? quoteIdentifier(table.timestampColumn)
              : "now()";

            const outlierSql = `
              SELECT 
                ${idCol} AS rec_id,
                ${qAmount} AS val,
                ${actorCol} AS actor,
                ${timeCol} AS rec_time
              FROM public.${qTable}
              WHERE CAST(${qAmount} AS double precision) > ${outlierThreshold}
              ORDER BY CAST(${qAmount} AS double precision) DESC
              LIMIT 10
            `;

            const outlierRows = await executeFraudQuery(session, outlierSql);
            for (const r of outlierRows) {
              const val = Number(r.val);
              const zScore = (val - avgVal) / stdVal;
              const severity = zScore > 4.5 ? "critical" : "high";

              alerts.push({
                id: `outlier-${table.name}-${r.rec_id}`,
                ruleCategory: "OUTLIER_AMOUNT",
                title: `Abnormal High-Value Transaction in ${table.name}`,
                severity,
                tableName: table.name,
                recordId: String(r.rec_id),
                columnName: table.amountColumn,
                newValue: val,
                actor: r.actor ? String(r.actor) : null,
                timestamp: r.rec_time ? String(r.rec_time) : new Date().toISOString(),
                reason: `Value of ${val} is ${zScore.toFixed(1)} standard deviations above table average (${avgVal.toFixed(2)}).`,
                recommendation:
                  "Hold transaction for manual compliance review. Check account history and transaction authenticity.",
                metadata: {
                  zScore: Number(zScore.toFixed(2)),
                  tableAverage: Number(avgVal.toFixed(2)),
                  threshold: Number(outlierThreshold.toFixed(2)),
                },
              });
            }
          }
        }
      }

      // 2. DUPLICATE TRANSACTION ANOMALY
      if (
        profileConfig.rules.includes("DUPLICATE_TRANSACTION") &&
        table.amountColumn &&
        table.actorColumn &&
        table.idColumn
      ) {
        const qAmount = quoteIdentifier(table.amountColumn);
        const qActor = quoteIdentifier(table.actorColumn);
        const qId = quoteIdentifier(table.idColumn);

        const dupSql = `
          SELECT 
            ${qActor} AS actor,
            ${qAmount} AS amount,
            COUNT(*) AS dup_count,
            MIN(CAST(${qId} AS text)) AS first_id,
            MAX(CAST(${qId} AS text)) AS second_id
          FROM public.${qTable}
          WHERE ${qActor} IS NOT NULL AND ${qAmount} IS NOT NULL
          GROUP BY ${qActor}, ${qAmount}
          HAVING COUNT(*) > 1
          ORDER BY dup_count DESC
          LIMIT 5
        `;

        const dupRows = await executeFraudQuery(session, dupSql);
        for (const r of dupRows) {
          alerts.push({
            id: `dup-${table.name}-${r.first_id}-${r.second_id}`,
            ruleCategory: "DUPLICATE_TRANSACTION",
            title: `Duplicate Transaction Detected (${r.dup_count}x)`,
            severity: Number(r.dup_count) > 2 ? "high" : "medium",
            tableName: table.name,
            recordId: `${r.first_id}, ${r.second_id}`,
            columnName: table.amountColumn,
            newValue: r.amount,
            actor: String(r.actor),
            timestamp: new Date().toISOString(),
            reason: `Actor "${r.actor}" has ${r.dup_count} identical records of ${r.amount} in ${table.name}.`,
            recommendation:
              "Confirm whether this is a legitimate recurring charge or duplicate replay attack / accidental double-tap.",
          });
        }
      }

      // 3. VELOCITY BURST ANOMALY (e.g. Carding / Bot Burst)
      if (
        profileConfig.rules.includes("VELOCITY_SPIKE") &&
        table.actorColumn
      ) {
        const qActor = quoteIdentifier(table.actorColumn);
        const velocitySql = `
          SELECT 
            ${qActor} AS actor,
            COUNT(*) AS total_events
          FROM public.${qTable}
          WHERE ${qActor} IS NOT NULL
          GROUP BY ${qActor}
          HAVING COUNT(*) >= 5
          ORDER BY total_events DESC
          LIMIT 5
        `;

        const velRows = await executeFraudQuery(session, velocitySql);
        for (const r of velRows) {
          const count = Number(r.total_events);
          alerts.push({
            id: `vel-${table.name}-${r.actor}-${count}`,
            ruleCategory: "VELOCITY_SPIKE",
            title: `High-Velocity Burst for ${r.actor}`,
            severity: count >= 10 ? "critical" : "high",
            tableName: table.name,
            recordId: `actor:${r.actor}`,
            actor: String(r.actor),
            timestamp: new Date().toISOString(),
            reason: `Actor "${r.actor}" triggered ${count} rapid transactions/actions in ${table.name}.`,
            recommendation:
              "Temporarily throttle or challenge actor with 2FA/CAPTCHA. Verify whether this is an automated bot attack.",
          });
        }
      }

      // 4. ROLE ESCALATION (Facebook / Social / User Platform Profile)
      if (
        profileConfig.rules.includes("ROLE_ESCALATION") &&
        table.roleColumn &&
        table.idColumn
      ) {
        const qRole = quoteIdentifier(table.roleColumn);
        const qId = quoteIdentifier(table.idColumn);
        const qActor = table.actorColumn
          ? quoteIdentifier(table.actorColumn)
          : qId;

        const roleSql = `
          SELECT 
            ${qId} AS rec_id,
            ${qActor} AS actor,
            ${qRole} AS role_val
          FROM public.${qTable}
          WHERE LOWER(CAST(${qRole} AS text)) IN ('admin', 'superadmin', 'superuser', 'owner', 'moderator')
          ORDER BY ${qId} DESC
          LIMIT 10
        `;

        const roleRows = await executeFraudQuery(session, roleSql);
        for (const r of roleRows) {
          alerts.push({
            id: `role-${table.name}-${r.rec_id}`,
            ruleCategory: "ROLE_ESCALATION",
            title: `Elevated Administrative Privilege: ${r.role_val}`,
            severity: "medium",
            tableName: table.name,
            recordId: String(r.rec_id),
            columnName: table.roleColumn,
            newValue: r.role_val,
            actor: r.actor ? String(r.actor) : null,
            timestamp: new Date().toISOString(),
            reason: `Account "${r.actor || r.rec_id}" has elevated role "${r.role_val}" in ${table.name}.`,
            recommendation:
              "Verify that this account was deliberately granted administrative access and not escalated via privilege exploit.",
          });
        }
      }
    } catch (err) {
      console.warn(`Error scanning table ${table.name}:`, err);
    }
  }

  // Sort alerts by severity (critical -> high -> medium -> low)
  const severityRank: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  alerts.sort(
    (a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)
  );

  return {
    alerts,
    scannedTables: targetTableNames,
    totalRecordsAnalyzed,
    profile: profileType,
  };
}

async function scanAuditTable(
  session: Session,
  tableName: string
): Promise<UniversalAlert[]> {
  const norm = tableName.toLowerCase();
  const alerts: UniversalAlert[] = [];

  // 1. Universal audit log format
  if (norm === "querypilot_universal_audit_log") {
    const sql = `
      SELECT id, table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
      FROM public.querypilot_universal_audit_log
      ORDER BY changed_at DESC
      LIMIT 500
    `;

    const rows = await executeFraudQuery(session, sql);
    const changes: AuditChange[] = rows.map((r) => ({
      id: String(r.id),
      tableName: String(r.table_name),
      recordId: String(r.record_id),
      columnName: String(r.column_name),
      oldValue: r.old_value,
      newValue: r.new_value,
      changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
      changedAt: String(r.changed_at),
      eventType: typeof r.event_type === "string" ? r.event_type : "UPDATE",
    }));

    const detected = detectSuspiciousChanges(changes, {
      thresholdPercent: 50,
      checkDecreases: true,
      checkIncreases: true,
      checkDeletions: true,
      checkSensitiveFields: true,
    });

    for (const d of detected) {
      alerts.push({
        id: `audit-${d.id}`,
        ruleCategory:
          d.eventType === "DELETE" ? "RECORD_DELETED" : "AUDIT_TAMPER",
        title:
          d.eventType === "DELETE"
            ? `Record Deleted from ${d.tableName}`
            : `Suspicious Change in ${d.tableName}.${d.columnName}`,
        severity: d.severity,
        tableName: d.tableName,
        recordId: d.recordId,
        columnName: d.columnName,
        oldValue: d.oldValue,
        newValue: d.newValue,
        actor: d.changedBy,
        timestamp: d.changedAt,
        reason: d.reason,
        recommendation:
          "Review database audit log and verify with the editor whether this modification was authorized.",
        eventType: d.eventType || "UPDATE",
      });
    }
  } else if (norm === "sales_audit_log") {
    // 2. Legacy sales audit log format
    const sql = `
      SELECT id, sale_id, old_amount, new_amount, changed_at, changed_by, action
      FROM public.sales_audit_log
      ORDER BY id DESC
      LIMIT 500
    `;

    const rows = await executeFraudQuery(session, sql);
    const changes: AuditChange[] = rows.map((r) => ({
      id: String(r.id),
      tableName: "sales",
      recordId: String(r.sale_id),
      columnName: "amount",
      oldValue: r.old_amount,
      newValue: r.new_amount,
      changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
      changedAt: String(r.changed_at),
      eventType: "UPDATE",
    }));

    const detected = detectSuspiciousChanges(changes, { thresholdPercent: 50 });
    for (const d of detected) {
      alerts.push({
        id: `sales-audit-${d.id}`,
        ruleCategory: "AUDIT_TAMPER",
        title: `Suspicious Amount Decrease in sales`,
        severity: d.severity,
        tableName: "sales",
        recordId: d.recordId,
        columnName: "amount",
        oldValue: d.oldValue,
        newValue: d.newValue,
        actor: d.changedBy,
        timestamp: d.changedAt,
        reason: d.reason,
        recommendation:
          "Investigate who authorized this significant price/amount decrease on sale record.",
        eventType: "UPDATE",
      });
    }
  }

  return alerts;
}
