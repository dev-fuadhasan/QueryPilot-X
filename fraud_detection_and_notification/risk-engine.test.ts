import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChangeRisk, generateSafeSqlRollback } from "./risk-engine";

test("Risk Engine: assesses baseline low-risk mutation", () => {
  const result = evaluateChangeRisk("products", "description", "Red shoes", "Blue shoes");
  assert.equal(result.severity, "LOW");
  assert.ok(result.score < 30);
  assert.equal(result.factors.length, 0);
});

test("Risk Engine: flags privilege escalation as CRITICAL", () => {
  const result = evaluateChangeRisk("users", "role", "member", "admin");
  assert.equal(result.severity, "CRITICAL");
  assert.ok(result.score >= 75);
  const escalationFactor = result.factors.find(f => f.factor.includes("Privilege Escalation"));
  assert.ok(escalationFactor !== undefined);
});

test("Risk Engine: flags negative monetary value transition", () => {
  const result = evaluateChangeRisk("wallets", "balance", 500, -20);
  assert.equal(result.severity, "CRITICAL");
  assert.ok(result.factors.some(f => f.factor.includes("Negative Value Violation")));
});

test("Risk Engine: flags extreme numerical spike (>500%)", () => {
  const result = evaluateChangeRisk("orders", "amount", 100, 1200);
  assert.ok(result.score >= 50);
  assert.ok(result.factors.some(f => f.factor.includes("Extreme Magnitude Spike")));
});

test("Risk Engine: identifies sensitive credentials column", () => {
  const result = evaluateChangeRisk("users", "password_hash", "old_hash_val", "new_hash_val");
  assert.ok(result.score >= 50);
  assert.ok(result.factors.some(f => f.factor.includes("Sensitive Field")));
});

test("Risk Engine: applies fintech business profile strict fiscal rule", () => {
  const result = evaluateChangeRisk("accounts", "balance", 1000, 950, new Date(), "fintech");
  assert.ok(result.factors.some(f => f.factor.includes("Fintech Strict Fiscal Rule")));
});

test("Risk Engine: adjusts severity threshold with aggressive high sensitivity", () => {
  const normalResult = evaluateChangeRisk("orders", "discount", 10, 20, new Date(), "universal", "medium");
  const aggressiveResult = evaluateChangeRisk("orders", "discount", 10, 20, new Date(), "universal", "high");
  assert.ok(aggressiveResult.severity === "HIGH" || aggressiveResult.severity === "CRITICAL");
});

test("Rollback Engine: generates safe UPDATE rollback SQL for modified column", () => {
  const plan = generateSafeSqlRollback("users", "usr_100", "role", "member", "admin", "UPDATE", "id");
  assert.equal(plan.isDestructive, false);
  assert.ok(plan.sql.includes('UPDATE "users"'));
  assert.ok(plan.sql.includes('SET "role" = \'member\''));
  assert.ok(plan.sql.includes('WHERE "id" = \'usr_100\''));
});

test("Rollback Engine: generates safe DELETE rollback SQL for unauthorized insert", () => {
  const plan = generateSafeSqlRollback("wallets", "wlt_999", "New Record", null, { balance: 5000 }, "INSERT", "wallet_id");
  assert.equal(plan.isDestructive, true);
  assert.equal(plan.sql, 'DELETE FROM "wallets" WHERE "wallet_id" = \'wlt_999\';');
});
