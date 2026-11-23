import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedStorageUser } from "@/lib/storage/session-auth";
import { createSignedDownloadUrl, downloadFile } from "@/lib/storage/service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedStorageUser();
    if (!authUser) {
      return NextResponse.json(
        { error: "Unauthorized: Active QueryPilot-X session required to download files." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    const mode = searchParams.get("mode"); // "url" for signed URL or direct download

    if (!key) {
      return NextResponse.json(
        { error: "Bad Request: Storage 'key' is required." },
        { status: 400 }
      );
    }

    if (mode === "url") {
      const signedUrl = await createSignedDownloadUrl(authUser.userId, key, 60);
      return NextResponse.json({ success: true, url: signedUrl });
    }

    const fileResult = await downloadFile(authUser.userId, key);

    if (!fileResult.buffer) {
      return NextResponse.json({ error: "File content unavailable." }, { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", fileResult.mimeType);
    headers.set("Content-Length", String(fileResult.sizeBytes));
    headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(fileResult.filename)}"`);
    headers.set("Cache-Control", "private, no-cache, no-store, max-age=0");

    return new Response(fileResult.buffer as unknown as BodyInit, {
      status: 200,
      headers
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Download failed.";
    const status = message.includes("Access denied") ? 403 : message.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
