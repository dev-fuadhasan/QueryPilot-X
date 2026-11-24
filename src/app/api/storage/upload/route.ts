import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedStorageUser } from "@/lib/storage/session-auth";
import { uploadFile } from "@/lib/storage/service";
import { validateCategory } from "@/lib/storage/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedStorageUser();
    if (!authUser) {
      return NextResponse.json(
        { error: "Unauthorized: Active QueryPilot-X session required to upload files." },
        { status: 401 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const category = formData.get("category");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Bad Request: A valid 'file' must be provided in the form data." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filename = (file as { name?: string }).name || "uploaded-file";

    const storedFile = await uploadFile({
      userId: authUser.userId,
      category: validateCategory(typeof category === "string" ? category : undefined),
      filename,
      buffer,
      mimeType: file.type
    });

    const response = NextResponse.json({
      success: true,
      file: storedFile
    }, { status: 201 });

    response.headers.set("X-Storage-Backend", storedFile.backend);
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "File upload failed.";
    const status = message.includes("Production storage failure") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
