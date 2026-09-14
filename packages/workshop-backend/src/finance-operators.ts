/** Exact deployment-configured Finance identities, independent of managed administrator grants.
 * Only an omitted FINANCE_OPERATORS falls back to ADMINS; an explicit empty array grants none.
 * Both bindings accept a string array or its JSON encoding. No aliases or normalization apply.
 */
export function configuredFinanceOperators(env: Pick<Cloudflare.Env, "ADMINS" | "FINANCE_OPERATORS">): string[] {
  let value = env.FINANCE_OPERATORS === undefined ? env.ADMINS : env.FINANCE_OPERATORS;
  if (typeof value === "string") value = JSON.parse(value);
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new TypeError("Finance operators must be configured as an array of exact profile IDs.");
  }
  return value;
}

/** Admission only: changing configuration does not revoke already escaped workspace capabilities. */
export function isFinanceOperator(env: Pick<Cloudflare.Env, "ADMINS" | "FINANCE_OPERATORS">, profileId: string | undefined): boolean {
  return profileId !== undefined && configuredFinanceOperators(env).includes(profileId);
}
