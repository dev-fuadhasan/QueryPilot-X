import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { executeFraudQuery } from "@/../fraud_detection_and_notification/fraud-db";
import { generateStableChangeHash } from "@/../fraud_detection_and_notification/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function quoteIdentifier(val: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) {
    throw new Error(`Invalid identifier: ${val}`);
  }
  return `"${val}"`;
}

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  const session = access.session;

  try {
    // 1. Discover all public tables
    const tableSql = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name
      LIMIT 50
    `;
    const tableRows = await executeFraudQuery(session, tableSql);
    const tableNames = tableRows.map((r) => String(r.table_name));

    // 2. Discover primary keys for all public tables to ensure deterministic ordering & row indexing
    const pkSql = `
      SELECT 
        tc.table_name, 
        kcu.column_name as pk_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    `;
    const pkMap: Record<string, string> = {};
    try {
      const pkRows = await executeFraudQuery(session, pkSql);
      for (const r of pkRows) {
        if (r.table_name && r.pk_column) {
          pkMap[String(r.table_name)] = String(r.pk_column);
        }
      }
    } catch {
      // Non-fatal if permission denied on constraints view
    }

    const snapshot: Record<string, Record<string, unknown>[]> = {};
    const auditChanges: Array<{
      id: string;
      tableName: string;
      recordId: string;
      columnName: string;
      oldValue: unknown;
      newValue: unknown;
      changedBy: string | null;
      changedAt: string;
      eventType: string;
      changeHash: string;
    }> = [];

    // Track audit changes to prevent snapshot diffing from duplicating the same events
    const auditCoveredSet = new Set<string>();

    // 3. Process audit tables first if they exist
    for (const name of tableNames) {
      const lower = name.toLowerCase();

      if (lower === "querypilot_universal_audit_log") {
        try {
          const auditSql = `
            SELECT id, table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
            FROM public.querypilot_universal_audit_log
            ORDER BY changed_at DESC
            LIMIT 200
          `;
          const rows = await executeFraudQuery(session, auditSql);
          for (const r of rows) {
            const tName = String(r.table_name || "unknown");
            const rId = String(r.record_id || "unknown");
            const cName = String(r.column_name || "record");
            const hash = generateStableChangeHash(tName, rId, cName, r.old_value, r.new_value);
            const stableId = `audit_univ_${r.id}`;

            auditCoveredSet.add(`${tName}:${rId}:${cName}`);

            auditChanges.push({
              id: stableId,
              tableName: tName,
              recordId: rId,
              columnName: cName,
              oldValue: r.old_value,
              newValue: r.new_value,
              changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
              changedAt: String(r.changed_at),
              eventType: typeof r.event_type === "string" ? r.event_type : "UPDATE",
              changeHash: hash
            });
          }
        } catch {
          // Ignore
        }
        continue;
      }

      if (lower === "sales_audit_log") {
        try {
          const salesSql = `
            SELECT id, sale_id, old_amount, new_amount, changed_at, changed_by, action
            FROM public.sales_audit_log
            ORDER BY id DESC
            LIMIT 200
          `;
          const rows = await executeFraudQuery(session, salesSql);
          for (const r of rows) {
            const tName = "sales";
            const rId = String(r.sale_id || "unknown");
            const cName = "amount";
            const hash = generateStableChangeHash(tName, rId, cName, r.old_amount, r.new_amount);
            const stableId = `audit_sale_${r.id}`;

            auditCoveredSet.add(`${tName}:${rId}:${cName}`);

            auditChanges.push({
              id: stableId,
              tableName: tName,
              recordId: rId,
              columnName: cName,
              oldValue: r.old_amount,
              newValue: r.new_amount,
              changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
              changedAt: String(r.changed_at),
              eventType: "UPDATE",
              changeHash: hash
            });
          }
        } catch {
          // Ignore
        }
        continue;
      }
    }

    // 4. Fetch snapshot of normal business tables with deterministic ORDER BY
    for (const name of tableNames) {
      const lower = name.toLowerCase();
      if (lower === "querypilot_universal_audit_log" || lower === "sales_audit_log") {
        continue;
      }

      try {
        const qTable = quoteIdentifier(name);
        const pkCol = pkMap[name];

        let rowsSql: string;
        if (pkCol && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pkCol)) {
          // Guaranteed deterministic order by primary key
          rowsSql = `SELECT * FROM public.${qTable} ORDER BY ${quoteIdentifier(pkCol)} ASC LIMIT 200`;
        } else {
          // Fallback: try common ID column or plain limit
          rowsSql = `SELECT * FROM public.${qTable} LIMIT 200`;
        }

        const rows = await executeFraudQuery(session, rowsSql);
        snapshot[name] = rows;

        // If primary key was not detected via constraints, inspect columns of the rows
        if (!pkMap[name] && rows.length > 0) {
          const firstRow = rows[0];
          const candidateKeys = Object.keys(firstRow);
          const foundKey = candidateKeys.find(k => {
            const lk = k.toLowerCase();
            return lk === "id" || lk === "uuid" || lk.endsWith("_id") || lk === "code" || lk === "key";
          }) || candidateKeys[0];
          if (foundKey) {
            pkMap[name] = foundKey;
          }
        }
      } catch (err) {
        console.warn(`Could not snapshot table ${name}:`, err);
      }
    }

    return access.applyCookie(
      NextResponse.json(
        {
          success: true,
          timestamp: new Date().toISOString(),
          tables: tableNames.filter(t => !t.toLowerCase().includes("audit_log")),
          primaryKeys: pkMap,
          snapshot,
          auditChanges,
          auditCoveredFields: Array.from(auditCoveredSet)
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (error) {
    console.error("Snapshot error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not fetch table snapshots.",
      },
      { status: 500 }
    );
  }
}
