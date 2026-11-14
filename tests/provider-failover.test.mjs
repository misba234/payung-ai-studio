import assert from "node:assert/strict";
import {
  attemptProviderChain,
  CertifiedPreSendFailure,
  isCertifiedPreSendFailure
} from "../provider-failover.js";

const primary = {
  provider: {
    id: "provider-primary",
    billingGroup: "billing-primary",
    apiKeyEnv: "PRIMARY_API_KEY",
    baseUrl: "https://primary.example/v1"
  },
  modelId: "primary-model"
};
const alternate = {
  provider: {
    id: "provider-alternate",
    billingGroup: "billing-alternate",
    apiKeyEnv: "ALTERNATE_API_KEY",
    baseUrl: "https://alternate.example/v1"
  },
  modelId: "alternate-model"
};
const third = {
  provider: {
    id: "provider-third",
    billingGroup: "billing-third",
    apiKeyEnv: "THIRD_API_KEY",
    baseUrl: "https://third.example/v1"
  },
  modelId: "third-model"
};

async function rejectsSameError(promise, expected) {
  await assert.rejects(promise, error => error === expected);
}

async function testCertifiedPreSendFailuresMayUseOneAlternate() {
  for (const stage of ["dns-resolution", "connection-refused", "tls-handshake"]) {
    const calls = [];
    const result = await attemptProviderChain([primary, alternate], async candidate => {
      calls.push(candidate.provider.id);
      if (candidate.provider.id === primary.provider.id) throw new CertifiedPreSendFailure(stage);
      return new Response("alternate response", { status: 200 });
    });
    assert.deepEqual(calls, ["provider-primary", "provider-alternate"]);
    assert.equal(result.provider.id, "provider-alternate");
    assert.equal(result.modelId, "alternate-model");
    assert.equal(result.response.status, 200);
  }
}

async function testOnlyBrandedErrorsAreCertified() {
  assert.equal(isCertifiedPreSendFailure(new CertifiedPreSendFailure("dns-resolution")), true);
  assert.equal(isCertifiedPreSendFailure({
    name: "CertifiedPreSendFailure",
    stage: "dns-resolution",
    delivery: "not-sent"
  }), false);
  assert.throws(() => new CertifiedPreSendFailure("quota-exhausted"), TypeError);
}

async function testAmbiguousNetworkErrorsNeverFailOver() {
  const fakeDns = Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" });
  const fakeRefused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  const fakeTls = Object.assign(new Error("TLS handshake failed"), { code: "ERR_TLS_HANDSHAKE_FAILURE" });
  const resetAfterWrite = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  const abort = new Error("request aborted");
  abort.name = "AbortError";
  const timeout = Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" });
  const lookalike = Object.assign(new Error("uncertified"), {
    name: "CertifiedPreSendFailure",
    stage: "dns-resolution",
    delivery: "not-sent"
  });

  for (const expected of [new TypeError("fetch failed"), fakeDns, fakeRefused, fakeTls, resetAfterWrite, abort, timeout, lookalike]) {
    const calls = [];
    await rejectsSameError(attemptProviderChain([primary, alternate], async candidate => {
      calls.push(candidate.provider.id);
      throw expected;
    }), expected);
    assert.deepEqual(calls, ["provider-primary"]);
  }
}

async function testEveryHttpResponseStopsWithoutFailover() {
  for (const status of [400, 401, 402, 403, 404, 408, 429, 500, 502, 503]) {
    const calls = [];
    const result = await attemptProviderChain([primary, alternate], async candidate => {
      calls.push(candidate.provider.id);
      return new Response("provider response", { status });
    });
    assert.deepEqual(calls, ["provider-primary"], `HTTP ${status} must not trigger fallback`);
    assert.equal(result.response.status, status);
  }
}

async function testQuotaAndBillingResponsesAreNotRetried() {
  for (const status of [402, 429]) {
    const calls = [];
    const result = await attemptProviderChain([primary, alternate], async candidate => {
      calls.push(candidate.provider.id);
      return new Response(JSON.stringify({ error: { code: status === 402 ? "insufficient_funds" : "rate_limit_exceeded" } }), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    });
    assert.deepEqual(calls, ["provider-primary"]);
    assert.equal(result.response.status, status);
  }
}

async function testSameBillingGroupCannotBeUsedForKeyRotation() {
  const sameAccount = {
    provider: {
      ...alternate.provider,
      billingGroup: primary.provider.billingGroup
    },
    modelId: "other-key-model"
  };
  const error = new CertifiedPreSendFailure("connection-refused");
  const calls = [];
  await rejectsSameError(attemptProviderChain([primary, sameAccount], async candidate => {
    calls.push(candidate.provider.id);
    throw error;
  }), error);
  assert.deepEqual(calls, ["provider-primary"]);
}

async function testSameKeyBindingOrOriginCannotBeUsedForRotation() {
  const sameKey = {
    provider: { ...alternate.provider, apiKeyEnv: primary.provider.apiKeyEnv },
    modelId: "other-model"
  };
  const sameOrigin = {
    provider: { ...alternate.provider, baseUrl: primary.provider.baseUrl },
    modelId: "other-model"
  };

  for (const forbidden of [sameKey, sameOrigin]) {
    const error = new CertifiedPreSendFailure("dns-resolution");
    const calls = [];
    await rejectsSameError(attemptProviderChain([primary, forbidden], async candidate => {
      calls.push(candidate.provider.id);
      throw error;
    }), error);
    assert.deepEqual(calls, ["provider-primary"]);
  }
}

async function testNoConfiguredAlternateMeansNoRetry() {
  const error = new CertifiedPreSendFailure("tls-handshake");
  const calls = [];
  await rejectsSameError(attemptProviderChain([primary], async candidate => {
    calls.push(candidate.provider.id);
    throw error;
  }), error);
  assert.deepEqual(calls, ["provider-primary"]);
}

async function testNeverAttemptsMoreThanOneAlternate() {
  const primaryError = new CertifiedPreSendFailure("dns-resolution");
  const alternateError = new CertifiedPreSendFailure("connection-refused");
  const calls = [];
  await rejectsSameError(attemptProviderChain([primary, alternate, third], async candidate => {
    calls.push(candidate.provider.id);
    if (candidate.provider.id === "provider-primary") throw primaryError;
    throw alternateError;
  }), alternateError);
  assert.deepEqual(calls, ["provider-primary", "provider-alternate"]);
}

const tests = [
  testCertifiedPreSendFailuresMayUseOneAlternate,
  testOnlyBrandedErrorsAreCertified,
  testAmbiguousNetworkErrorsNeverFailOver,
  testEveryHttpResponseStopsWithoutFailover,
  testQuotaAndBillingResponsesAreNotRetried,
  testSameBillingGroupCannotBeUsedForKeyRotation,
  testSameKeyBindingOrOriginCannotBeUsedForRotation,
  testNoConfiguredAlternateMeansNoRetry,
  testNeverAttemptsMoreThanOneAlternate
];

for (const test of tests) {
  await test();
  console.log("PASS " + test.name);
}
console.log(`Passed ${tests.length} failover policy tests; no provider network requests were made.`);
