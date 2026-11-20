import { Client } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { queryOAuth } from "@/lib/supabase";
import { queryPostgres } from "@/lib/database";
import type { Session } from "@/lib/session";

function getSslConfig() {
  const certPath = join(process.cwd(), "prod-ca-2021.crt");
  if (existsSync(certPath)) {
    return {
      ca: readFileSync(certPath, "utf8"),
      rejectUnauthorized: true,
    };
  }
  return { rejectUnauthorized: false };
}

export async function queryFraudDatabase(
  connectionString: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const client = new Client({
    connectionString,
    ssl: getSslConfig(),
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });

  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '12000ms'");

    const result = await client.query(sql);
    await client.query("ROLLBACK");

    return (result.rows as Record<string, unknown>[]) || [];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function executeFraudQuery(
  session: Session,
  sql: string
): Promise<Record<string, unknown>[]> {
  if (session.mode === "oauth") {
    return await queryOAuth(session, sql);
  }

  if (!session.dbUrl) {
    throw new Error("No database connection URL available in session.");
  }

  // Use queryPostgres from shared lib or fallback to queryFraudDatabase with cert
  try {
    return await queryPostgres(session.dbUrl, sql);
  } catch {
    return await queryFraudDatabase(session.dbUrl, sql);
  }
}
