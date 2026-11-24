import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedStorageUser } from "@/lib/storage/session-auth";
import { deleteFile } from "@/lib/storage/service";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedStorageUser();
    if (!authUser) {
      return NextResponse.json(
        { error: "Unauthorized: Active QueryPilot-X session required to delete files." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");

    if (!key) {
      return NextResponse.json(
        { error: "Bad Request: Storage 'key' is required." },
        { status: 400 }
      );
    }

    const deleted = await deleteFile(authUser.userId, key);

    return NextResponse.json({
      success: true,
      deleted,
      key
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Deletion failed.";
    const status = message.includes("Access denied") ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
