const CERTIFIED_PRE_SEND_FAILURES = new WeakSet();
const CERTIFIABLE_STAGES = new Set([
  "dns-resolution",
  "connection-refused",
  "tls-handshake"
]);
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * This error is a capability marker for a trusted transport adapter only.
 * Ordinary Workers fetch() exceptions are deliberately not converted to it:
 * the current public-fetch API does not expose a documented proof that an
 * outbound request was not delivered.
 */
export class CertifiedPreSendFailure extends Error {
  constructor(stage) {
    super("Provider connection failed before request delivery.");
    if (!CERTIFIABLE_STAGES.has(stage)) {
      throw new TypeError("Unsupported pre-send failure stage.");
    }
    this.name = "CertifiedPreSendFailure";
    this.stage = stage;
    this.delivery = "not-sent";
    CERTIFIED_PRE_SEND_FAILURES.add(this);
    Object.freeze(this);
  }
}

export function isCertifiedPreSendFailure(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") &&
    CERTIFIED_PRE_SEND_FAILURES.has(error) &&
    CERTIFIABLE_STAGES.has(error.stage) && error.delivery === "not-sent";
}

function providerOrigin(provider) {
  try {
    const url = new URL(provider?.baseUrl);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isValidCandidate(candidate) {
  const provider = candidate?.provider;
  return Boolean(
    provider &&
    typeof provider.id === "string" && provider.id.length > 0 &&
    typeof provider.billingGroup === "string" && provider.billingGroup.length > 0 &&
    typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.length > 0 &&
    providerOrigin(provider) &&
    typeof candidate.modelId === "string" && candidate.modelId.trim().length > 0 &&
    candidate.modelId.length <= 128
  );
}

function isDistinctBillingRoute(previous, next) {
  const previousProvider = previous?.provider;
  const nextProvider = next?.provider;
  if (!previousProvider || !nextProvider) return false;
  const previousOrigin = providerOrigin(previousProvider);
  const nextOrigin = providerOrigin(nextProvider);
  return Boolean(
    previousProvider.id !== nextProvider.id &&
    previousProvider.billingGroup !== nextProvider.billingGroup &&
    previousProvider.apiKeyEnv !== nextProvider.apiKeyEnv &&
    previousOrigin && nextOrigin && previousOrigin !== nextOrigin
  );
}

/**
 * Tries the primary and at most one explicitly configured alternate provider.
 * A non-2xx HTTP Response is still a response and is returned immediately;
 * only a branded, trusted pre-send failure can advance to the alternate.
 * Ambiguous network errors, timeouts, aborts, and all provider responses stop.
 */
export async function attemptProviderChain(candidates, invoke) {
  if (!Array.isArray(candidates) || candidates.length === 0 || typeof invoke !== "function") {
    throw new TypeError("Invalid provider attempt configuration.");
  }

  const chain = candidates.slice(0, MAX_PROVIDER_ATTEMPTS);
  let previousCandidate = null;
  let previousError = null;

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (!isValidCandidate(candidate)) {
      if (previousError) throw previousError;
      throw new TypeError("Invalid primary provider configuration.");
    }
    if (index > 0 && (!isCertifiedPreSendFailure(previousError) || !isDistinctBillingRoute(previousCandidate, candidate))) {
      throw previousError || new TypeError("Unsafe provider fallback configuration.");
    }

    try {
      const response = await invoke(candidate);
      return { ...candidate, response };
    } catch (error) {
      if (!isCertifiedPreSendFailure(error)) throw error;
      previousCandidate = candidate;
      previousError = error;
      if (index + 1 >= chain.length) throw error;
    }
  }

  throw previousError || new TypeError("No provider attempt completed.");
}
