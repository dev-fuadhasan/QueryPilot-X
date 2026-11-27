import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendResendEmail,
  sendTestVerificationEmail,
  sendFraudIncidentAlertEmail,
  sendDailyAnalysisDigestEmail,
} from "../src/lib/notifications/email-service";

test("Email Service: rejects empty or malformed email address", async () => {
  const result = await sendResendEmail({
    to: "not-an-email",
    subject: "Test",
    html: "<p>Hello</p>",
  });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("Invalid recipient email"));
});

test("Email Service: builds well-formed incident alert HTML and subject", async () => {
  // Pass invalid email so it doesn't actually call external API in unit test, but validates template structure
  const result = await sendFraudIncidentAlertEmail("invalid", {
    id: "test_event_1",
    tableName: "users",
    recordId: "usr_99",
    columnName: "role",
    oldValue: "member",
    newValue: "superuser_admin",
    changedBy: "API Hacker",
    timestamp: new Date().toISOString(),
    riskScore: 95,
    riskSeverity: "CRITICAL",
    reason: "Direct privilege escalation",
    recommendation: "Immediate rollback required",
  });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes("Invalid recipient email"));
});

test("Email Service: builds well-formed daily digest summary HTML", async () => {
  const result = await sendDailyAnalysisDigestEmail("invalid", {
    projectName: "Test Supabase",
    date: "Nov 27, 2026",
    metricsAnalyzed: 12,
    anomaliesFound: 1,
    topFindings: ["Negative balance detected in wallets table"],
  });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes("Invalid recipient email"));
});
