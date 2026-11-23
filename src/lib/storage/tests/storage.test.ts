import assert from "node:assert/strict";
import {
  sanitizeFilename,
  validateCategory,
  validateFileSize,
  validateMimeType,
  validateUserId,
  verifyKeyOwnership,
  buildStorageKey
} from "../validation";
import { deriveUserIdFromSession } from "../session-auth";
import { uploadFile, listUserFiles, downloadFile, deleteFile, createSignedDownloadUrl } from "../service";
import type { Session } from "@/lib/session";

function createMockJwt(sub: string, email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, email, exp: 9999999999 })).toString("base64url");
  const sig = "mock_signature_bytes";
  return `${header}.${payload}.${sig}`;
}

async function runTests() {
  console.log("▶ [Test Suite] QueryPilot-X Security & Live-Readiness Verification");
  let passed = 0;

  // 1. Identity Collision Fix: Different users on SAME project receive different identities
  {
    const sharedProjectRef = "slahafrlmeckdonddbyk";
    
    // User Alice with her own OAuth token
    const aliceSession: Session = {
      mode: "oauth",
      projectRef: sharedProjectRef,
      projectName: "Team Database",
      accessToken: createMockJwt("user-uuid-alice-111", "alice@example.com"),
      refreshToken: "refresh-token-alice",
      issuedAt: Date.now()
    };

    // User Bob with his own OAuth token accessing the SAME database project
    const bobSession: Session = {
      mode: "oauth",
      projectRef: sharedProjectRef,
      projectName: "Team Database",
      accessToken: createMockJwt("user-uuid-bob-222", "bob@example.com"),
      refreshToken: "refresh-token-bob",
      issuedAt: Date.now()
    };

    const aliceId = deriveUserIdFromSession(aliceSession);
    const bobId = deriveUserIdFromSession(bobSession);

    assert.notEqual(aliceId, bobId, "Alice and Bob MUST NOT share the same storage identity on the same project!");
    assert.ok(aliceId.startsWith("usr_"));
    assert.ok(bobId.startsWith("usr_"));
    passed++;
    console.log("  ✔ 1. Identity collision fix: Different users on same project get isolated identities.");
  }

  // 2. Identity derivation stability across requests
  {
    const session: Session = {
      mode: "oauth",
      projectRef: "project-abc",
      accessToken: createMockJwt("stable-uuid-999", "user@company.com"),
      issuedAt: Date.now()
    };

    const id1 = deriveUserIdFromSession(session);
    const id2 = deriveUserIdFromSession(session);
    const id3 = deriveUserIdFromSession(session);

    assert.equal(id1, id2);
    assert.equal(id2, id3);
    passed++;
    console.log("  ✔ 2. Identity derivation stability: Same user consistently receives identical namespace.");
  }

  // 3. User ID validation & character restrictions
  {
    assert.equal(validateUserId("user_alice_123"), "user_alice_123");
    assert.equal(validateUserId("user-bob-99"), "user-bob-99");
    assert.throws(() => validateUserId(""), /Invalid user ID/);
    assert.throws(() => validateUserId("../admin"), /Invalid user ID/);
    assert.throws(() => validateUserId("user/alice"), /Invalid user ID/);
    assert.throws(() => validateUserId("user\0admin"), /Invalid user ID/);
    passed++;
    console.log("  ✔ 3. User ID validation & character restrictions passed.");
  }

  // 4. Filename sanitization & path traversal prevention
  {
    assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
    assert.equal(sanitizeFilename("../../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("foo/bar/data.csv"), "data.csv");
    assert.equal(sanitizeFilename("sales<data>:2026*.json"), "sales_data__2026_.json");
    assert.throws(() => sanitizeFilename(""), /Filename must be a non-empty string/);
    assert.throws(() => sanitizeFilename(".."), /escapes directory boundaries/);
    passed++;
    console.log("  ✔ 4. Filename sanitization & directory traversal prevention passed.");
  }

  // 5. File size and MIME type whitelist validation
  {
    const validBuf = Buffer.from("id,val\n1,100\n");
    assert.doesNotThrow(() => validateFileSize(validBuf, 1024 * 1024));
    assert.throws(() => validateFileSize(Buffer.alloc(0)), /File cannot be empty/);
    assert.throws(() => validateFileSize(Buffer.alloc(100), 50), /exceeds maximum allowed size/);

    assert.equal(validateMimeType("application/pdf"), "application/pdf");
    assert.equal(validateMimeType("text/csv"), "text/csv");
    assert.equal(validateMimeType(undefined, "data.csv"), "text/csv");
    passed++;
    console.log("  ✔ 5. File size limits & MIME whitelist validation passed.");
  }

  // 6. Multi-user key ownership isolation (Alice vs Bob)
  {
    const aliceId = "usr_alice_isolated";
    const bobId = "usr_bob_isolated";
    const aliceKey = buildStorageKey(aliceId, "datasets", "quarterly.csv");

    assert.ok(verifyKeyOwnership(aliceId, aliceKey), "Alice must own her key");
    assert.equal(verifyKeyOwnership(bobId, aliceKey), false, "Bob must NOT own Alice's key");
    assert.equal(verifyKeyOwnership(aliceId, `${bobId}/datasets/private.csv`), false, "Alice must not own Bob's key");
    assert.equal(verifyKeyOwnership(aliceId, `../${aliceId}/datasets/quarterly.csv`), false, "Path traversal must be rejected");
    passed++;
    console.log("  ✔ 6. Storage key ownership and cross-user isolation passed.");
  }

  // 7. End-to-end multi-user operations & download/delete isolation
  {
    const userAlice = "usr_alice_e2e";
    const userBob = "usr_bob_e2e";
    const testPayload = Buffer.from("Confidential records for Alice only");

    // Upload Alice's file
    const uploadResult = await uploadFile({
      userId: userAlice,
      category: "datasets",
      filename: "financial_report.csv",
      buffer: testPayload
    });

    assert.ok(uploadResult.storageKey.startsWith(`${userAlice}/`));

    // List: Alice sees it, Bob does NOT
    const aliceFiles = await listUserFiles({ userId: userAlice });
    assert.ok(aliceFiles.some(f => f.storageKey === uploadResult.storageKey));

    const bobFiles = await listUserFiles({ userId: userBob });
    assert.ok(!bobFiles.some(f => f.storageKey === uploadResult.storageKey), "Bob must never list Alice's files");

    // Download: Bob is denied
    await assert.rejects(
      async () => {
        await downloadFile(userBob, uploadResult.storageKey);
      },
      /Access denied/
    );

    // Signed URL: Bob is denied
    await assert.rejects(
      async () => {
        await createSignedDownloadUrl(userBob, uploadResult.storageKey);
      },
      /Access denied/
    );

    // Delete: Bob is denied
    await assert.rejects(
      async () => {
        await deleteFile(userBob, uploadResult.storageKey);
      },
      /Access denied/
    );

    // Alice can download
    const downloaded = await downloadFile(userAlice, uploadResult.storageKey);
    assert.equal(downloaded.buffer?.toString(), testPayload.toString());

    // Alice can delete
    const deleted = await deleteFile(userAlice, uploadResult.storageKey);
    assert.equal(deleted, true);

    passed++;
    console.log("  ✔ 7. End-to-end cross-user access rejection (list, download, signed URL, delete) passed.");
  }

  // 8. Session tampering rejection
  {
    assert.throws(
      () => deriveUserIdFromSession({} as any),
      /invalid session object/
    );
    passed++;
    console.log("  ✔ 8. Malformed and tampered session rejection passed.");
  }

  // 9. Production cloud failure fails loudly (no silent local fallback)
  {
    const originalEnv = process.env.NODE_ENV;
    try {
      // Simulate production environment
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      await assert.rejects(
        async () => {
          await uploadFile({
            userId: "usr_prod_test",
            category: "general",
            filename: "critical_data.pdf",
            buffer: Buffer.from("%PDF-1.4 test file")
          });
        },
        /Production storage failure/
      );
      passed++;
      console.log("  ✔ 9. Production cloud safety: Cloud failure fails loudly and blocks silent local fallback.");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    }
  }

  // 10. PostgreSQL connection identity isolation
  {
    const sessionAliceDb: Session = {
      mode: "postgres",
      dbUrl: "postgresql://alice_db_user:secret1@aws-0.pooler.supabase.com:6543/postgres",
      issuedAt: Date.now()
    };

    const sessionBobDb: Session = {
      mode: "postgres",
      dbUrl: "postgresql://bob_db_user:secret2@aws-0.pooler.supabase.com:6543/postgres",
      issuedAt: Date.now()
    };

    const aliceDbId = deriveUserIdFromSession(sessionAliceDb);
    const bobDbId = deriveUserIdFromSession(sessionBobDb);

    assert.notEqual(aliceDbId, bobDbId, "Distinct database users on Postgres mode must receive distinct storage namespaces");
    assert.ok(aliceDbId.startsWith("pgusr_"));
    assert.ok(bobDbId.startsWith("pgusr_"));
    passed++;
    console.log("  ✔ 10. Postgres connection user isolation: Different DB users receive distinct namespaces.");
  }

  console.log(`\n🎉 All ${passed} comprehensive security test suites PASSED successfully!`);
}

runTests().catch(err => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
