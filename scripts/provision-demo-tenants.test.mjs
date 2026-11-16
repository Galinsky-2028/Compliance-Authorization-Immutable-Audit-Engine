import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, runMigrations } from "@caiae/db";
import { SecurityService } from "@caiae/security";
import {
  DEMO_CONFIRMATION, parseDemoTenants, provisionDemoTenantsFromEnvironment,
} from "./provision-demo-tenants.mjs";

function credential() {
  const prefix = randomBytes(5).toString("hex");
  const token = `caiau_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, digest: createHash("sha256").update(token).digest("hex") };
}

function tenant(slug, cred) {
  return {
    slug, organizationName: "Example demonstration organization (fictional)",
    operatorName: "Example demo application", tokenPrefix: cred.prefix, tokenSha256: cred.digest,
  };
}

test("demonstration tenant configuration is labeled, distinct and digest-only", () => {
  const a = credential();
  const b = credential();
  assert.equal(parseDemoTenants(JSON.stringify([tenant("first-demo", a), tenant("second-demo", b)])).length, 2);
  for (const invalid of [
    "", "{}", "[]",
    JSON.stringify([tenant("production-office", a)]),
    JSON.stringify([{ ...tenant("first-demo", a), organizationName: "Real Agency" }]),
    JSON.stringify([{ ...tenant("first-demo", a), tokenSha256: a.token }]),
    JSON.stringify([{ ...tenant("first-demo", a), tokenPrefix: "XYZ" }]),
    JSON.stringify([tenant("first-demo", a), tenant("first-demo", b)]),
    JSON.stringify([tenant("first-demo", a), tenant("second-demo", a)]),
  ]) {
    assert.throws(() => parseDemoTenants(invalid), undefined, invalid);
  }
});

test("provisioning requires explicit confirmation", async () => {
  await assert.rejects(provisionDemoTenantsFromEnvironment(null, { CAIAE_DEMO_TENANTS: "[]" }), /CONFIRM/);
});

test("demonstration tenants authenticate with the externally held token and are idempotent", async () => {
  if (!process.env.DATABASE_URL) return;
  const pool = createPool();
  try {
    await runMigrations(pool);
    const cred = credential();
    const slug = "t" + randomUUID().slice(0, 8) + "-demo";
    const env = {
      CAIAE_DEMO_TENANTS_CONFIRM: DEMO_CONFIRMATION,
      CAIAE_DEMO_TENANTS: JSON.stringify([tenant(slug, cred)]),
    };
    const logged = [];
    const [first] = await provisionDemoTenantsFromEnvironment(pool, env, (line) => logged.push(line));
    assert.equal(first.credentialCreated, true);
    assert.ok(logged.every((line) => !line.includes(cred.token) && !line.includes(cred.digest)));

    const [second] = await provisionDemoTenantsFromEnvironment(pool, env, () => {});
    assert.equal(second.credentialCreated, false);
    assert.equal(second.organizationId, first.organizationId);
    assert.equal(second.principalId, first.principalId);

    const security = new SecurityService(pool);
    const auth = await security.authenticate(cred.token);
    assert.equal(auth.principal.organizationId, first.organizationId);
    assert.equal(auth.principal.id, first.principalId);
    await assert.rejects(security.authenticate(cred.token + "x"));

    const other = credential();
    await assert.rejects(security.provisionDigestCredential({
      organizationId: first.organizationId, principalId: first.principalId,
      tokenPrefix: other.prefix, tokenSha256: other.digest, credentialName: "downstream-demo-operator",
    }), /different or inactive/);
  } finally {
    await pool.end();
  }
});
