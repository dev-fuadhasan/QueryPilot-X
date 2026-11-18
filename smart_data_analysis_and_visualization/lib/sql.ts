import { parse } from "pgsql-ast-parser";
import type { SchemaTable } from "@/lib/database";

export function safeSql(raw: string, schema: SchemaTable[]) {
  let sql = raw.trim().replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/, "").replace(/;\s*$/, "").trim();
  if (!sql || sql.length > 7000) throw new Error("The generated SQL is empty or too long.");
  if (!/^(select|with)\s/i.test(sql)) throw new Error("Only read-only SELECT statements can run.");
  if (/--|\/\*|\*\/|\x00|\$\$|\$[a-z_]+\$/i.test(sql)) throw new Error("SQL comments and special statements are not supported.");
  if (/;|\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|execute|call|copy|vacuum|analyze|merge|set|reset|show|lock|into|pg_sleep|dblink|lo_export|pg_read_file|pg_ls_dir|pg_terminate_backend|pg_cancel_backend)\b/i.test(sql)) throw new Error("Only a single read-only SELECT statement is allowed.");
  if (/\b(auth|storage|vault|extensions|realtime|pg_catalog|information_schema|graphql|supabase_functions)\s*\./i.test(sql)) throw new Error("Only approved public tables can be queried.");
  if (/\bpublic\s*\.\s*\w+\s*\(/i.test(sql)) throw new Error("Database functions are not allowed.");
  try {
    const statements = parse(sql);
    if (statements.length !== 1 || !["select", "with"].includes(statements[0]?.type)) throw new Error("Only SELECT statements can run.");
  } catch {
    throw new Error("The generated SQL could not be validated.");
  }
  const allowed = new Set(schema.map(table => table.name.toLowerCase()));
  const ctes = new Set([...sql.matchAll(/\b(?:with|,)\s*(\w+)\s+as\s*\(/gi)].map(item => item[1].toLowerCase()));
  const refs = [...sql.matchAll(/\b(?:from|join)\s+(?:(?:public|"public")\s*\.\s*)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))/gi)];
  if (!refs.length) throw new Error("Select a table from the connected database.");
  for (const reference of refs) {
    const name = (reference[1] || reference[2]).toLowerCase();
    if (!allowed.has(name) && !ctes.has(name)) throw new Error("The query includes a table outside the approved schema.");
  }
  return sql;
}
