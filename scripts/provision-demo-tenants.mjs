// Idempotently provisions clearly labeled demonstration tenants for thin
// downstream applications. Each tenant receives one active operator principal
// with the organization administrator role and one credential registered by
// digest: the plaintext operator token is generated and kept outside this
// service, so the API host never sees or logs it.
import { provisionFirstTenant, validateTenantInput } from "./bootstrap-tenant.mjs";

export const DEMO_CONFIRMATION = "PROVISION_DEMO_TENANTS";
export const DEMO_CREDENTIAL_NAME = "downstream-demo-operator";

export function parseDemoTenants(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("CAIAE_DEMO_TENANTS must be a JSON array");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error("CAIAE_DEMO_TENANTS must list between 1 and 10 tenants");
  }
  const slugs = new Set();
  const digests = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each demonstration tenant must be an object");
    }
    const tenant = validateTenantInput(entry);
    if (!tenant.slug.endsWith("-demo")) {
      throw new Error("Demonstration tenant slugs must end with -demo");
    }
    if (!/(demonstration|demo)/i.test(tenant.organizationName) ||
        !/fictional/i.test(tenant.organizationName)) {
      throw new Error("Demonstration organization names must say they are a fictional demonstration");
    }
    if (typeof entry.tokenPrefix !== "string" || !/^[a-f0-9]{10}$/.test(entry.tokenPrefix)) {
      throw new Error("tokenPrefix must be 10 lowercase hexadecimal characters");
    }
    if (typeof entry.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.tokenSha256)) {
      throw new Error("tokenSha256 must be a lowercase hexadecimal SHA-256 digest");
    }
    if (slugs.has(tenant.slug) || digests.has(entry.tokenSha256)) {
      throw new Error("Demonstration tenants must have distinct slugs and credentials");
    }
    slugs.add(tenant.slug);
    digests.add(entry.tokenSha256);
    return { ...tenant, tokenPrefix: entry.tokenPrefix, tokenSha256: entry.tokenSha256 };
  });
}

export async function provisionDemoTenants(pool, tenants, security) {
  const results = [];
  for (const tenant of tenants) {
    const { organizationId, principalId } = await provisionFirstTenant(pool, tenant);
    const { created } = await security.provisionDigestCredential({
      organizationId,
      principalId,
      tokenPrefix: tenant.tokenPrefix,
      tokenSha256: tenant.tokenSha256,
      credentialName: DEMO_CREDENTIAL_NAME,
    });
    results.push({ slug: tenant.slug, organizationId, principalId, credentialCreated: created });
  }
  return results;
}

export async function provisionDemoTenantsFromEnvironment(pool, env, log = console.log) {
  if (env.CAIAE_DEMO_TENANTS_CONFIRM !== DEMO_CONFIRMATION) {
    throw new Error(`Set CAIAE_DEMO_TENANTS_CONFIRM=${DEMO_CONFIRMATION} to provision demonstration tenants`);
  }
  const tenants = parseDemoTenants(env.CAIAE_DEMO_TENANTS ?? "");
  const { SecurityService } = await import("@caiae/security");
  const results = await provisionDemoTenants(pool, tenants, new SecurityService(pool));
  // Identifiers only; never credentials, digests or connection strings.
  for (const result of results) {
    log(JSON.stringify({ event: "caiae_demo_tenant.ready", ...result }));
  }
  return results;
}
