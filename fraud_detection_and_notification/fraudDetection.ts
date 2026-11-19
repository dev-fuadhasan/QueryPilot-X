
export type AuditChange = {
  id: string;
  tableName: string;
  recordId: string;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  changedAt: string;
};

export type FraudAlert = AuditChange & {
  severity: "medium" | "high";
  reason: string;
  percentDecrease: number;
};

type DetectionOptions = {
  thresholdPercent?: number;
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

export function detectSuspiciousChanges(
  changes: AuditChange[],
  options: DetectionOptions = {}
): FraudAlert[] {
  const threshold = options.thresholdPercent ?? 50;

  if (threshold <= 0 || threshold > 100) {
    throw new Error("thresholdPercent must be between 0 and 100.");
  }

  return changes.flatMap((change): FraudAlert[] => {
    const oldNumber = toNumber(change.oldValue);
    const newNumber = toNumber(change.newValue);

    // Only detect numeric decreases from a positive old value.
    if (
      oldNumber === null ||
      newNumber === null ||
      oldNumber <= 0 ||
      newNumber >= oldNumber
    ) {
      return [];
    }

    const percentDecrease =
      ((oldNumber - newNumber) / oldNumber) * 100;

    if (percentDecrease < threshold) {
      return [];
    }

    const severity =
      percentDecrease >= 70 ? "high" : "medium";

    return [
      {
        ...change,
        severity,
        percentDecrease: Number(percentDecrease.toFixed(2)),
        reason: `${change.columnName} decreased from ${oldNumber} to ${newNumber} (${percentDecrease.toFixed(2)}%).`,
      },
    ];
  });
}
