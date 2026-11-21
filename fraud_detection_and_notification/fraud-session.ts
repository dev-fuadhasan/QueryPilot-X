import { NextResponse } from "next/server";
import { readSession, saveSession, type Session } from "@/lib/session";
import { refreshSession } from "@/lib/supabase";

export type FraudSessionResult =
  | { session: Session; applyCookie: (response: NextResponse) => NextResponse }
  | { response: NextResponse };

export async function readFraudSession(
  request?: Request
): Promise<FraudSessionResult> {
  const session = await readSession();

  if (
    !session ||
    (!session.dbUrl &&
      !(session.mode === "oauth" && session.projectRef && session.accessToken))
  ) {
    return {
      response: NextResponse.json(
        {
          connected: false,
          error: "Connect a Supabase project before using Fraud Detection.",
        },
        { status: 401 }
      ),
    };
  }

  if (session.mode === "oauth") {
    try {
      const refreshed = await refreshSession(session);
      return {
        session: refreshed.session,
        applyCookie: (response: NextResponse) => {
          if (refreshed.refreshed) {
            const { issuedAt: _issuedAt, ...data } = refreshed.session;
            saveSession(response, data);
          }
          return response;
        },
      };
    } catch (error) {
      return {
        response: NextResponse.json(
          {
            connected: false,
            error:
              error instanceof Error
                ? error.message
                : "Supabase authorization expired.",
          },
          { status: 401 }
        ),
      };
    }
  }

  return { session, applyCookie: (response: NextResponse) => response };
}
