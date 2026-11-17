import { NextRequest, NextResponse } from "next/server";
import { readSession, sameOrigin, saveSession } from "@/lib/session";
import { groupSchema, queryPostgres, schemaSql } from "@/lib/database";
import { queryOAuth, refreshSession } from "@/lib/supabase";
import { planQuestion } from "@features/smart_data_analysis_and_visualization/lib/ai";
import { safeSql } from "@features/smart_data_analysis_and_visualization/lib/sql";
import { createReport } from "@features/smart_data_analysis_and_visualization/lib/report";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const existing = await readSession();
  if (!existing || (!existing.dbUrl && !(existing.mode === "oauth" && existing.projectRef))) {
    return NextResponse.json({ error: "Connect to a Supabase database first." }, { status: 401 });
  }
  try {
    const body: unknown = await request.json();
    const args = body as { question?: unknown; table?: unknown };
    const question = typeof args?.question === "string" ? args.question.trim() : "";
    if (!question || question.length > 900) return NextResponse.json({ error: "Enter a question in 900 characters or less." }, { status: 400 });
    const connection = existing.mode === "oauth" ? await refreshSession(existing) : { session: existing, refreshed: false };
    const session = connection.session;
    const run = async (sql: string) => session.mode === "oauth" ? queryOAuth(session, sql) : queryPostgres(session.dbUrl || "", sql);
    const schema = groupSchema(await run(schemaSql));
    if (!schema.length) throw new Error("No readable public tables were found.");
    const requestedTable = typeof args?.table === "string" ? args.table : "all";
    const selected = requestedTable === "all" ? schema : schema.filter(table => table.name === requestedTable);
    if (!selected.length) throw new Error("The selected table is not available in this database.");
    const plan = await planQuestion(question, selected);
    const response = plan.action === "clarify"
      ? NextResponse.json({ type: "clarification", question: plan.question, options: plan.options, originalQuestion: question }, { headers: { "Cache-Control": "no-store" } })
      : await (async () => {
        const sql = safeSql(plan.sql || "", selected);
        const rows = await run("SELECT * FROM (" + sql + ") AS querypilot_result LIMIT 101");
        return NextResponse.json(createReport(question, sql, rows, requestedTable === "all" ? "authorized tables" : requestedTable), { headers: { "Cache-Control": "no-store" } });
      })();
    if (connection.refreshed) {
      const { issuedAt, ...saved } = session;
      saveSession(response, saved);
    }
    return response;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Analysis failed.";
    const okay = /Supabase|OAuth|database|query|AI|Groq|token|SQL|SELECT|table|schema|permission|authorization|API|model|read.only|statement|connection|timeout|generated|available/i.test(detail);
    return NextResponse.json({ error: okay ? detail.slice(0, 250) : "Could not complete this analysis. Try a more specific data question." }, { status: 400 });
  }
}
