import { strict as assert } from "node:assert";
import { BUSINESS_PROFILES, detectBestProfile } from "./business-profiles";
import {
  calculateSummary,
  exportAlertsToCSV,
  exportAlertsToJSON,
} from "./notification-service";
import type { UniversalAlert } from "./types";

console.log("Running Universal Fraud Detection Test Suite...");

// 1. Test Business Profile Detection
assert.equal(detectBestProfile(["orders", "products", "customers"]), "ecommerce");
assert.equal(detectBestProfile(["transfers", "wallets", "accounts"]), "fintech");
assert.equal(detectBestProfile(["users", "posts", "comments", "profiles"]), "social_platform");
assert.equal(detectBestProfile(["subscriptions", "invoices", "plans"]), "saas");
assert.equal(detectBestProfile(["random_table_xyz"]), "universal");
console.log("✓ Business profile classification passed!");

// 2. Test Business Profiles Configurations
assert.ok(BUSINESS_PROFILES.ecommerce.rules.includes("OUTLIER_AMOUNT"));
assert.ok(BUSINESS_PROFILES.social_platform.rules.includes("ROLE_ESCALATION"));
assert.ok(BUSINESS_PROFILES.fintech.rules.includes("VELOCITY_SPIKE"));
console.log("✓ Business profile configurations verified!");

// 3. Test Notification Summary & Export
const mockAlerts: UniversalAlert[] = [
  {
    id: "alert-1",
    ruleCategory: "OUTLIER_AMOUNT",
    title: "Abnormal Outlier",
    severity: "critical",
    tableName: "orders",
    recordId: "1001",
    columnName: "total_price",
    newValue: 95000,
    actor: "customer_42",
    timestamp: new Date().toISOString(),
    reason: "Value exceeds 4 standard deviations",
    recommendation: "Hold order for verification",
  },
  {
    id: "alert-2",
    ruleCategory: "DUPLICATE_TRANSACTION",
    title: "Duplicate Charge",
    severity: "high",
    tableName: "orders",
    recordId: "1002",
    columnName: "total_price",
    newValue: 450,
    actor: "customer_15",
    timestamp: new Date().toISOString(),
    reason: "Identical charge detected twice",
    recommendation: "Check duplicate billing",
  },
  {
    id: "alert-3",
    ruleCategory: "ROLE_ESCALATION",
    title: "Admin Privilege",
    severity: "medium",
    tableName: "users",
    recordId: "user_99",
    columnName: "role",
    newValue: "admin",
    actor: "user_99",
    timestamp: new Date().toISOString(),
    reason: "User granted admin role",
    recommendation: "Confirm authorization",
  },
];

const summary = calculateSummary(mockAlerts, ["orders", "users"], 1500, true, "querypilot_universal_audit_log");
assert.equal(summary.totalAlerts, 3);
assert.equal(summary.criticalCount, 1);
assert.equal(summary.highCount, 1);
assert.equal(summary.mediumCount, 1);
assert.equal(summary.lowCount, 0);
assert.equal(summary.hasAuditTable, true);
console.log("✓ Alert summary calculation passed!");

// 4. Test Export Formatting
const csv = exportAlertsToCSV(mockAlerts);
assert.ok(csv.includes("Alert ID"));
assert.ok(csv.includes("alert-1"));
assert.ok(csv.includes("CRITICAL"));
assert.ok(csv.includes("orders"));

const jsonStr = exportAlertsToJSON(mockAlerts);
const parsed = JSON.parse(jsonStr);
assert.equal(parsed.totalAlerts, 3);
assert.equal(parsed.alerts.length, 3);
console.log("✓ CSV and JSON report exports passed!");

console.log("All Universal Fraud Detection Tests passed successfully!");
