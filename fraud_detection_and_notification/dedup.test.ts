import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateStableChangeHash } from "./notification-service";

describe("Change Notification Deduplication Test Suite", () => {
  it("generates deterministic stable change hashes for identical transitions", () => {
    const hash1 = generateStableChangeHash("sales", "101", "amount", 500, 1000);
    const hash2 = generateStableChangeHash("sales", "101", "amount", 500, 1000);
    const hash3 = generateStableChangeHash("sales", "101", "amount", "500", "1000");

    assert.equal(hash1, hash2, "Identical transitions must generate identical hashes");
    assert.equal(hash1, hash3, "Numeric and string representations must normalize to identical hashes");
  });

  it("generates different hashes for different transitions", () => {
    const hashA = generateStableChangeHash("sales", "101", "amount", 500, 1000);
    const hashB = generateStableChangeHash("sales", "101", "amount", 1000, 1500);
    const hashC = generateStableChangeHash("sales", "102", "amount", 500, 1000);

    assert.notEqual(hashA, hashB, "Subsequent value change must produce a distinct hash");
    assert.notEqual(hashA, hashC, "Different records must produce distinct hashes");
  });

  it("prevents repeated polling cycles from multiplying notifications", () => {
    const history: Array<{ id: string; changeHash: string; tableName: string; recordId: string; columnName: string; oldValue: unknown; newValue: unknown }> = [];
    const seenHashes = new Set<string>();

    function processDiff(tableName: string, recordId: string, columnName: string, oldVal: unknown, newVal: unknown) {
      if (oldVal === newVal) return null;
      const hash = generateStableChangeHash(tableName, recordId, columnName, oldVal, newVal);
      const id = `diff_${tableName}_${recordId}_${columnName}_${hash}`;

      if (seenHashes.has(hash)) {
        return null; // Idempotent suppression
      }

      seenHashes.add(hash);
      const item = { id, changeHash: hash, tableName, recordId, columnName, oldValue: oldVal, newValue: newVal };
      history.push(item);
      return item;
    }

    // Cycle 1: Database value changed from 500 to 1000
    const firstDetect = processDiff("sales", "1", "amount", 500, 1000);
    assert.ok(firstDetect, "First change must be detected");
    assert.equal(history.length, 1);

    // Cycles 2 through 100: Polling runs 100 times with same current state
    for (let cycle = 2; cycle <= 100; cycle++) {
      const duplicateDetect = processDiff("sales", "1", "amount", 500, 1000);
      assert.equal(duplicateDetect, null, `Cycle ${cycle} must NOT generate duplicate notification`);
    }

    assert.equal(history.length, 1, "Exactly 1 notification must exist after 100 polling cycles!");

    // Genuinely new change: Value changed from 1000 to 2500
    const secondChange = processDiff("sales", "1", "amount", 1000, 2500);
    assert.ok(secondChange, "Genuinely new change must be accepted");
    assert.equal(history.length, 2, "Exactly 2 notifications must exist for 2 distinct changes");
  });
});
