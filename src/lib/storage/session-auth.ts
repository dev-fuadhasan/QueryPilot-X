import { createHash } from "node:crypto";
import { readSession, Session } from "@/lib/session";
import { validateUserId } from "./validation";

export interface AuthenticatedStorageUser {
  authenticated: boolean;
  userId: string;
  mode: "oauth" | "postgres";
  projectRef?: string;
  projectName?: string;
}

/**
 * Safely extracts user subject or identifier from an OAuth JWT without external dependencies.
 * Returns null if the token is not a valid JWT or has no subject.
 */
function extractJwtSubject(token?: string): string | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    if (payload && typeof payload === "object") {
      const sub = payload.sub || payload.user_id || payload.email;
      if (typeof sub === "string" && sub.trim()) {
        return sub.trim();
      }
    }
  } catch {
    // Malformed or opaque token
  }

  return null;
}

/**
 * Derives a deterministic, privacy-preserving, user-specific storage identity.
 *
 * CRITICAL FIX: Does NOT rely solely on projectRef, preventing cross-user collisions
 * where multiple team members access the same project.
 *
 * - OAuth Mode: Extracts the immutable user UUID (`sub`) from the OAuth JWT.
 *   If opaque, hashes the user's specific OAuth token grant.
 * - Postgres Mode: Extracts and hashes the database username and host identity.
 */
export function deriveUserIdFromSession(session: Session): string {
  if (!session || !session.mode) {
    throw new Error("Cannot derive identity: invalid session object.");
  }

  if (session.mode === "oauth") {
    // 1. Try to extract permanent user subject from OAuth JWT
    const jwtSub = extractJwtSubject(session.accessToken);
    if (jwtSub) {
      const hash = createHash("sha256").update(`oauth_sub:${jwtSub}`).digest("hex").slice(0, 16);
      return `usr_${hash}`;
    }

    // 2. If opaque token, hash user-specific credentials (refreshToken / accessToken)
    // Never use projectRef alone because projectRef is shared among all collaborators on a DB
    const userCredential = session.refreshToken || session.accessToken;
    if (userCredential) {
      const hash = createHash("sha256").update(`oauth_cred:${userCredential}`).digest("hex").slice(0, 16);
      return `usr_${hash}`;
    }

    // 3. Fallback to hashed session subject if tokens missing
    const fallback = createHash("sha256").update(`oauth_proj:${session.projectRef || "anon"}`).digest("hex").slice(0, 16);
    return `usr_${fallback}`;
  } else {
    // Postgres Mode: parse connection string to isolate specific db user and host
    if (session.dbUrl) {
      try {
        let cleanUrl = session.dbUrl.trim();
        if ((cleanUrl.startsWith('"') && cleanUrl.endsWith('"')) || (cleanUrl.startsWith("'") && cleanUrl.endsWith("'"))) {
          cleanUrl = cleanUrl.substring(1, cleanUrl.length - 1);
        }
        const parsed = new URL(cleanUrl);
        const userIdentity = `${parsed.username || "default"}@${parsed.host}${parsed.pathname}`;
        const hash = createHash("sha256").update(`pg_user:${userIdentity}`).digest("hex").slice(0, 16);
        return `pgusr_${hash}`;
      } catch {
        // If URL parsing fails, hash the full dbUrl without exposing secrets
        const hash = createHash("sha256").update(`pg_raw:${session.dbUrl}`).digest("hex").slice(0, 16);
        return `pgusr_${hash}`;
      }
    }

    const fallback = createHash("sha256").update(`pg_proj:${session.projectRef || "anon"}`).digest("hex").slice(0, 16);
    return `pgusr_${fallback}`;
  }
}

/**
 * Validates caller's session from the encrypted HTTP cookie and returns their
 * authenticated storage identity. Rejects unauthenticated callers immediately.
 */
export async function getAuthenticatedStorageUser(): Promise<AuthenticatedStorageUser | null> {
  const session = await readSession();
  if (!session) {
    return null;
  }

  // Ensure session is connected and active
  const isConnected = Boolean(session.dbUrl || (session.mode === "oauth" && session.projectRef));
  if (!isConnected) {
    return null;
  }

  const derivedUserId = deriveUserIdFromSession(session);
  const safeUserId = validateUserId(derivedUserId);

  return {
    authenticated: true,
    userId: safeUserId,
    mode: session.mode,
    projectRef: session.projectRef,
    projectName: session.projectName
  };
}
