import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedStorageUser } from "@/lib/storage/session-auth";
import { listUserFiles } from "@/lib/storage/service";
import { validateCategory } from "@/lib/storage/validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedStorageUser();
    if (!authUser) {
      return NextResponse.json(
        { error: "Unauthorized: Active QueryPilot-X session required to list files." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const categoryParam = searchParams.get("category");
    const search = searchParams.get("q") || undefined;
    const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined;
    const offset = searchParams.get("offset") ? parseInt(searchParams.get("offset")!, 10) : undefined;

    const files = await listUserFiles({
      userId: authUser.userId,
      category: categoryParam ? validateCategory(categoryParam) : undefined,
      search,
      limit,
      offset
    });

    return NextResponse.json({
      success: true,
      userId: authUser.userId,
      count: files.length,
      files
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to list files.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
