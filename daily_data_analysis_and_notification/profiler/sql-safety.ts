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

const DATE_NAME_POSITIVE_TOKENS = new Set([
  "date",
  "day",
  "time",
  "timestamp",
  "datetime",
  "at",
  "on",
  "dt",
  "created",
  "ordered",
  "purchased",
  "sold",
  "posted",
  "recorded",
  "shipped",
  "delivered",
  "promised",
  "signup",
  "signed",
  "activity",
  "event",
  "snapshot",
  "period",
  "due"
]);

const DATE_NAME_NEGATIVE_TOKENS = new Set([
  "count",
  "days",
  "hours",
  "minutes",
  "seconds",
  "duration",
  "lead",
  "processing",
  "cycle",
  "age",
  "rate",
  "ratio",
  "amount",
  "price",
  "cost",
  "revenue",
  "qty",
  "quantity",
  "id",
  "name",
  "status",
  "type",
  "category",
  "region",
  "rep",
  "channel",
  "zone",
  "timezone"
]);

export function isDateLikeColumnName(columnName: string): boolean {
  if (!columnName || isSensitiveColumnName(columnName)) return false;
  const tokens = tokenizeName(columnName);
  if (!tokens.length) return false;
  if (tokens.some(t => DATE_NAME_NEGATIVE_TOKENS.has(t))) return false;
  if (tokens.includes("date") || tokens.includes("timestamp") || tokens.includes("datetime") || tokens.includes("dt")) return true;
  const last = tokens[tokens.length - 1];
  if (last === "at" || last === "on" || last === "day" || last === "time") {
    return tokens.length === 1 || tokens.some(t => DATE_NAME_POSITIVE_TOKENS.has(t));
  }
  return false;
}

const COMPOSITE_JOINERS = new Set(["and", "with", "plus", "vs", "versus", "combined"]);

/**
 * Detects composite multi-concept column names such as `Region_and_Sales_Rep` or `Category_and_Brand`
 * so the semantic detector treats them as ambiguous unless explicitly confirmed by the user.
 */
export function isCompositeColumnName(columnName: string): boolean {
  if (!columnName) return false;
  if (/[&+/]/.test(columnName)) return true;
  const tokens = tokenizeName(columnName);
  if (tokens.length < 3) return false;
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (COMPOSITE_JOINERS.has(tokens[i])) {
      return true;
    }
  }
  return false;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export type NumericDateOrder = "dmy" | "mdy";

export type ReliableDateParseResult =
  | { status: "empty" }
  | { status: "ambiguous" }
  | { status: "invalid" }
  | {
      status: "valid";
      iso: string;
      dateOnly: string;
      format: "iso_date" | "iso_timestamp" | "ymd_slash" | "month_name" | "dmy" | "mdy";
    };

/**
 * Inspects a column's sample/row values to mathematically prove whether numeric DD/MM/YYYY vs MM/DD/YYYY
 * dates follow DMY or MDY order. Returns null if never disambiguated (all values <= 12) or contradictory.
 */
export function detectNumericDateOrder(values: Iterable<unknown>): NumericDateOrder | null {
  let firstGt12 = 0;
  let secondGt12 = 0;
  for (const val of values) {
    if (typeof val !== "string") continue;
    const text = val.trim();
    if (!text || text.length > 32) continue;
    const m = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(text);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (a < 1 || b < 1 || a > 31 || b > 31 || (a > 12 && b > 12)) continue;
    if (a > 12 && b <= 12) firstGt12 += 1;
    else if (b > 12 && a <= 12) secondGt12 += 1;
  }
  if (firstGt12 > 0 && secondGt12 === 0) return "dmy";
  if (secondGt12 > 0 && firstGt12 === 0) return "mdy";
  return null;
}

/**
 * Strictly parses unambiguous date/timestamp strings and validates calendar dates.
 * - Accepts ISO dates (YYYY-MM-DD or YYYY-M-D), ISO timestamps (YYYY-MM-DD[T ]HH:mm...), year-first YYYY/MM/DD,
 *   and unambiguous named-month dates (e.g. "15 Jan 2026", "Jan 15, 2026", "2026-Jan-15").
 * - Explicitly flags ambiguous numeric slash/hyphen dates (DD/MM/YYYY vs MM/DD/YYYY) as "ambiguous"
 *   unless a column-proven `preferredOrder` ("dmy" or "mdy") is supplied.
 * - Rejects invalid calendar dates (e.g. 2026-02-30, 2026-13-01) and non-date strings.
 */
export function parseReliableDateString(
  value: unknown,
  preferredOrder?: NumericDateOrder
): ReliableDateParseResult {
  if (value === null || value === undefined) return { status: "empty" };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { status: "invalid" };
    const iso = value.toISOString();
    return { status: "valid", iso, dateOnly: iso.slice(0, 10), format: "iso_timestamp" };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { status: "invalid" };
  }

  const text = String(value).trim();
  if (!text) return { status: "empty" };
  if (text.length > 64) return { status: "invalid" };

  // 1. Strict ISO date: YYYY-MM-DD (also accepts unambiguous YYYY-M-D)
  const isoDateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (isoDateMatch) {
    const [, yStr, mStr, dStr] = isoDateMatch;
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (!isRealCalendarDate(y, m, d)) return { status: "invalid" };
    const dateOnly = `${yStr}-${pad2(m)}-${pad2(d)}`;
    return { status: "valid", iso: `${dateOnly}T00:00:00.000Z`, dateOnly, format: "iso_date" };
  }

  // 2. Strict ISO timestamp: YYYY-MM-DD[T ]HH:mm(:ss(.fff)?)?(Z|[+-]HH:?mm)?
  const isoTsMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (isoTsMatch) {
    const [, yStr, mStr, dStr, hStr, minStr, secStr, fracStr, tzStr] = isoTsMatch;
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    const hh = Number(hStr);
    const mm = Number(minStr);
    const ss = secStr ? Number(secStr) : 0;
    if (!isRealCalendarDate(y, m, d) || hh > 23 || mm > 59 || ss > 59) {
      return { status: "invalid" };
    }
    const msPart = fracStr ? `.${fracStr.slice(0, 3).padEnd(3, "0")}` : ".000";
    const normTz = tzStr
      ? (tzStr.toUpperCase() === "Z" ? "Z" : tzStr.includes(":") ? tzStr : `${tzStr.slice(0, 3)}:${tzStr.slice(3)}`)
      : "Z";
    const canonical = `${yStr}-${mStr}-${dStr}T${hStr}:${minStr}:${pad2(ss)}${msPart}${normTz}`;
    const parsed = new Date(canonical);
    if (Number.isNaN(parsed.getTime())) return { status: "invalid" };
    return { status: "valid", iso: parsed.toISOString(), dateOnly: `${yStr}-${mStr}-${dStr}`, format: "iso_timestamp" };
  }

  // 3. Unambiguous year-first YYYY/MM/DD (with optional HH:mm[:ss])
  const ymdSlashMatch = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (ymdSlashMatch) {
    const [, yStr, mStr, dStr, hStr, minStr, secStr] = ymdSlashMatch;
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (!isRealCalendarDate(y, m, d)) return { status: "invalid" };
    const hh = hStr ? Number(hStr) : 0;
    const mm = minStr ? Number(minStr) : 0;
    const ss = secStr ? Number(secStr) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return { status: "invalid" };
    const dateOnly = `${yStr}-${pad2(m)}-${pad2(d)}`;
    return {
      status: "valid",
      iso: `${dateOnly}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.000Z`,
      dateOnly,
      format: "ymd_slash"
    };
  }

  // 4. Numeric DD/MM/YYYY vs MM/DD/YYYY (or DD-MM-YYYY vs MM-DD-YYYY)
  const numericAmbMatch = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (numericAmbMatch) {
    const a = Number(numericAmbMatch[1]);
    const b = Number(numericAmbMatch[3]);
    const y = Number(numericAmbMatch[4]);
    const hh = numericAmbMatch[5] ? Number(numericAmbMatch[5]) : 0;
    const mm = numericAmbMatch[6] ? Number(numericAmbMatch[6]) : 0;
    const ss = numericAmbMatch[7] ? Number(numericAmbMatch[7]) : 0;
    if (a < 1 || b < 1 || a > 31 || b > 31 || (a > 12 && b > 12) || hh > 23 || mm > 59 || ss > 59) {
      return { status: "invalid" };
    }
    if (preferredOrder === "dmy") {
      if (!isRealCalendarDate(y, b, a)) return { status: "invalid" };
      const dateOnly = `${y}-${pad2(b)}-${pad2(a)}`;
      return { status: "valid", iso: `${dateOnly}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.000Z`, dateOnly, format: "dmy" };
    }
    if (preferredOrder === "mdy") {
      if (!isRealCalendarDate(y, a, b)) return { status: "invalid" };
      const dateOnly = `${y}-${pad2(a)}-${pad2(b)}`;
      return { status: "valid", iso: `${dateOnly}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.000Z`, dateOnly, format: "mdy" };
    }
    return { status: "ambiguous" };
  }

  // 5. Unambiguous named-month dates: "15 Jan 2026", "Jan 15, 2026", "2026-Jan-15"
  const dmyNameMatch = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{4})$/.exec(text);
  if (dmyNameMatch) {
    const d = Number(dmyNameMatch[1]);
    const m = MONTH_NAME_MAP[dmyNameMatch[2].toLowerCase()];
    const y = Number(dmyNameMatch[3]);
    if (!m || !isRealCalendarDate(y, m, d)) return { status: "invalid" };
    const dateOnly = `${y}-${pad2(m)}-${pad2(d)}`;
    return { status: "valid", iso: `${dateOnly}T00:00:00.000Z`, dateOnly, format: "month_name" };
  }

  const mdyNameMatch = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (mdyNameMatch) {
    const m = MONTH_NAME_MAP[mdyNameMatch[1].toLowerCase()];
    const d = Number(mdyNameMatch[2]);
    const y = Number(mdyNameMatch[3]);
    if (!m || !isRealCalendarDate(y, m, d)) return { status: "invalid" };
    const dateOnly = `${y}-${pad2(m)}-${pad2(d)}`;
    return { status: "valid", iso: `${dateOnly}T00:00:00.000Z`, dateOnly, format: "month_name" };
  }

  const ymdNameMatch = /^(\d{4})-([A-Za-z]{3,9})-(\d{1,2})$/.exec(text);
  if (ymdNameMatch) {
    const y = Number(ymdNameMatch[1]);
    const m = MONTH_NAME_MAP[ymdNameMatch[2].toLowerCase()];
    const d = Number(ymdNameMatch[3]);
    if (!m || !isRealCalendarDate(y, m, d)) return { status: "invalid" };
    const dateOnly = `${y}-${pad2(m)}-${pad2(d)}`;
    return { status: "valid", iso: `${dateOnly}T00:00:00.000Z`, dateOnly, format: "month_name" };
  }

  return { status: "invalid" };
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
