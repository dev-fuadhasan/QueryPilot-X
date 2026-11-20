export type AuditChange = {
  id: string;
  tableName: string;
  recordId: string;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  changedAt: string;
  eventType?: "INSERT" | "UPDATE" | "DELETE" | string;
};

export type FraudAlert = AuditChange & {
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  percentDecrease: number;
};

export type DetectionOptions = {
  thresholdPercent?: number;
  checkDecreases?: boolean;
  checkIncreases?: boolean;
  checkDeletions?: boolean;
  checkSensitiveFields?: boolean;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function isSensitiveColumn(columnName: string): boolean {
  const name = columnName.toLowerCase();
  return [
    "amount",
    "price",
    "salary",
    "balance",
    "payment",
    "quantity",
    "discount",
    "status",
    "role",
    "permission",
    "account",
    "credit",
    "refund",
    "password",
    "token",
    "is_admin",
  ].some((keyword) => name.includes(keyword));
}

export function detectSuspiciousChanges(
  changes: AuditChange[],
  options: DetectionOptions = {}
): FraudAlert[] {
  const threshold = options.thresholdPercent ?? 50;
  const checkDecreases = options.checkDecreases ?? true;
  const checkIncreases = options.checkIncreases ?? false;
  const checkDeletions = options.checkDeletions ?? true;
  const checkSensitiveFields = options.checkSensitiveFields ?? false;

  if (threshold <= 0 || threshold > 100) {
    throw new Error("thresholdPercent must be between 0 and 100.");
  }

  return changes.flatMap((change): FraudAlert[] => {
    const eventType = (change.eventType ?? "UPDATE").toUpperCase();

    // 1. Deleted records
    if (eventType === "DELETE") {
      if (!checkDeletions) return [];
      return [
        {
          ...change,
          severity: "high",
          percentDecrease: 0,
          reason: `Record ${change.recordId} was deleted from ${change.tableName}.`,
        },
      ];
    }

    // Inserts are not treated as suspicious changes by default
    if (eventType === "INSERT") {
      return [];
    }

    const oldNumber = toNumber(change.oldValue);
    const newNumber = toNumber(change.newValue);
    const column = change.columnName.toLowerCase();
    const sensitive = isSensitiveColumn(column);

    // 2. Numeric decrease
    if (
      checkDecreases &&
      oldNumber !== null &&
      newNumber !== null &&
      oldNumber > 0 &&
      newNumber < oldNumber
    ) {
      const percentDecrease = ((oldNumber - newNumber) / oldNumber) * 100;
      if (percentDecrease >= threshold) {
        const severity = percentDecrease >= 70 ? "high" : "medium";
        return [
          {
            ...change,
            severity,
            percentDecrease: Number(percentDecrease.toFixed(2)),
            reason: `${change.columnName} decreased from ${oldNumber} to ${newNumber} (${percentDecrease.toFixed(2)}%).`,
          },
        ];
      }
      return [];
    }

    // 3. Numeric increase in sensitive column (optional / configurable)
    if (
      checkIncreases &&
      oldNumber !== null &&
      newNumber !== null &&
      oldNumber >= 0 &&
      newNumber > oldNumber &&
      sensitive
    ) {
      const percentIncrease =
        oldNumber === 0 ? 100 : ((newNumber - oldNumber) / oldNumber) * 100;

      if (percentIncrease >= threshold) {
        return [
          {
            ...change,
            severity: percentIncrease >= 100 ? "high" : "medium",
            percentDecrease: 0,
            reason: `${change.columnName} increased from ${oldNumber} to ${newNumber} (${percentIncrease.toFixed(2)}%).`,
          },
        ];
      }
      return [];
    }

    // 4. Sensitive field cleared
    if (
      checkSensitiveFields &&
      change.oldValue !== null &&
      change.newValue === null &&
      sensitive
    ) {
      return [
        {
          ...change,
          severity: "high",
          percentDecrease: 0,
          reason: `Sensitive field ${change.columnName} was cleared.`,
        },
      ];
    }

    // 5. Sensitive non-numeric field changed
    if (
      checkSensitiveFields &&
      oldNumber === null &&
      newNumber === null &&
      change.oldValue !== change.newValue &&
      sensitive
    ) {
      return [
        {
          ...change,
          severity: "medium",
          percentDecrease: 0,
          reason: `Sensitive field ${change.columnName} changed from "${String(change.oldValue)}" to "${String(change.newValue)}".`,
        },
      ];
    }

    return [];
  });
}
