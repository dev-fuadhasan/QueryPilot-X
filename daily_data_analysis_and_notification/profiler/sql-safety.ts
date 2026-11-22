import type { SemanticCategory } from "./types";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;

const SENSITIVE_NAME_TOKENS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "refreshkey",
  "salt",
  "hash",
  "ssn",
  "socialsecurity",
  "nationalid",
  "nid",
  "passport",
  "taxid",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "iban",
  "bankaccount",
  "routingnumber",
  "email",
  "phone",
  "mobile",
  "telephone",
  "whatsapp",
  "address",
  "street",
  "zipcode",
  "postalcode",
  "dob",
  "dateofbirth",
  "birthdate",
  "ipaddress",
  "useragent",
  "fullname",
  "firstname",
  "lastname",
  "customername",
  "clientname",
  "contactname"
];

const SENSITIVE_EXACT_NAMES = new Set([
  "ip",
  "pin",
  "otp",
  "auth",
  "jwt",
  "cookie",
  "sessiontoken"
]);

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function tokenizeName(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isValidIdentifier(value: string): boolean {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

export function validateIdentifier(value: string, allowedList?: Iterable<string>): string {
  if (!isValidIdentifier(value)) {
    throw new Error(`Unsafe or invalid database identifier: "${String(value).slice(0, 64)}"`);
  }
  if (allowedList) {
    const allowed = allowedList instanceof Set ? allowedList : new Set(allowedList);
    if (!allowed.has(value)) {
      throw new Error(`Database identifier "${value}" is not present in the discovered schema.`);
    }
  }
  return value;
}

export function quoteIdentifier(value: string, allowedList?: Iterable<string>): string {
  const safe = validateIdentifier(value, allowedList);
  return `"${safe.replace(/"/g, "\"\"")}"`;
}

export function quoteQualifiedTable(schema: string, table: string, allowedTables?: Iterable<string>): string {
  const safeSchema = quoteIdentifier(schema);
  const safeTable = quoteIdentifier(table, allowedTables);
  return `${safeSchema}.${safeTable}`;
}

export function isSensitiveColumnName(columnName: string): boolean {
  const normalized = normalizeName(columnName);
  if (!normalized) return false;
  if (SENSITIVE_EXACT_NAMES.has(normalized)) return true;
  if (SENSITIVE_NAME_TOKENS.some(token => normalized.includes(token))) return true;
  const tokens = tokenizeName(columnName);
  return tokens.includes("email") || tokens.includes("phone") || tokens.includes("password") || tokens.includes("secret") || tokens.includes("token");
}

export function isSafeTokenValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  // Exclude anything resembling email, phone number, UUID, or long digit sequences
  if (/@/.test(trimmed)) return null;
  if (/\d{6,}/.test(trimmed)) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) return null;
  if (/https?:\/\//i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function classifyPostgresDataType(
  rawDataType: string,
  udtName?: string,
  columnName?: string
): { category: SemanticCategory; supported: boolean; isIntegerType: boolean } {
  const dt = (rawDataType || "").trim().toLowerCase();
  const udt = (udtName || "").trim().toLowerCase();
  const combined = `${dt} ${udt}`.trim();

  if (
    dt === "array"
    || udt.startsWith("_")
    || dt.includes("json")
    || udt.includes("json")
    || dt === "bytea"
    || udt === "bytea"
    || dt === "xml"
    || dt === "tsvector"
    || dt === "tsquery"
    || dt === "inet"
    || dt === "cidr"
    || dt === "macaddr"
    || dt === "macaddr8"
    || dt === "point"
    || dt === "line"
    || dt === "polygon"
    || dt === "box"
    || dt === "path"
    || dt === "circle"
    || dt === "interval"
    || dt === "bit"
    || dt === "bit varying"
    || dt === "pg_lsn"
    || dt === "txid_snapshot"
    || (dt === "user-defined" && ["geometry", "geography", "vector", "citext", "hstore", "ltree"].includes(udt) && udt !== "citext")
  ) {
    return { category: "unsupported", supported: false, isIntegerType: false };
  }

  if (dt === "boolean" || udt === "bool") {
    return { category: "boolean", supported: true, isIntegerType: false };
  }

  if (
    dt === "date"
    || dt.startsWith("timestamp")
    || dt.startsWith("time ")
    || dt === "time"
    || udt === "date"
    || udt === "timestamp"
    || udt === "timestamptz"
  ) {
    return { category: "temporal", supported: true, isIntegerType: false };
  }

  if (
    dt === "smallint"
    || dt === "integer"
    || dt === "bigint"
    || dt === "int2"
    || dt === "int4"
    || dt === "int8"
    || udt === "int2"
    || udt === "int4"
    || udt === "int8"
  ) {
    return { category: "numeric", supported: true, isIntegerType: true };
  }

  if (
    dt === "numeric"
    || dt === "decimal"
    || dt === "real"
    || dt === "double precision"
    || dt === "float4"
    || dt === "float8"
    || dt === "money"
    || udt === "numeric"
    || udt === "float4"
    || udt === "float8"
    || udt === "money"
  ) {
    return { category: "numeric", supported: true, isIntegerType: false };
  }

  if (dt === "uuid" || udt === "uuid") {
    return { category: "identifier", supported: true, isIntegerType: false };
  }

  if (
    dt === "text"
    || dt === "character varying"
    || dt === "character"
    || dt === "varchar"
    || dt === "char"
    || dt === "name"
    || udt === "text"
    || udt === "varchar"
    || udt === "bpchar"
    || udt === "citext"
    || dt === "user-defined"
  ) {
    const tokens = columnName ? tokenizeName(columnName) : [];
    const looksLikeId = tokens.length > 0 && (
      tokens[tokens.length - 1] === "id"
      || tokens[tokens.length - 1] === "uuid"
      || tokens[tokens.length - 1] === "guid"
      || tokens[tokens.length - 1] === "sku"
      || tokens[tokens.length - 1] === "code"
      || tokens[tokens.length - 1] === "ref"
    );
    if (dt === "user-defined" && !udt) {
      return { category: "unsupported", supported: false, isIntegerType: false };
    }
    return {
      category: looksLikeId ? "identifier" : "text",
      supported: true,
      isIntegerType: false
    };
  }

  if (!combined) {
    return { category: "unsupported", supported: false, isIntegerType: false };
  }

  return { category: "unsupported", supported: false, isIntegerType: false };
}
