import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChangeRisk } from "./risk-engine";

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
