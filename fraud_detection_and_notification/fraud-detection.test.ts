
import { strict as assert } from "node:assert";
import { detectSuspiciousChanges } from "./fraudDetection";

const testChanges = [
  {
    id: "1",
    tableName: "sales",
    recordId: "101",
    columnName: "amount",
    oldValue: 1200,
    newValue: 600,
    changedBy: "admin",
    changedAt: new Date().toISOString(),
  },
  {
    id: "2",
    tableName: "sales",
    recordId: "102",
    columnName: "amount",
    oldValue: 1200,
    newValue: 1000,
    changedBy: "staff",
    changedAt: new Date().toISOString(),
  },
  {
    id: "3",
    tableName: "sales",
    recordId: "103",
    columnName: "amount",
    oldValue: 500,
    newValue: 900,
    changedBy: "staff",
    changedAt: new Date().toISOString(),
  },
  {
    id: "4",
    tableName: "sales",
    recordId: "104",
    columnName: "amount",
    oldValue: 1000,
    newValue: 200,
    changedBy: "unknown",
    changedAt: new Date().toISOString(),
  },
];

const alerts = detectSuspiciousChanges(testChanges);

assert.equal(alerts.length, 2);
assert.equal(alerts[0].percentDecrease, 50);
assert.equal(alerts[0].severity, "medium");
assert.equal(alerts[1].percentDecrease, 80);
assert.equal(alerts[1].severity, "high");

console.log("All fraud detection tests passed!");
