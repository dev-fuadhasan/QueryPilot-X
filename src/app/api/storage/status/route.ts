import { NextResponse } from "next/server";
import { getStorageStatus } from "@/lib/storage/service";
import { getAuthenticatedStorageUser } from "@/lib/storage/session-auth";
import { getStorageConfig } from "@/lib/storage/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    const authUser = await getAuthenticatedStorageUser();
    const status = await getStorageStatus();
    const config = getStorageConfig();

    return NextResponse.json({
      success: true,
      status,
      hasServiceRoleKey: config.isServiceRole,
      isProduction: config.isProduction,
      authenticated: Boolean(authUser),
      currentUser: authUser ? {
        userId: authUser.userId,
        mode: authUser.mode,
        projectRef: authUser.projectRef
      } : null
    }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch storage status.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
