
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sslCertificate = readFileSync(
  join(process.cwd(), "prod-ca-2021.crt"),
  "utf8"
);

export async function queryFraudDatabase(
  connectionString: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const client = new Client({
    connectionString,
    ssl: {
      ca: sslCertificate,
      rejectUnauthorized: true,
    },
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });

  try {
    await client.connect();

    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '12000ms'");

    const result = await client.query(sql);

    await client.query("ROLLBACK");

    return result.rows as Record<string, unknown>[];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
