import type { Session } from "../../src/lib/session";
import { queryPostgres } from "../../src/lib/database";
import { runOAuthReadOnlyQuery } from "../../src/lib/supabase";
import { analyzeDatabaseSemantics } from "./semantic-detector";
import {
  classifyPostgresDataType,
  detectNumericDateOrder,
  isDateLikeColumnName,
  isSafeTokenValue,
  isSensitiveColumnName,
  normalizeName,
  parseReliableDateString,
  quoteIdentifier,
  quoteQualifiedTable
} from "./sql-safety";
import type {
  BusinessDomainId,
  ColumnProfile,
  DatabaseProfile,
  DatabaseRelation,
  DataFreshness,
  DuplicateCheckResult,
  NumericColumnStats,
  ReadOnlyQueryExecutor,
  TableProfile,
  TemporalColumnStats
} from "./types";

const MAX_TABLES_TO_PROFILE = 25;
const COLUMN_BATCH_SIZE = 10;
const LOW_CARDINALITY_TOKEN_LIMIT = 12;

export const SCHEMA_DISCOVERY_SQL = `
SELECT
  c.table_schema,
  c.table_name,
  t.table_type,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t
  ON c.table_schema = t.table_schema
 AND c.table_name = t.table_name
WHERE c.table_schema = 'public'
  AND t.table_type IN ('BASE TABLE', 'VIEW')
ORDER BY c.table_name, c.ordinal_position
LIMIT 1000
`.trim();

export const CONSTRAINTS_DISCOVERY_SQL = `
SELECT
  tc.table_schema,
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema = ccu.table_schema
 AND tc.constraint_type = 'FOREIGN KEY'
WHERE tc.table_schema = 'public'
  AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
ORDER BY tc.table_name, kcu.ordinal_position
LIMIT 1000
`.trim();

type RawSchemaColumn = {
  schema: string;
  tableName: string;
  tableType: "BASE TABLE" | "VIEW";
  columnName: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
};

export type ProfileOptions = {
  selectedDomain?: BusinessDomainId | null;
  tableNames?: string[];
  maxTables?: number;
  now?: Date;
  tableOverrides?: Record<string, Record<string, string>>;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: unknown): string | null {
  const parsed = parseReliableDateString(value);
  return parsed.status === "valid" ? parsed.iso : null;
}

const ISO_DATE_PG_REGEX = "^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$";
const YMD_SLASH_PG_REGEX = "^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$";
const AMBIGUOUS_NUMERIC_PG_REGEX = "^[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}([T ][0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?$";

/**
 * Safe read-only aggregate probe for date-like TEXT columns (never SELECT *, never sensitive columns).
 * Evaluates format distribution and computes MIN/MAX strictly over regex-verified ISO/YMD values
 * without crashing PostgreSQL on invalid text values.
 */
export function buildTextDateProbeSql(
  schema: string,
  tableName: string,
  columnName: string,
  allowedTables: Set<string>,
  allowedColumns: Set<string>
): string {
  if (isSensitiveColumnName(columnName)) {
    throw new Error(`Refusing to probe date values from sensitive column "${columnName}".`);
  }
  const qualified = quoteQualifiedTable(schema, tableName, allowedTables);
  const qCol = quoteIdentifier(columnName, allowedColumns);
  const expr = `TRIM(CAST(${qCol} AS TEXT))`;
  const slashNorm = `REPLACE(SPLIT_PART(${expr}, ' ', 1), '-', '/')`;
  const safeP1 = `CASE WHEN ${expr} ~ '${AMBIGUOUS_NUMERIC_PG_REGEX}' THEN CAST(NULLIF(SPLIT_PART(${slashNorm}, '/', 1), '') AS INTEGER) END`;
  const safeP2 = `CASE WHEN ${expr} ~ '${AMBIGUOUS_NUMERIC_PG_REGEX}' THEN CAST(NULLIF(SPLIT_PART(${slashNorm}, '/', 2), '') AS INTEGER) END`;
  const dmyIsoExpr = `CASE WHEN ${expr} ~ '${AMBIGUOUS_NUMERIC_PG_REGEX}' THEN CONCAT(SPLIT_PART(${slashNorm}, '/', 3), '-', LPAD(SPLIT_PART(${slashNorm}, '/', 2), 2, '0'), '-', LPAD(SPLIT_PART(${slashNorm}, '/', 1), 2, '0')) END`;
  const mdyIsoExpr = `CASE WHEN ${expr} ~ '${AMBIGUOUS_NUMERIC_PG_REGEX}' THEN CONCAT(SPLIT_PART(${slashNorm}, '/', 3), '-', LPAD(SPLIT_PART(${slashNorm}, '/', 1), 2, '0'), '-', LPAD(SPLIT_PART(${slashNorm}, '/', 2), 2, '0')) END`;
  return `SELECT
    COUNT(*) FILTER (WHERE ${qCol} IS NOT NULL AND ${expr} <> '') AS non_empty_count,
    COUNT(*) FILTER (WHERE ${expr} ~ '${ISO_DATE_PG_REGEX}') AS iso_count,
    COUNT(*) FILTER (WHERE ${expr} ~ '${YMD_SLASH_PG_REGEX}') AS ymd_slash_count,
    COUNT(*) FILTER (WHERE ${expr} ~ '${AMBIGUOUS_NUMERIC_PG_REGEX}') AS ambiguous_count,
    COUNT(*) FILTER (WHERE ${safeP1} BETWEEN 13 AND 31 AND ${safeP2} BETWEEN 1 AND 12) AS dmy_proof_count,
    COUNT(*) FILTER (WHERE ${safeP1} BETWEEN 1 AND 12 AND ${safeP2} BETWEEN 13 AND 31) AS mdy_proof_count,
    MIN(SUBSTRING(${expr} FROM 1 FOR 10)) FILTER (WHERE ${expr} ~ '${ISO_DATE_PG_REGEX}') AS iso_min,
    MAX(SUBSTRING(${expr} FROM 1 FOR 10)) FILTER (WHERE ${expr} ~ '${ISO_DATE_PG_REGEX}') AS iso_max,
    MIN(REPLACE(SUBSTRING(${expr} FROM 1 FOR 10), '/', '-')) FILTER (WHERE ${expr} ~ '${YMD_SLASH_PG_REGEX}') AS ymd_min,
    MAX(REPLACE(SUBSTRING(${expr} FROM 1 FOR 10), '/', '-')) FILTER (WHERE ${expr} ~ '${YMD_SLASH_PG_REGEX}') AS ymd_max,
    MIN(${dmyIsoExpr}) FILTER (WHERE ${safeP1} BETWEEN 1 AND 31 AND ${safeP2} BETWEEN 1 AND 12) AS dmy_min,
    MAX(${dmyIsoExpr}) FILTER (WHERE ${safeP1} BETWEEN 1 AND 31 AND ${safeP2} BETWEEN 1 AND 12) AS dmy_max,
    MIN(${mdyIsoExpr}) FILTER (WHERE ${safeP1} BETWEEN 1 AND 12 AND ${safeP2} BETWEEN 1 AND 31) AS mdy_min,
    MAX(${mdyIsoExpr}) FILTER (WHERE ${safeP1} BETWEEN 1 AND 12 AND ${safeP2} BETWEEN 1 AND 31) AS mdy_max
  FROM ${qualified}`;
}

export function buildTextDateSampleSql(
  schema: string,
  tableName: string,
  columnName: string,
  allowedTables: Set<string>,
  allowedColumns: Set<string>
): string {
  if (isSensitiveColumnName(columnName)) {
    throw new Error(`Refusing to sample date values from sensitive column "${columnName}".`);
  }
  const qualified = quoteQualifiedTable(schema, tableName, allowedTables);
  const qCol = quoteIdentifier(columnName, allowedColumns);
  return `SELECT DISTINCT TRIM(CAST(${qCol} AS TEXT)) AS date_val FROM ${qualified} WHERE ${qCol} IS NOT NULL AND LENGTH(TRIM(CAST(${qCol} AS TEXT))) BETWEEN 6 AND 40 ORDER BY date_val LIMIT 24`;
}

function evaluateTextDateSamples(
  values: unknown[],
  now: Date
): {
  isReliableDateColumn: boolean;
  temporalStats: TemporalColumnStats | null;
  warning: string | null;
} {
  let validCount = 0;
  let invalidCount = 0;
  let ambiguousCount = 0;
  const validIsos: string[] = [];
  const formats = new Set<string>();
  const provenOrder = detectNumericDateOrder(values) ?? undefined;

  for (const val of values) {
    const parsed = parseReliableDateString(val, provenOrder);
    if (parsed.status === "empty") continue;
    if (parsed.status === "valid") {
      validCount += 1;
      validIsos.push(parsed.iso);
      formats.add(parsed.format);
    } else if (parsed.status === "ambiguous") {
      ambiguousCount += 1;
    } else {
      invalidCount += 1;
    }
  }

  const totalChecked = validCount + invalidCount + ambiguousCount;
  if (totalChecked === 0) {
    return { isReliableDateColumn: false, temporalStats: null, warning: null };
  }

  if (ambiguousCount > 0 && validCount === 0) {
    return {
      isReliableDateColumn: false,
      temporalStats: {
        earliest: null,
        latest: null,
        spanDays: null,
        freshnessHours: null,
        invalidDateCount: invalidCount,
        ambiguousDateCount: ambiguousCount,
        inferredFromText: false,
        detectedFormat: "ambiguous_numeric"
      },
      warning: `Detected ${ambiguousCount} ambiguous numeric date value(s) (DD/MM/YYYY vs MM/DD/YYYY); date range not inferred silently.`
    };
  }

  const validRatio = validCount / totalChecked;
  if (validCount > 0 && validRatio >= 0.7 && ambiguousCount === 0) {
    validIsos.sort();
    const earliest = validIsos[0];
    const latest = validIsos[validIsos.length - 1];
    const spanDays = Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86_400_000));
    const freshnessHours = roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000));
    return {
      isReliableDateColumn: true,
      temporalStats: {
        earliest,
        latest,
        spanDays,
        freshnessHours,
        invalidDateCount: invalidCount,
        ambiguousDateCount: ambiguousCount,
        inferredFromText: true,
        detectedFormat: [...formats].join(",")
      },
      warning: invalidCount > 0
        ? `Skipped ${invalidCount} invalid/unparseable date value(s) while profiling text date column.`
        : null
    };
  }

  if (ambiguousCount > 0) {
    return {
      isReliableDateColumn: false,
      temporalStats: {
        earliest: null,
        latest: null,
        spanDays: null,
        freshnessHours: null,
        invalidDateCount: invalidCount,
        ambiguousDateCount: ambiguousCount,
        inferredFromText: false,
        detectedFormat: "mixed_ambiguous"
      },
      warning: `Column contains mixed or ambiguous numeric date formats (${ambiguousCount} ambiguous, ${invalidCount} invalid); date range withheld for safety.`
    };
  }

  return {
    isReliableDateColumn: false,
    temporalStats: invalidCount > 0
      ? {
          earliest: null,
          latest: null,
          spanDays: null,
          freshnessHours: null,
          invalidDateCount: invalidCount,
          ambiguousDateCount: 0,
          inferredFromText: false,
          detectedFormat: null
        }
      : null,
    warning: null
  };
}

function roundTwo(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function computeFreshness(columns: ColumnProfile[], rowCount: number, now: Date): DataFreshness {
  if (rowCount === 0) {
    return {
      primaryDateColumn: columns.find(c => c.category === "temporal")?.name || null,
      earliestDate: null,
      latestDate: null,
      ageHours: null,
      status: "empty"
    };
  }

  const temporalCandidates = columns.filter(c => c.temporalStats?.latest);
  if (!temporalCandidates.length) {
    return {
      primaryDateColumn: null,
      earliestDate: null,
      latestDate: null,
      ageHours: null,
      status: "unknown"
    };
  }

  // Prefer business event/order/transaction dates over updated_at when choosing primary freshness column
  const ranked = [...temporalCandidates].sort((a, b) => {
    const aNorm = normalizeName(a.name);
    const bNorm = normalizeName(b.name);
    const aUpdated = aNorm.includes("updated") || aNorm.includes("modified") ? 1 : 0;
    const bUpdated = bNorm.includes("updated") || bNorm.includes("modified") ? 1 : 0;
    if (aUpdated !== bUpdated) return aUpdated - bUpdated;
    const aLatest = a.temporalStats?.latest || "";
    const bLatest = b.temporalStats?.latest || "";
    return bLatest.localeCompare(aLatest);
  });

  const primary = ranked[0];
  const latest = primary.temporalStats?.latest || null;
  const earliest = primary.temporalStats?.earliest || null;
  const ageHours = latest ? roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000)) : null;

  let status: DataFreshness["status"] = "unknown";
  if (ageHours !== null) {
    if (ageHours <= 36) status = "fresh";
    else if (ageHours <= 168) status = "recent";
    else status = "stale";
  }

  return {
    primaryDateColumn: primary.name,
    earliestDate: earliest,
    latestDate: latest,
    ageHours,
    status
  };
}

export function buildColumnBatchAggregateSql(
  schema: string,
  tableName: string,
  columns: Array<{ name: string; category: ColumnProfile["category"]; supported: boolean; rawDataType: string; isIntegerType: boolean }>,
  allowedTables: Set<string>,
  allowedColumns: Set<string>
): string {
  const qualified = quoteQualifiedTable(schema, tableName, allowedTables);
  const expressions: string[] = [];

  columns.forEach((col, index) => {
    const qCol = quoteIdentifier(col.name, allowedColumns);
    const prefix = `c${index}`;

    expressions.push(`COUNT(${qCol}) AS ${prefix}_non_null`);

    if (!col.supported || col.category === "unsupported") {
      return;
    }

    expressions.push(`COUNT(DISTINCT ${qCol}) AS ${prefix}_distinct`);

    if (col.category === "numeric") {
      const castExpr = col.rawDataType.toLowerCase() === "money"
        ? `(${qCol}::numeric)::double precision`
        : `${qCol}::double precision`;
      expressions.push(`MIN(${castExpr}) AS ${prefix}_min`);
      expressions.push(`MAX(${castExpr}) AS ${prefix}_max`);
      expressions.push(`AVG(${castExpr}) AS ${prefix}_avg`);
      expressions.push(`COUNT(*) FILTER (WHERE ${castExpr} < 0) AS ${prefix}_neg`);
      expressions.push(`COUNT(*) FILTER (WHERE ${castExpr} = 0) AS ${prefix}_zero`);
      if (!col.isIntegerType) {
        expressions.push(`BOOL_AND(TRUNC(${castExpr}::numeric) = ${castExpr}::numeric) AS ${prefix}_int_only`);
      }
    } else if (col.category === "temporal") {
      expressions.push(`MIN(${qCol}) AS ${prefix}_min`);
      expressions.push(`MAX(${qCol}) AS ${prefix}_max`);
    } else if (col.category === "boolean") {
      expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS TRUE) AS ${prefix}_true_count`);
    }
  });

  if (!expressions.length) {
    return `SELECT COUNT(*) AS row_count FROM ${qualified}`;
  }

  return `SELECT ${expressions.join(", ")} FROM ${qualified}`;
}

export function buildDuplicateCheckSql(
  schema: string,
  tableName: string,
  keyColumns: string[],
  allowedTables: Set<string>,
  allowedColumns: Set<string>
): string {
  const qualified = quoteQualifiedTable(schema, tableName, allowedTables);
  const quotedKeys = keyColumns.map(col => quoteIdentifier(col, allowedColumns));
  const keyList = quotedKeys.join(", ");
  const notNullPredicate = quotedKeys.map(col => `${col} IS NOT NULL`).join(" AND ");
  return `SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(cnt - 1), 0) AS duplicate_rows FROM (SELECT ${keyList}, COUNT(*) AS cnt FROM ${qualified} WHERE ${notNullPredicate} GROUP BY ${keyList} HAVING COUNT(*) > 1) AS dup_check`;
}

export function buildSafeTokenQuerySql(
  schema: string,
  tableName: string,
  columnName: string,
  allowedTables: Set<string>,
  allowedColumns: Set<string>
): string {
  if (isSensitiveColumnName(columnName)) {
    throw new Error(`Refusing to sample values from sensitive column "${columnName}".`);
  }
  const qualified = quoteQualifiedTable(schema, tableName, allowedTables);
  const qCol = quoteIdentifier(columnName, allowedColumns);
  return `SELECT DISTINCT LOWER(TRIM(CAST(${qCol} AS TEXT))) AS token FROM ${qualified} WHERE ${qCol} IS NOT NULL AND LENGTH(TRIM(CAST(${qCol} AS TEXT))) BETWEEN 1 AND 40 ORDER BY token LIMIT ${LOW_CARDINALITY_TOKEN_LIMIT}`;
}

function chooseDuplicateKeyColumns(primaryKeys: string[], columns: ColumnProfile[]): { keyColumns: string[]; source: DuplicateCheckResult["source"] } {
  if (primaryKeys.length > 0) {
    return { keyColumns: primaryKeys, source: "primary_key" };
  }
  const idCandidate = columns.find(col =>
    col.supported
    && !col.isSensitive
    && (col.category === "identifier" || normalizeName(col.name) === "id" || normalizeName(col.name).endsWith("id"))
    && col.nonNullCount > 0
  );
  if (idCandidate) {
    return { keyColumns: [idCandidate.name], source: "detected_key" };
  }
  return { keyColumns: [], source: "none" };
}

function finalizeColumnCategory(column: ColumnProfile): ColumnProfile {
  if (!column.supported) return column;
  if (column.category === "text" && column.nonNullCount > 0 && column.distinctCount !== null) {
    const ratio = column.distinctCount / column.nonNullCount;
    if (column.distinctCount <= 25 && (column.nonNullCount <= 25 || ratio <= 0.35)) {
      return { ...column, category: "categorical" };
    }
  }
  return column;
}

function buildTableSummaryLists(columns: ColumnProfile[]) {
  return {
    dateColumns: columns.filter(c => c.category === "temporal").map(c => c.name),
    numericColumns: columns.filter(c => c.category === "numeric").map(c => c.name),
    textColumns: columns.filter(c => c.category === "text" || c.category === "identifier").map(c => c.name),
    categoricalColumns: columns.filter(c => c.category === "categorical").map(c => c.name),
    booleanColumns: columns.filter(c => c.category === "boolean").map(c => c.name),
    unsupportedColumns: columns.filter(c => !c.supported || c.category === "unsupported").map(c => c.name)
  };
}

export function createSessionQueryExecutor(session: Session): ReadOnlyQueryExecutor {
  return async (sql: string) => {
    if (session.mode === "oauth") {
      return runOAuthReadOnlyQuery(session, sql);
    }
    if (!session.dbUrl) {
      throw new Error("Database connection is missing.");
    }
    return queryPostgres(session.dbUrl, sql);
  };
}

export async function profileDatabaseWithExecutor(
  executor: ReadOnlyQueryExecutor,
  options: ProfileOptions = {}
): Promise<DatabaseProfile> {
  const now = options.now || new Date();
  const warnings: string[] = [];

  const schemaRows = await executor(SCHEMA_DISCOVERY_SQL);
  const rawColumnsByTable = new Map<string, RawSchemaColumn[]>();

  for (const row of schemaRows) {
    const tableName = typeof row.table_name === "string" ? row.table_name : "";
    const columnName = typeof row.column_name === "string" ? row.column_name : "";
    if (!tableName || !columnName) continue;
    const schema = typeof row.table_schema === "string" ? row.table_schema : "public";
    const tableType = row.table_type === "VIEW" ? "VIEW" : "BASE TABLE";
    const list = rawColumnsByTable.get(tableName) || [];
    list.push({
      schema,
      tableName,
      tableType,
      columnName,
      dataType: String(row.data_type || "unknown"),
      udtName: String(row.udt_name || ""),
      nullable: String(row.is_nullable || "YES").toUpperCase() !== "NO"
    });
    rawColumnsByTable.set(tableName, list);
  }

  const allDiscoveredTables = new Set(rawColumnsByTable.keys());
  const requestedTables = options.tableNames?.filter(name => allDiscoveredTables.has(name));
  const maxTables = Math.max(1, Math.min(options.maxTables || MAX_TABLES_TO_PROFILE, 50));
  const targetTableNames = (requestedTables && requestedTables.length > 0
    ? requestedTables
    : [...rawColumnsByTable.keys()]
  ).slice(0, maxTables);

  if (!requestedTables?.length && rawColumnsByTable.size > maxTables) {
    warnings.push(`Profiled the first ${maxTables} of ${rawColumnsByTable.size} discovered tables.`);
  }

  // Discover PKs & FKs
  const primaryKeysByTable = new Map<string, string[]>();
  const foreignKeysByTable = new Map<string, DatabaseRelation[]>();
  const allRelationships: DatabaseRelation[] = [];

  try {
    const constraintRows = await executor(CONSTRAINTS_DISCOVERY_SQL);
    for (const row of constraintRows) {
      const tableName = typeof row.table_name === "string" ? row.table_name : "";
      const columnName = typeof row.column_name === "string" ? row.column_name : "";
      const constraintType = String(row.constraint_type || "");
      if (!tableName || !columnName) continue;

      if (constraintType === "PRIMARY KEY") {
        const list = primaryKeysByTable.get(tableName) || [];
        if (!list.includes(columnName)) list.push(columnName);
        primaryKeysByTable.set(tableName, list);
      } else if (constraintType === "FOREIGN KEY") {
        const toTable = typeof row.foreign_table_name === "string" ? row.foreign_table_name : "";
        const toColumn = typeof row.foreign_column_name === "string" ? row.foreign_column_name : "";
        if (toTable && toColumn) {
          const relation: DatabaseRelation = {
            fromTable: tableName,
            fromColumn: columnName,
            toTable,
            toColumn,
            constraintName: typeof row.constraint_name === "string" ? row.constraint_name : undefined,
            inferred: false
          };
          const list = foreignKeysByTable.get(tableName) || [];
          list.push(relation);
          foreignKeysByTable.set(tableName, list);
          allRelationships.push(relation);
        }
      }
    }
  } catch {
    warnings.push("Primary/foreign key metadata could not be queried; continuing with column-level profiling.");
  }

  const profiledTables: TableProfile[] = [];

  for (const tableName of targetTableNames) {
    const rawCols = rawColumnsByTable.get(tableName) || [];
    if (!rawCols.length) continue;

    const schema = rawCols[0].schema;
    const tableType = rawCols[0].tableType;
    const allowedColumns = new Set(rawCols.map(c => c.columnName));
    const tableWarnings: string[] = [];
    const primaryKeys = primaryKeysByTable.get(tableName) || [];
    const foreignKeys = foreignKeysByTable.get(tableName) || [];
    const fkByColumn = new Map(foreignKeys.map(fk => [fk.fromColumn, fk]));

    // 1. Row count query
    let rowCount = 0;
    try {
      const countSql = `SELECT COUNT(*) AS row_count FROM ${quoteQualifiedTable(schema, tableName, allDiscoveredTables)}`;
      const countRows = await executor(countSql);
      rowCount = Math.max(0, Math.trunc(toNumber(countRows[0]?.row_count) || 0));
    } catch {
      tableWarnings.push(`Could not count rows in "${tableName}"; treating row count as 0.`);
    }

    const classifiedCols = rawCols.map(raw => {
      const classified = classifyPostgresDataType(raw.dataType, raw.udtName, raw.columnName);
      return {
        raw,
        ...classified,
        isSensitive: isSensitiveColumnName(raw.columnName)
      };
    });

    const columnProfiles: ColumnProfile[] = [];

    if (rowCount === 0) {
      // Empty table: preserve full schema metadata without unnecessary aggregate scans
      for (const item of classifiedCols) {
        const fk = fkByColumn.get(item.raw.columnName);
        columnProfiles.push({
          name: item.raw.columnName,
          rawDataType: item.raw.dataType,
          udtName: item.raw.udtName || undefined,
          category: item.category,
          supported: item.supported,
          nullable: item.raw.nullable,
          isPrimaryKey: primaryKeys.includes(item.raw.columnName),
          isForeignKey: Boolean(fk),
          references: fk ? { table: fk.toTable, column: fk.toColumn } : undefined,
          isSensitive: item.isSensitive,
          rowCount: 0,
          nonNullCount: 0,
          nullCount: 0,
          nullPercent: 0,
          distinctCount: 0,
          cardinalityRatio: null,
          numericStats: null,
          temporalStats: null,
          valueHints: {}
        });
      }
    } else {
      // 2. Batched aggregate profiling queries (never SELECT *)
      for (let offset = 0; offset < classifiedCols.length; offset += COLUMN_BATCH_SIZE) {
        const batch = classifiedCols.slice(offset, offset + COLUMN_BATCH_SIZE);
        let statsRow: Record<string, unknown> = {};

        try {
          const aggSql = buildColumnBatchAggregateSql(
            schema,
            tableName,
            batch.map(b => ({
              name: b.raw.columnName,
              category: b.category,
              supported: b.supported,
              rawDataType: b.raw.dataType,
              isIntegerType: b.isIntegerType
            })),
            allDiscoveredTables,
            allowedColumns
          );
          const rows = await executor(aggSql);
          statsRow = rows[0] || {};
        } catch {
          tableWarnings.push(`Aggregate statistics failed for a column batch in "${tableName}"; falling back to schema metadata for those columns.`);
        }

        batch.forEach((item, index) => {
          const prefix = `c${index}`;
          const nonNullCount = Math.max(0, Math.trunc(toNumber(statsRow[`${prefix}_non_null`]) ?? 0));
          const nullCount = Math.max(0, rowCount - nonNullCount);
          const nullPercent = rowCount > 0 ? roundTwo((nullCount / rowCount) * 100) : 0;
          const distinctCount = item.supported ? toNumber(statsRow[`${prefix}_distinct`]) : null;
          const cardinalityRatio = distinctCount !== null && nonNullCount > 0 ? roundTwo(distinctCount / nonNullCount) : null;

          let numericStats: NumericColumnStats | null = null;
          let temporalStats: TemporalColumnStats | null = null;
          const valueHints: ColumnProfile["valueHints"] = {};

          if (item.supported && item.category === "numeric") {
            const min = toNumber(statsRow[`${prefix}_min`]);
            const max = toNumber(statsRow[`${prefix}_max`]);
            const avg = toNumber(statsRow[`${prefix}_avg`]);
            const negativeCount = Math.max(0, Math.trunc(toNumber(statsRow[`${prefix}_neg`]) || 0));
            const zeroCount = Math.max(0, Math.trunc(toNumber(statsRow[`${prefix}_zero`]) || 0));
            const intOnlyRaw = statsRow[`${prefix}_int_only`];
            const isIntegerOnly = item.isIntegerType
              ? true
              : typeof intOnlyRaw === "boolean"
                ? intOnlyRaw
                : null;

            numericStats = {
              min,
              max,
              avg: avg !== null ? roundTwo(avg) : null,
              negativeCount,
              zeroCount,
              isIntegerOnly
            };
            if (min !== null && max !== null) {
              valueHints.isBetweenZeroAndFive = min >= 0 && max <= 5;
              valueHints.isBetweenZeroAndHundred = min >= 0 && max <= 100;
            }
          } else if (item.supported && item.category === "temporal") {
            const earliest = toIsoDate(statsRow[`${prefix}_min`]);
            const latest = toIsoDate(statsRow[`${prefix}_max`]);
            const spanDays = earliest && latest
              ? Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86_400_000))
              : null;
            const freshnessHours = latest
              ? roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000))
              : null;
            temporalStats = { earliest, latest, spanDays, freshnessHours };
          } else if (item.supported && item.category === "boolean") {
            const trueCount = toNumber(statsRow[`${prefix}_true_count`]);
            valueHints.booleanTrueRatio = trueCount !== null && nonNullCount > 0
              ? roundTwo(trueCount / nonNullCount)
              : null;
          }

          const fk = fkByColumn.get(item.raw.columnName);
          columnProfiles.push(finalizeColumnCategory({
            name: item.raw.columnName,
            rawDataType: item.raw.dataType,
            udtName: item.raw.udtName || undefined,
            category: item.category,
            supported: item.supported,
            nullable: item.raw.nullable,
            isPrimaryKey: primaryKeys.includes(item.raw.columnName),
            isForeignKey: Boolean(fk),
            references: fk ? { table: fk.toTable, column: fk.toColumn } : undefined,
            isSensitive: item.isSensitive,
            rowCount,
            nonNullCount,
            nullCount,
            nullPercent,
            distinctCount: distinctCount !== null ? Math.trunc(distinctCount) : null,
            cardinalityRatio,
            numericStats,
            temporalStats,
            valueHints
          }));
        });
      }

      // 2b. Reliable text-based date detection for date-like non-sensitive text/categorical columns
      const textDateCandidates = columnProfiles.filter(col =>
        col.supported
        && !col.isSensitive
        && (col.category === "text" || col.category === "categorical")
        && col.nonNullCount > 0
        && isDateLikeColumnName(col.name)
      ).slice(0, 6);

      for (const col of textDateCandidates) {
        try {
          const probeSql = buildTextDateProbeSql(schema, tableName, col.name, allDiscoveredTables, allowedColumns);
          const probeRows = await executor(probeSql);
          const probe = probeRows[0] || {};
          const nonEmpty = Math.max(0, Math.trunc(toNumber(probe.non_empty_count) ?? 0));
          const isoCount = Math.max(0, Math.trunc(toNumber(probe.iso_count) ?? 0));
          const ymdCount = Math.max(0, Math.trunc(toNumber(probe.ymd_slash_count) ?? 0));
          const ambiguousCount = Math.max(0, Math.trunc(toNumber(probe.ambiguous_count) ?? 0));
          const dmyProofCount = Math.max(0, Math.trunc(toNumber(probe.dmy_proof_count) ?? 0));
          const mdyProofCount = Math.max(0, Math.trunc(toNumber(probe.mdy_proof_count) ?? 0));

          if (nonEmpty > 0 && ambiguousCount > 0 && isoCount + ymdCount === 0) {
            const provenOrder = dmyProofCount > 0 && mdyProofCount === 0
              ? "dmy"
              : mdyProofCount > 0 && dmyProofCount === 0
                ? "mdy"
                : null;
            if (provenOrder && ambiguousCount / nonEmpty >= 0.7) {
              const rawMin = provenOrder === "dmy" ? probe.dmy_min : probe.mdy_min;
              const rawMax = provenOrder === "dmy" ? probe.dmy_max : probe.mdy_max;
              const earliest = toIsoDate(rawMin);
              const latest = toIsoDate(rawMax);
              if (earliest && latest) {
                const invalidDateCount = Math.max(0, nonEmpty - ambiguousCount);
                const spanDays = Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86_400_000));
                const freshnessHours = roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000));
                col.category = "temporal";
                col.temporalStats = {
                  earliest,
                  latest,
                  spanDays,
                  freshnessHours,
                  invalidDateCount,
                  ambiguousDateCount: 0,
                  inferredFromText: true,
                  detectedFormat: provenOrder
                };
                continue;
              }
            }
            col.temporalStats = {
              earliest: null,
              latest: null,
              spanDays: null,
              freshnessHours: null,
              invalidDateCount: Math.max(0, nonEmpty - ambiguousCount),
              ambiguousDateCount: ambiguousCount,
              inferredFromText: false,
              detectedFormat: "ambiguous_numeric"
            };
            tableWarnings.push(`Column "${col.name}" contains ${ambiguousCount} ambiguous numeric date value(s) (DD/MM/YYYY vs MM/DD/YYYY); date range cannot be inferred safely.`);
            continue;
          }

          if (nonEmpty > 0 && (isoCount + ymdCount) / nonEmpty >= 0.7 && ambiguousCount === 0) {
            const candidateMins = [probe.iso_min, probe.ymd_min].map(toIsoDate).filter((v): v is string => Boolean(v)).sort();
            const candidateMaxs = [probe.iso_max, probe.ymd_max].map(toIsoDate).filter((v): v is string => Boolean(v)).sort();
            const earliest = candidateMins[0] || null;
            const latest = candidateMaxs[candidateMaxs.length - 1] || null;

            if (earliest && latest) {
              const invalidDateCount = Math.max(0, nonEmpty - (isoCount + ymdCount));
              const spanDays = Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86_400_000));
              const freshnessHours = roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000));
              col.category = "temporal";
              col.temporalStats = {
                earliest,
                latest,
                spanDays,
                freshnessHours,
                invalidDateCount,
                ambiguousDateCount: 0,
                inferredFromText: true,
                detectedFormat: isoCount >= ymdCount ? "iso_date" : "ymd_slash"
              };
              if (invalidDateCount > 0) {
                tableWarnings.push(`Column "${col.name}" had ${invalidDateCount} unparseable value(s) excluded from date range calculation.`);
              }
              continue;
            }
          }

          // Fallback bounded distinct sample check (e.g. named-month dates like "15 Jan 2026" or invalid calendar check)
          const sampleSql = buildTextDateSampleSql(schema, tableName, col.name, allDiscoveredTables, allowedColumns);
          const sampleRows = await executor(sampleSql);
          const sampleValues = sampleRows.map(r => r.date_val);
          const sampleEval = evaluateTextDateSamples(sampleValues, now);
          if (sampleEval.temporalStats) {
            col.temporalStats = sampleEval.temporalStats;
          }
          if (sampleEval.isReliableDateColumn) {
            col.category = "temporal";
          }
          if (sampleEval.warning) {
            tableWarnings.push(`Column "${col.name}": ${sampleEval.warning}`);
          }
        } catch {
          // Non-fatal: keep column as text if database probe is unsupported by a mock/driver
        }
      }

      // 3. Safe low-cardinality status/category token hints (STRICTLY skips sensitive columns)
      const tokenCandidates = columnProfiles.filter(col =>
        col.supported
        && !col.isSensitive
        && (col.category === "categorical" || col.category === "text")
        && col.distinctCount !== null
        && col.distinctCount >= 1
        && col.distinctCount <= LOW_CARDINALITY_TOKEN_LIMIT
      ).slice(0, 6);

      for (const col of tokenCandidates) {
        try {
          const tokenSql = buildSafeTokenQuerySql(schema, tableName, col.name, allDiscoveredTables, allowedColumns);
          const tokenRows = await executor(tokenSql);
          const safeTokens = tokenRows
            .map(row => isSafeTokenValue(row.token))
            .filter((token): token is string => Boolean(token));
          if (safeTokens.length) {
            col.valueHints.safeLowCardinalityTokens = safeTokens;
          }
        } catch {
          // Non-fatal: token hints are optional
        }
      }
    }

    // 4. Duplicate indicator check using primary key or reliable detected key
    const dupKey = chooseDuplicateKeyColumns(primaryKeys, columnProfiles);
    let duplicates: DuplicateCheckResult = {
      keyColumns: dupKey.keyColumns,
      source: dupKey.source,
      duplicateRowCount: rowCount === 0 ? 0 : null,
      duplicateGroupCount: rowCount === 0 ? 0 : null,
      hasDuplicates: rowCount === 0 ? false : null
    };

    if (rowCount > 0 && dupKey.keyColumns.length > 0) {
      try {
        const dupSql = buildDuplicateCheckSql(schema, tableName, dupKey.keyColumns, allDiscoveredTables, allowedColumns);
        const dupRows = await executor(dupSql);
        const dupGroups = Math.max(0, Math.trunc(toNumber(dupRows[0]?.duplicate_groups) || 0));
        const dupRowCount = Math.max(0, Math.trunc(toNumber(dupRows[0]?.duplicate_rows) || 0));
        duplicates = {
          keyColumns: dupKey.keyColumns,
          source: dupKey.source,
          duplicateGroupCount: dupGroups,
          duplicateRowCount: dupRowCount,
          hasDuplicates: dupRowCount > 0
        };
      } catch {
        tableWarnings.push(`Duplicate check skipped for "${tableName}".`);
      }
    }

    const summaryLists = buildTableSummaryLists(columnProfiles);
    profiledTables.push({
      schema,
      name: tableName,
      tableType,
      rowCount,
      isEmpty: rowCount === 0,
      primaryKeys,
      foreignKeys,
      columns: columnProfiles,
      ...summaryLists,
      duplicates,
      freshness: computeFreshness(columnProfiles, rowCount, now),
      profiledAt: now.toISOString(),
      warnings: tableWarnings
    });
  }

  return analyzeDatabaseSemantics(profiledTables, allRelationships, {
    selectedDomain: options.selectedDomain,
    tableOverrides: options.tableOverrides,
    warnings
  });
}

export async function profileConnectedDatabase(
  session: Session,
  options: ProfileOptions = {}
): Promise<DatabaseProfile> {
  const executor = createSessionQueryExecutor(session);
  return profileDatabaseWithExecutor(executor, options);
}

export type InMemoryColumnSpec = {
  name: string;
  dataType: string;
  udtName?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
  references?: { table: string; column: string };
};

/**
 * Pure deterministic profiler for in-memory row snapshots (ideal for unit testing,
 * local fixtures, and validating semantics without exposing raw PII records).
 */
export function profileRowsSnapshot(
  tableMeta: {
    name: string;
    schema?: string;
    tableType?: "BASE TABLE" | "VIEW";
    columns: InMemoryColumnSpec[];
  },
  rows: Array<Record<string, unknown>>,
  options: { now?: Date } = {}
): TableProfile {
  const now = options.now || new Date();
  const rowCount = rows.length;
  const primaryKeys = tableMeta.columns.filter(c => c.isPrimaryKey).map(c => c.name);
  const foreignKeys: DatabaseRelation[] = tableMeta.columns
    .filter(c => c.references)
    .map(c => ({
      fromTable: tableMeta.name,
      fromColumn: c.name,
      toTable: c.references!.table,
      toColumn: c.references!.column,
      inferred: false
    }));

  const columns: ColumnProfile[] = tableMeta.columns.map(spec => {
    const classified = classifyPostgresDataType(spec.dataType, spec.udtName, spec.name);
    const isSensitive = isSensitiveColumnName(spec.name);
    const nonNullValues = rows
      .map(row => row[spec.name])
      .filter(v => v !== null && v !== undefined && v !== "");
    const nonNullCount = nonNullValues.length;
    const nullCount = rowCount - nonNullCount;
    const nullPercent = rowCount > 0 ? roundTwo((nullCount / rowCount) * 100) : 0;

    let distinctCount: number | null = null;
    let numericStats: NumericColumnStats | null = null;
    let temporalStats: TemporalColumnStats | null = null;
    const valueHints: ColumnProfile["valueHints"] = {};

    if (classified.supported) {
      const distinctSet = new Set(nonNullValues.map(v => String(v)));
      distinctCount = distinctSet.size;

      if (classified.category === "numeric") {
        const nums = nonNullValues.map(toNumber).filter((n): n is number => n !== null);
        if (nums.length) {
          const min = Math.min(...nums);
          const max = Math.max(...nums);
          const avg = roundTwo(nums.reduce((sum, n) => sum + n, 0) / nums.length);
          const negativeCount = nums.filter(n => n < 0).length;
          const zeroCount = nums.filter(n => n === 0).length;
          const isIntegerOnly = classified.isIntegerType || nums.every(n => Number.isInteger(n));
          numericStats = { min, max, avg, negativeCount, zeroCount, isIntegerOnly };
          valueHints.isBetweenZeroAndFive = min >= 0 && max <= 5;
          valueHints.isBetweenZeroAndHundred = min >= 0 && max <= 100;
        } else {
          numericStats = { min: null, max: null, avg: null, negativeCount: 0, zeroCount: 0, isIntegerOnly: null };
        }
      } else if (classified.category === "temporal") {
        let invalidCount = 0;
        let ambiguousCount = 0;
        const dates: string[] = [];
        for (const v of nonNullValues) {
          const parsed = parseReliableDateString(v);
          if (parsed.status === "valid") dates.push(parsed.iso);
          else if (parsed.status === "ambiguous") ambiguousCount += 1;
          else if (parsed.status === "invalid") invalidCount += 1;
        }
        dates.sort();
        if (dates.length && ambiguousCount === 0) {
          const earliest = dates[0];
          const latest = dates[dates.length - 1];
          const spanDays = Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86_400_000));
          const freshnessHours = roundTwo(Math.max(0, (now.getTime() - Date.parse(latest)) / 3_600_000));
          temporalStats = { earliest, latest, spanDays, freshnessHours, invalidDateCount: invalidCount, ambiguousDateCount: ambiguousCount };
        } else {
          temporalStats = { earliest: null, latest: null, spanDays: null, freshnessHours: null, invalidDateCount: invalidCount, ambiguousDateCount: ambiguousCount };
        }
      } else if (classified.category === "boolean") {
        const trueCount = nonNullValues.filter(v => v === true || String(v).toLowerCase() === "true").length;
        valueHints.booleanTrueRatio = nonNullCount > 0 ? roundTwo(trueCount / nonNullCount) : null;
      } else if (!isSensitive && (classified.category === "text" || classified.category === "categorical")) {
        // Reliable text-based date detection for date-like text columns (e.g. Sale_Date stored as TEXT)
        let promotedTemporal = false;
        if (nonNullCount > 0 && isDateLikeColumnName(spec.name)) {
          const evalResult = evaluateTextDateSamples(nonNullValues, now);
          if (evalResult.temporalStats) {
            temporalStats = evalResult.temporalStats;
          }
          if (evalResult.isReliableDateColumn) {
            promotedTemporal = true;
          }
        }
        if (promotedTemporal) {
          classified.category = "temporal";
        } else if (distinctCount <= LOW_CARDINALITY_TOKEN_LIMIT) {
          const safeTokens = [...new Set(
            nonNullValues.map(isSafeTokenValue).filter((t): t is string => Boolean(t))
          )].sort().slice(0, LOW_CARDINALITY_TOKEN_LIMIT);
          if (safeTokens.length) valueHints.safeLowCardinalityTokens = safeTokens;
        }
      }
    }

    return finalizeColumnCategory({
      name: spec.name,
      rawDataType: spec.dataType,
      udtName: spec.udtName,
      category: classified.category,
      supported: classified.supported,
      nullable: spec.nullable ?? true,
      isPrimaryKey: Boolean(spec.isPrimaryKey),
      isForeignKey: Boolean(spec.references),
      references: spec.references,
      isSensitive,
      rowCount,
      nonNullCount,
      nullCount,
      nullPercent,
      distinctCount,
      cardinalityRatio: distinctCount !== null && nonNullCount > 0 ? roundTwo(distinctCount / nonNullCount) : null,
      numericStats,
      temporalStats,
      valueHints
    });
  });

  const dupKey = chooseDuplicateKeyColumns(primaryKeys, columns);
  let duplicates: DuplicateCheckResult = {
    keyColumns: dupKey.keyColumns,
    source: dupKey.source,
    duplicateGroupCount: rowCount === 0 ? 0 : null,
    duplicateRowCount: rowCount === 0 ? 0 : null,
    hasDuplicates: rowCount === 0 ? false : null
  };

  if (rowCount > 0 && dupKey.keyColumns.length > 0) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const parts = dupKey.keyColumns.map(key => row[key]);
      if (parts.some(v => v === null || v === undefined || v === "")) continue;
      const composite = parts.map(String).join("\u0000");
      counts.set(composite, (counts.get(composite) || 0) + 1);
    }
    let duplicateGroupCount = 0;
    let duplicateRowCount = 0;
    for (const count of counts.values()) {
      if (count > 1) {
        duplicateGroupCount += 1;
        duplicateRowCount += count - 1;
      }
    }
    duplicates = {
      keyColumns: dupKey.keyColumns,
      source: dupKey.source,
      duplicateGroupCount,
      duplicateRowCount,
      hasDuplicates: duplicateRowCount > 0
    };
  }

  return {
    schema: tableMeta.schema || "public",
    name: tableMeta.name,
    tableType: tableMeta.tableType || "BASE TABLE",
    rowCount,
    isEmpty: rowCount === 0,
    primaryKeys,
    foreignKeys,
    columns,
    ...buildTableSummaryLists(columns),
    duplicates,
    freshness: computeFreshness(columns, rowCount, now),
    profiledAt: now.toISOString(),
    warnings: []
  };
}
