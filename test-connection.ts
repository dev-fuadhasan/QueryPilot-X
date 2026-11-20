import fs from "node:fs";
import path from "node:path";


import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { Client } from "pg";

async function testConnection() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: {
  rejectUnauthorized: true,
  ca: fs.readFileSync(path.join(process.cwd(), "prod-ca-2021.crt"), "utf8"),
},
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });

  try {
    await client.connect();
    console.log("Connection successful!");

    await client.query("BEGIN READ ONLY");

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("Readable public tables:");
    console.table(result.rows);

    await client.query("ROLLBACK");
  } catch (error) {
    console.error("Actual connection error:");
    console.error(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

testConnection();