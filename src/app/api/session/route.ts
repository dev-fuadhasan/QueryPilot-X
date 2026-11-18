import { NextResponse } from "next/server";
import { oauthReady, readSession } from "@/lib/session";
<<<<<<< HEAD
import { aiReady } from "@features/smart_data_analysis_and_visualization/lib/ai";
=======
>>>>>>> saikat

export const runtime = "nodejs";

export async function GET() {
  const session = await readSession();
  return NextResponse.json({
    connected: Boolean(session?.dbUrl || (session?.mode === "oauth" && session.projectRef)),
    projectName: session?.projectName || "",
    projectRef: session?.projectRef || "",
    projects: session?.mode === "oauth" ? session.projects || [] : [],
    mode: session?.mode || null,
    oauthEnabled: oauthReady(),
<<<<<<< HEAD
    aiEnabled: aiReady(),
=======
>>>>>>> saikat
    configured: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32)
  }, { headers: { "Cache-Control": "no-store" } });
}
