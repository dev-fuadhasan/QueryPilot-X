import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function isValidIdentifier(value: string) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

export async function POST(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  try {
    const body = await request.json();

    const tableName = body?.tableName;
    const idColumn = body?.idColumn;

    let monitoredColumns: string[] = [];

    if (Array.isArray(body?.monitoredColumns)) {
      monitoredColumns = body.monitoredColumns;
    } else if (typeof body?.amountColumn === "string") {
      monitoredColumns = [body.amountColumn];
    }

    if (
      typeof tableName !== "string" ||
      typeof idColumn !== "string" ||
      !isValidIdentifier(tableName) ||
      !isValidIdentifier(idColumn) ||
      monitoredColumns.length === 0 ||
      monitoredColumns.length > 100 ||
      !monitoredColumns.every(
        (column) => typeof column === "string" && isValidIdentifier(column)
      )
    ) {
      return NextResponse.json(
        { error: "Invalid table, ID column, or monitored columns." },
        { status: 400 }
      );
    }

    monitoredColumns = [...new Set(monitoredColumns)];

    if (monitoredColumns.includes(idColumn)) {
      return NextResponse.json(
        { error: "The ID column cannot be a monitored column." },
        { status: 400 }
      );
    }

    const qTable = quoteIdentifier(tableName);
    const triggerName = `qp_audit_${tableName}_universal`;
    const qTrigger = quoteIdentifier(triggerName);

    const triggerArguments = [idColumn, ...monitoredColumns]
      .map(quoteLiteral)
      .join(", ");

    const sql = `
-- QueryPilot-X Universal Suspicious Change Monitoring Trigger
-- Run this SQL in your Supabase SQL Editor for table "${tableName}".

CREATE TABLE IF NOT EXISTS public.querypilot_universal_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  record_id text NOT NULL,
  column_name text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL DEFAULT 'UPDATE'
);

-- Ensure event_type column exists if table was created previously
ALTER TABLE public.querypilot_universal_audit_log
ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'UPDATE';

CREATE OR REPLACE FUNCTION public.querypilot_universal_audit_function()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  monitored_col text;
  old_rec jsonb;
  new_rec jsonb;
  rec_id text;
  current_user_id text;
BEGIN
  current_user_id := COALESCE(
    current_setting('request.jwt.claim.sub', true),
    session_user
  );

  -- Handle INSERT event
  IF TG_OP = 'INSERT' THEN
    new_rec := to_jsonb(NEW);
    rec_id := new_rec ->> TG_ARGV[0];

    INSERT INTO public.querypilot_universal_audit_log (
      table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
    ) VALUES (
      TG_TABLE_NAME, COALESCE(rec_id, 'unknown'), '__record__', NULL, new_rec, current_user_id, now(), 'INSERT'
    );
    RETURN NEW;
  END IF;

  -- Handle DELETE event
  IF TG_OP = 'DELETE' THEN
    old_rec := to_jsonb(OLD);
    rec_id := old_rec ->> TG_ARGV[0];

    INSERT INTO public.querypilot_universal_audit_log (
      table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
    ) VALUES (
      TG_TABLE_NAME, COALESCE(rec_id, 'unknown'), '__record__', old_rec, NULL, current_user_id, now(), 'DELETE'
    );
    RETURN OLD;
  END IF;

  -- Handle UPDATE event
  IF TG_OP = 'UPDATE' THEN
    old_rec := to_jsonb(OLD);
    new_rec := to_jsonb(NEW);
    rec_id := new_rec ->> TG_ARGV[0];

    FOR i IN 1 .. (TG_NARGS - 1) LOOP
      monitored_col := TG_ARGV[i];
      IF old_rec -> monitored_col IS DISTINCT FROM new_rec -> monitored_col THEN
        INSERT INTO public.querypilot_universal_audit_log (
          table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
        ) VALUES (
          TG_TABLE_NAME, COALESCE(rec_id, 'unknown'), monitored_col, old_rec -> monitored_col, new_rec -> monitored_col, current_user_id, now(), 'UPDATE'
        );
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ${qTrigger} ON public.${qTable};

CREATE TRIGGER ${qTrigger}
AFTER INSERT OR UPDATE OR DELETE ON public.${qTable}
FOR EACH ROW
EXECUTE FUNCTION public.querypilot_universal_audit_function(
  ${triggerArguments}
);
`.trim();

    return access.applyCookie(
      NextResponse.json(
        {
          success: true,
          tableName,
          idColumn,
          monitoredColumns,
          sql,
          manualExecutionRequired: true,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch {
    return NextResponse.json(
      { error: "Could not generate audit trigger SQL." },
      { status: 400 }
    );
  }
}
