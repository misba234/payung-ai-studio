import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CertifiedPreSendFailure } from "../provider-failover.js";

const workerModule = await import(new URL("../worker.js", import.meta.url).href);
const worker = workerModule.default;
const origin = "https://misba234.github.io";
const user = { id: "user-test-001", email: "admin@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const settings = { active_provider: "codecraft", model_id: "deepseek-v4-flash-0731", updated_at: "2026-11-14T00:00:00Z" };
const workerEnv = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only",
  PAYUNG_ADMIN_EMAIL: "admin@example.test"
};
const previousFetch = globalThis.fetch;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function request(path, { method = "GET", body, headers = {}, rawBody } = {}) {
  const requestHeaders = new Headers({ Origin: origin, ...headers });
  const content = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body));
  if (method !== "GET" && method !== "HEAD" && content !== undefined && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }
  return new Request("https://payung-ai-studio.misbaahmed17.workers.dev" + path, {
    method,
    headers: requestHeaders,
    body: content
  });
}

function installMockFetch({
  authUser = user,
  authStatus = 200,
  providerSettings = settings,
  reservation = { reservation_id: 7, credits_remaining: 4, duplicate: false, status: "reserved" },
  reserveStatus = 200,
  tokenBudgetReservation = {
    allowed: true, duplicate: false, reservation_id: 31, token_limit: 500000,
    used_tokens: 0, reserved_tokens: 24000, remaining_tokens: 476000, blocked: false
  },
  tokenBudgetReserveStatus = 200,
  tokenBudgetSettlement = {
    settled: true, duplicate: false, status: "settled", accounted_tokens: 20,
    overrun: false, token_limit: 500000, used_tokens: 20, reserved_tokens: 0,
    remaining_tokens: 499980, blocked: false
  },
  tokenBudgetSettleStatus = 200,
  providerBlockResult = null,
  providerBlockStatus = 200,
  completion = { choices: [{ message: { content: "Output AI mock lokal." } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
  providerStatus = 200,
  providerThrow = false,
  providerError = null,
  providerHang = false,
  finalizeValue = true,
  finalizeStatus = 200
} = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: url.toString(), method, headers, body });

    if (url.pathname === "/auth/v1/user") {
      assert.equal(headers.get("apikey"), "sb_publishable_3T4cxk_Yxvke5vsZU_g2pA_VlNO8gjD");
      assert.equal(headers.get("Authorization"), "Bearer local-test-session");
      return jsonResponse(authUser, authStatus);
    }
    if (url.pathname === "/rest/v1/ai_provider_settings" && method === "GET") return jsonResponse([providerSettings]);
    if (url.pathname === "/rest/v1/ai_provider_settings" && method === "PATCH") return jsonResponse([{ ...providerSettings, ...body }]);
    if (url.pathname === "/rest/v1/rpc/consume_ai_credit_idempotent") return jsonResponse(reservation, reserveStatus);
    if (url.pathname === "/rest/v1/rpc/reserve_ai_provider_tokens") return jsonResponse(tokenBudgetReservation, tokenBudgetReserveStatus);
    if (url.pathname === "/rest/v1/rpc/settle_ai_provider_tokens") {
      const settlementResult = tokenBudgetSettlement && Object.hasOwn(tokenBudgetSettlement, "provider")
        ? tokenBudgetSettlement
        : { ...tokenBudgetSettlement, provider: providerSettings.active_provider };
      return jsonResponse(settlementResult, tokenBudgetSettleStatus);
    }
    if (url.pathname === "/rest/v1/rpc/block_ai_provider_tokens") {
      return jsonResponse(providerBlockResult || {
        blocked: true, blocked_reason: body.p_block_reason, provider: body.p_provider
      }, providerBlockStatus);
    }
    if (url.pathname === "/rest/v1/rpc/refund_ai_credit") return jsonResponse(true);
    if (url.pathname === "/rest/v1/rpc/finalize_ai_credit") return jsonResponse(finalizeValue, finalizeStatus);
    if (url.pathname === "/v1/chat/completions") {
      if (providerThrow) throw providerError || new Error("mock provider network failure");
      if (providerHang) {
        return await new Promise((resolve, reject) => {
          const signal = init.signal;
          const onAbort = () => reject(new Error("mock provider aborted"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return jsonResponse(completion, providerStatus);
    }
    if (url.hostname === "generativelanguage.googleapis.com" && url.pathname.endsWith(":generateContent")) {
      if (providerThrow) throw providerError || new Error("mock provider network failure");
      if (providerHang) {
        return await new Promise((resolve, reject) => {
          const signal = init.signal;
          const onAbort = () => reject(new Error("mock provider aborted"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return jsonResponse(completion, providerStatus);
    }
    throw new Error("Unexpected network request in local mock test: " + url.origin + url.pathname);
  };
  return calls;
}

const bearer = { Authorization: "Bearer local-test-session" };
const generationBody = { action: "storyboard", prompt: "Prompt test lokal, bukan data produksi." };
const idempotency = { "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000" };

async function testAdminOnlyAndNoSecretReturned() {
  const localKey = "local-test-only-key-not-real";
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", { headers: bearer }), { ...workerEnv, CODECRAFT_API_KEY: localKey });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.is_admin, true);
  assert.equal(data.active_provider, "codecraft");
  assert.equal(data.providers[0].base_url, "https://codecraftapi.com/v1");
  assert.equal(data.providers[0].api_key_configured, true);
  assert.equal(JSON.stringify(data).includes(localKey), false);
  assert.equal(JSON.stringify(data).includes("CODECRAFT_API_KEY"), false);
  const gemini = data.providers.find(provider => provider.id === "gemini");
  assert.equal(gemini.label, "Google Gemini");
  assert.equal(gemini.api_key_configured, false);
  assert.equal(JSON.stringify(data).includes("GEMINI_API_KEY"), false);
  assert.equal(calls.some(call => call.url.startsWith("https://codecraftapi.com/")), false);
}

async function testMissingBearerIsRejectedWithoutAuthRequest() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings"), workerEnv);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
}

async function testInvalidSupabaseSessionIsRejected() {
  const calls = installMockFetch({ authStatus: 401 });
  const response = await worker.fetch(request("/admin/provider-settings", { headers: bearer }), workerEnv);
  assert.equal(response.status, 401);
  assert.equal(calls.filter(call => call.url.includes("/rest/v1/ai_provider_settings")).length, 0);
}

async function testUnconfirmedAndNonAdminUsersAreRejected() {
  for (const authUser of [
    { ...user, email: "not-admin@example.com" },
    { ...user, email_confirmed_at: null }
  ]) {
    const calls = installMockFetch({ authUser });
    const response = await worker.fetch(request("/admin/provider-settings", { headers: bearer }), workerEnv);
    assert.equal(response.status, 403);
    assert.equal(calls.filter(call => call.url.includes("/rest/v1/ai_provider_settings")).length, 0);
  }
}

async function testAdminSecretMissingFailsClosed() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", { headers: bearer }), { SUPABASE_SERVICE_ROLE_KEY: workerEnv.SUPABASE_SERVICE_ROLE_KEY });
  assert.equal(response.status, 503);
  assert.equal(calls.filter(call => call.url.includes("/rest/v1/ai_provider_settings")).length, 0);
}

async function testAdminCanSaveOnlyProviderAndModel() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", {
    method: "POST", headers: bearer, body: { active_provider: "codecraft", model_id: "deepseek-v4-flash-0731" }
  }), workerEnv);
  const data = await response.json();
  const update = calls.find(call => call.url.includes("/rest/v1/ai_provider_settings") && call.method === "PATCH");
  assert.equal(response.status, 200);
  assert.equal(data.active_provider, "codecraft");
  assert.equal(data.model_id, "deepseek-v4-flash-0731");
  assert.deepEqual(Object.keys(update.body).sort(), ["active_provider", "model_id", "updated_at", "updated_by"].sort());
  assert.equal(calls.some(call => call.url.startsWith("https://codecraftapi.com/")), false);
}

async function testAdminCanSelectGeminiWithoutGeneration() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", {
    method: "POST", headers: bearer, body: { active_provider: "gemini", model_id: "gemini-3.8-flash" }
  }), workerEnv);
  const data = await response.json();
  const update = calls.find(call => call.url.includes("/rest/v1/ai_provider_settings") && call.method === "PATCH");
  assert.equal(response.status, 200);
  assert.equal(data.active_provider, "gemini");
  assert.equal(data.model_id, "gemini-3.8-flash");
  assert.equal(update.body.active_provider, "gemini");
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
}

async function testUnknownProviderAndInvalidModelAreRejected() {
  for (const body of [
    { active_provider: "arbitrary-url", model_id: "model-test" },
    { active_provider: "codecraft", model_id: "bad model id" }
  ]) {
    const calls = installMockFetch();
    const response = await worker.fetch(request("/admin/provider-settings", { method: "POST", headers: bearer, body }), workerEnv);
    assert.equal(response.status, 400);
    assert.equal(calls.some(call => call.method === "PATCH"), false);
  }
}

async function testInvalidOriginIsRejected() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", { headers: { ...bearer, Origin: "https://evil.example" } }), workerEnv);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
}

async function testOversizedGenerationBodyIsRejectedBeforeAuth() {
  const calls = installMockFetch();
  const body = JSON.stringify({ action: "storyboard", prompt: "x".repeat(25000) });
  const response = await worker.fetch(request("/generate", { method: "POST", headers: { ...bearer, ...idempotency }, rawBody: body }), workerEnv);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
}

async function testMissingKeyDoesNotReserveCreditOrCallProvider() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), workerEnv);
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.match(data.error, /API key provider belum dipasang/);
  assert.equal(calls.some(call => call.url.includes("consume_ai_credit_idempotent")), false);
  assert.equal(calls.some(call => call.url.includes("reserve_ai_provider_tokens")), false);
  assert.equal(calls.some(call => call.url.startsWith("https://codecraftapi.com/")), false);
}

async function testCodeCraftOpenAICompatibleAdapter() {
  const calls = installMockFetch();
  const localKey = "local-test-key-not-real";
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: localKey });
  const data = await response.json();
  const providerCall = calls.find(call => call.url === "https://codecraftapi.com/v1/chat/completions");
  assert.equal(response.status, 200);
  assert.equal(data.output, "Output AI mock lokal.");
  assert.equal(data.provider, "codecraft");
  assert.equal(data.model, "deepseek-v4-flash-0731");
  assert.equal(data.credit_finalized, true);
  assert.equal(data.token_budget_finalized, true);
  assert.equal(providerCall.headers.get("Authorization"), "Bearer " + localKey);
  assert.equal(providerCall.body.model, "deepseek-v4-flash-0731");
  assert.equal(providerCall.body.max_tokens, 6000);
  assert.deepEqual(providerCall.body.messages, [{ role: "user", content: generationBody.prompt }]);
  const tokenReserveCall = calls.find(call => call.url.includes("reserve_ai_provider_tokens"));
  const tokenSettleCall = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(tokenReserveCall.body.p_provider, "codecraft");
  assert.equal(tokenReserveCall.body.p_user_id, user.id);
  assert.equal(tokenReserveCall.body.p_idempotency_key, idempotency["Idempotency-Key"]);
  assert.equal(tokenReserveCall.body.p_requested_tokens, new TextEncoder().encode(generationBody.prompt).length + 6000 + 8192);
  assert.equal(calls.indexOf(tokenReserveCall) < calls.indexOf(providerCall), true);
  assert.equal(tokenSettleCall.body.p_actual_tokens, 20);
  assert.equal(tokenSettleCall.body.p_usage_known, true);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
  assert.equal(calls.filter(call => call.url === "https://codecraftapi.com/v1/chat/completions").length, 1);
}

async function testGeminiAdapterUsesServerKeyAndSeparateTokenBudget() {
  const localKey = "local-gemini-key-not-real";
  const completion = {
    candidates: [{ content: { role: "model", parts: [{ text: "Output Gemini mock lokal." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 22, totalTokenCount: 36 }
  };
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    completion
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: localKey });
  const data = await response.json();
  const providerCall = calls.find(call => call.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  const tokenReserveCall = calls.find(call => call.url.includes("reserve_ai_provider_tokens"));
  const tokenSettleCall = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(response.status, 200);
  assert.equal(data.output, "Output Gemini mock lokal.");
  assert.equal(data.provider, "gemini");
  assert.equal(data.model, "gemini-3.8-flash");
  assert.equal(data.credit_finalized, true);
  assert.equal(data.token_budget_finalized, true);
  assert.equal(JSON.stringify(data).includes(localKey), false);
  assert.equal(providerCall.headers.get("x-goog-api-key"), localKey);
  assert.equal(providerCall.headers.has("Authorization"), false);
  assert.deepEqual(providerCall.body.contents, [{ role: "user", parts: [{ text: generationBody.prompt }] }]);
  assert.equal(providerCall.body.generationConfig.maxOutputTokens, 6000);
  assert.equal(tokenReserveCall.body.p_provider, "gemini");
  assert.equal(tokenSettleCall.body.p_actual_tokens, 36);
  assert.equal(tokenSettleCall.body.p_usage_known, true);
  assert.equal(calls.some(call => call.url.includes("codecraftapi.com/v1/chat/completions")), false);
  assert.equal(calls.filter(call => call.url.includes("generativelanguage.googleapis.com") && call.method === "POST").length, 1);
}

async function testGeminiMissingKeyDoesNotReserveOrCallProvider() {
  const calls = installMockFetch({ providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), workerEnv);
  assert.equal(response.status, 503);
  assert.equal(calls.some(call => call.url.includes("consume_ai_credit_idempotent")), false);
  assert.equal(calls.some(call => call.url.includes("reserve_ai_provider_tokens")), false);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
}

async function testGeminiRateLimitHardStopsWithoutCodeCraftFallback() {
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    providerStatus: 429,
    completion: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "daily quota exhausted" } }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
  const settlement = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  const block = calls.find(call => call.url.includes("block_ai_provider_tokens"));
  assert.equal(response.status, 502);
  assert.equal(calls.find(call => call.url.includes("reserve_ai_provider_tokens")).body.p_provider, "gemini");
  assert.equal(settlement.body.p_force_block, true);
  assert.equal(settlement.body.p_block_reason, "provider_rate_limited");
  assert.equal(block.body.p_provider, "gemini");
  assert.equal(block.body.p_block_reason, "provider_rate_limited");
  assert.equal((await response.clone().json()).provider_blocked, true);
  assert.equal(calls.filter(call => call.url.includes("generativelanguage.googleapis.com") && call.method === "POST").length, 1);
  assert.equal(calls.some(call => call.url.includes("codecraftapi.com/v1/chat/completions")), false);
}

async function testGeminiBlockedBudgetStopsBeforeAnyProviderCall() {
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    tokenBudgetReservation: {
      allowed: false, duplicate: false, token_limit: 500000, used_tokens: 100,
      reserved_tokens: 0, remaining_tokens: 499900, blocked: true, blocked_reason: "provider_rate_limited"
    }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
  assert.equal(response.status, 429);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
  assert.equal(calls.some(call => call.url.includes("codecraftapi.com/v1/chat/completions")), false);
}

async function testSettlementFailureUsesIndependentHardBlockRpc() {
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    tokenBudgetSettleStatus: 503,
    providerStatus: 429,
    completion: { error: { status: "RESOURCE_EXHAUSTED", message: "rate limit" } }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
  const data = await response.json();
  const block = calls.find(call => call.url.includes("block_ai_provider_tokens"));
  const settlements = calls.filter(call => call.url.includes("settle_ai_provider_tokens"));
  const blocks = calls.filter(call => call.url.includes("block_ai_provider_tokens"));
  assert.equal(response.status, 502);
  assert.equal(data.provider_blocked, true);
  assert.equal(data.token_budget_finalized, false);
  assert.equal(block.body.p_provider, "gemini");
  assert.equal(block.body.p_block_reason, "provider_rate_limited");
  assert.match(data.warning, /reservasi maksimum tetap dihitung/);
  assert.equal(settlements.length, 2);
  assert.equal(blocks.length, 1);
  assert.equal(calls.indexOf(settlements[1]) < calls.indexOf(blocks[0]), true);
}

async function testFailedHardBlockConfirmationIsReported() {
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    tokenBudgetSettleStatus: 503,
    providerBlockStatus: 503,
    providerStatus: 429,
    completion: { error: { status: "RESOURCE_EXHAUSTED", message: "rate limit" } }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.provider_blocked, false);
  assert.match(data.warning, /belum terkonfirmasi/);
  assert.equal(calls.filter(call => call.url.includes("block_ai_provider_tokens")).length, 2);
}

async function testMismatchedHardBlockConfirmationIsRejected() {
  for (const providerBlockResult of [
    { blocked: true, provider: "codecraft", blocked_reason: "provider_rate_limited" },
    { blocked: true, provider: "gemini", blocked_reason: "unknown_reason" },
    { blocked: true, provider: "gemini", blocked_reason: "token_cap_reached" }
  ]) {
    const calls = installMockFetch({
      providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
      providerBlockResult,
      providerStatus: 429,
      completion: { error: { status: "RESOURCE_EXHAUSTED", message: "rate limit" } }
    });
    const response = await worker.fetch(request("/generate", {
      method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
    }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(data.provider_blocked, false);
    assert.match(data.warning, /belum terkonfirmasi/);
    assert.equal(calls.filter(call => call.url.includes("block_ai_provider_tokens")).length, 2);
  }
}

async function testNetworkFailureWithUnsettledTokensWarnsReservationHeld() {
  const calls = installMockFetch({ providerThrow: true, tokenBudgetSettleStatus: 503 });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.token_budget_finalized, false);
  assert.match(data.warning, /reservasi maksimum tetap dihitung/);
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
}

async function testEmptyGeminiOutputWithUnsettledTokensWarnsReservationHeld() {
  const calls = installMockFetch({
    providerSettings: { ...settings, active_provider: "gemini", model_id: "gemini-3.8-flash" },
    tokenBudgetSettleStatus: 503,
    completion: { candidates: [] }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, GEMINI_API_KEY: "local-gemini-key-not-real" });
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.token_budget_finalized, false);
  assert.match(data.warning, /reservasi maksimum tetap dihitung/);
  assert.equal(calls.filter(call => call.url.includes("generativelanguage.googleapis.com") && call.method === "POST").length, 1);
}

async function testDuplicateDoesNotCallProvider() {
  const calls = installMockFetch({ reservation: { reservation_id: 9, credits_remaining: 4, duplicate: true, status: "reserved" } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 409);
  assert.equal(data.duplicate, true);
  assert.equal(calls.some(call => call.url === "https://codecraftapi.com/v1/chat/completions"), false);
}

async function testReservationFailureDoesNotCallProviderOrLeakDatabaseDetail() {
  const calls = installMockFetch({ reserveStatus: 500, reservation: { message: "internal schema secret" } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.equal(body.includes("internal schema secret"), false);
  assert.equal(calls.some(call => call.url.startsWith("https://codecraftapi.com/")), false);
}

async function testTokenCapDeniedRefundsAndStopsBeforeProvider() {
  const calls = installMockFetch({ tokenBudgetReservation: {
    allowed: false, duplicate: false, token_limit: 500000, used_tokens: 499000,
    reserved_tokens: 0, remaining_tokens: 1000, blocked: false
  } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 429);
  assert.match(data.error, /Sisa cap token/);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  assert.equal(calls.some(call => call.url.includes("settle_ai_provider_tokens")), false);
  assert.equal(calls.some(call => call.url.includes("/chat/completions")), false);
}

async function testTokenCapBlockedStopsBeforeProvider() {
  const calls = installMockFetch({ tokenBudgetReservation: {
    allowed: false, duplicate: false, token_limit: 500000, used_tokens: 1000,
    reserved_tokens: 0, remaining_tokens: 499000, blocked: true,
    blocked_reason: "provider_rate_limited"
  } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 429);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  assert.equal(calls.some(call => call.url.includes("/chat/completions")), false);
}

async function testTokenBudgetRpcFailureFailsClosed() {
  const calls = installMockFetch({ tokenBudgetReserveStatus: 500 });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 503);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  assert.equal(calls.some(call => call.url.includes("/chat/completions")), false);
}

async function testDuplicateTokenReservationDoesNotCallProvider() {
  const calls = installMockFetch({ tokenBudgetReservation: {
    allowed: false, duplicate: true, reservation_id: 31, status: "reserved",
    token_limit: 500000, used_tokens: 0, reserved_tokens: 24000,
    remaining_tokens: 476000, blocked: false
  } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 409);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  assert.equal(calls.some(call => call.url.includes("/chat/completions")), false);
}

async function testProviderRateLimitDoesNotTriggerFallback() {
  const calls = installMockFetch({ completion: { error: { message: "rate limited" } }, providerStatus: 429 });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
  assert.equal(calls.filter(call => call.url.startsWith("https://codecraftapi.com/")).length, 1);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
  const settlement = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(settlement.body.p_force_block, true);
  assert.equal(settlement.body.p_block_reason, "provider_rate_limited");
}

async function testProviderQuotaOrBillingMessageHardBlocks() {
  const calls = installMockFetch({
    providerStatus: 400,
    completion: { error: { code: "insufficient_quota", message: "fake-api-key-echo-from-upstream" } }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  assert.equal((await response.clone().text()).includes("fake-api-key-echo-from-upstream"), false);
  const settlement = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(settlement.body.p_force_block, true);
  assert.equal(settlement.body.p_block_reason, "provider_quota_or_balance_exhausted");
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
}

async function testProviderPaymentRequiredHardBlocks() {
  const calls = installMockFetch({
    providerStatus: 402,
    completion: { error: { code: "payment_required", message: "Payment required" } }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  const settlement = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(settlement.body.p_force_block, true);
  assert.equal(settlement.body.p_block_reason, "provider_quota_or_balance_exhausted");
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
}

async function testMissingUsageSettlesFullReservation() {
  const calls = installMockFetch({ completion: { choices: [{ message: { content: "Output mock tanpa usage." } }] } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 200);
  const settlement = calls.find(call => call.url.includes("settle_ai_provider_tokens"));
  assert.equal(settlement.body.p_usage_known, false);
  assert.equal(settlement.body.p_actual_tokens, null);
}

async function testQuotaSettlementFailureKeepsOutputAndReservation() {
  const calls = installMockFetch({ tokenBudgetSettleStatus: 503 });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.output, "Output AI mock lokal.");
  assert.equal(data.token_budget_finalized, false);
  assert.match(data.warning, /reservasi maksimum tetap ditahan/);
}

async function testSettlementForWrongProviderIsNotConfirmed() {
  const calls = installMockFetch({
    tokenBudgetSettlement: {
      settled: true, duplicate: false, status: "settled", provider: "gemini",
      accounted_tokens: 20, overrun: false, token_limit: 500000,
      used_tokens: 20, reserved_tokens: 0, remaining_tokens: 499980, blocked: false
    }
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.token_budget_finalized, false);
  assert.match(data.warning, /reservasi maksimum tetap ditahan/);
  assert.equal(calls.some(call => call.url.includes("/chat/completions")), true);
}

async function testAmbiguousProviderNetworkFailureDoesNotFallback() {
  const calls = installMockFetch({ providerThrow: true });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  assert.equal(calls.filter(call => call.url === "https://codecraftapi.com/v1/chat/completions").length, 1);
  assert.equal(calls.filter(call => call.url.startsWith("https://codecraftapi.com/")).length, 1);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
}

async function testWorkerHasNoActiveAlternateForCertifiedPreSendFailure() {
  const calls = installMockFetch({
    providerThrow: true,
    providerError: new CertifiedPreSendFailure("dns-resolution")
  });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
  assert.equal(calls.some(call => call.url.startsWith("https://alternate.example/")), false);
  assert.equal(calls.some(call => call.url.includes("generativelanguage.googleapis.com")), false);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
}

async function testProviderTimeoutAbortsAndRefunds() {
  const calls = installMockFetch({ providerHang: true, tokenBudgetSettleStatus: 503 });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only", PROVIDER_TIMEOUT_MS: 50 });
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.match(data.error, /melewati batas waktu/);
  assert.match(data.warning, /reservasi maksimum tetap dihitung/);
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
}

async function testMalformedProviderOutputRefunds() {
  const calls = installMockFetch({ completion: { choices: [] } });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  assert.equal(response.status, 502);
  assert.equal(calls.some(call => call.url.includes("refund_ai_credit")), true);
}

async function testGeneratedOutputSurvivesCreditFinalizationFailure() {
  const calls = installMockFetch({ finalizeValue: false });
  const response = await worker.fetch(request("/generate", {
    method: "POST", headers: { ...bearer, ...idempotency }, body: generationBody
  }), { ...workerEnv, CODECRAFT_API_KEY: "local-test-only" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.output, "Output AI mock lokal.");
  assert.equal(data.credit_finalized, false);
  assert.match(data.warning, /jangan kirim ulang/);
  assert.equal(calls.filter(call => call.url.includes("/chat/completions")).length, 1);
}

async function testMigrationKeepsConfigServerOnly() {
  const sql = await readFile(new URL("../migrations/20261114_ai_provider_settings.sql", import.meta.url), "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.ai_provider_settings FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT SELECT, UPDATE ON TABLE public\.ai_provider_settings TO service_role/i);
  assert.match(sql, /never store provider API keys/i);
}

async function testTokenCapMigrationIsPrivateAndCumulative() {
  const sql = await readFile(new URL("../migrations/20261114_ai_provider_token_cap.sql", import.meta.url), "utf8");
  assert.match(sql, /token_limit bigint NOT NULL CONSTRAINT ai_provider_token_budget_fixed_limit CHECK \(token_limit = 500000\)/i);
  assert.match(sql, /reserved_tokens bigint NOT NULL DEFAULT 0/i);
  assert.match(sql, /UNIQUE \(provider, user_id, idempotency_key\)/i);
  assert.match(sql, /ALTER TABLE public\.ai_provider_token_budget ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE public\.ai_provider_token_reservations ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.ai_provider_token_budget FROM PUBLIC, anon, authenticated, service_role/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reserve_ai_provider_tokens[\s\S]*TO service_role/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /provider_quota_or_balance_exhausted/);
  assert.match(sql, /provider_rate_limited/);
}

async function testGeminiBudgetMigrationKeepsCodeCraftAndAddsCooldown() {
  const sql = await readFile(new URL("../migrations/20261114_gemini_provider_budget.sql", import.meta.url), "utf8");
  assert.match(sql, /CHECK \(provider IN \('codecraft', 'gemini'\)\)/i);
  assert.match(sql, /VALUES \('gemini', 500000, 0, 0\)/i);
  assert.match(sql, /p_provider NOT IN \('codecraft', 'gemini'\)/i);
  assert.match(sql, /v_blocked_reason = 'provider_rate_limited'/i);
  assert.match(sql, /interval '24 hours'/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /SET search_path TO ''/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reserve_ai_provider_tokens[\s\S]*TO service_role/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.block_ai_provider_tokens/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.block_ai_provider_tokens[\s\S]*TO service_role/i);
  assert.equal((sql.match(/'provider', v_provider/g) || []).length, 2);
  assert.match(sql, /budget-before-reservation order/i);
  assert.match(sql, /caps do not auto-reset/i);
}

async function testAdminPreflightNeedsNoLoginOrProviderCall() {
  const calls = installMockFetch();
  const response = await worker.fetch(request("/admin/provider-settings", { method: "OPTIONS" }), workerEnv);
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /GET, POST, OPTIONS/);
  assert.equal(calls.length, 0);
}

const tests = [
  testAdminOnlyAndNoSecretReturned,
  testMissingBearerIsRejectedWithoutAuthRequest,
  testInvalidSupabaseSessionIsRejected,
  testUnconfirmedAndNonAdminUsersAreRejected,
  testAdminSecretMissingFailsClosed,
  testAdminCanSaveOnlyProviderAndModel,
  testAdminCanSelectGeminiWithoutGeneration,
  testUnknownProviderAndInvalidModelAreRejected,
  testInvalidOriginIsRejected,
  testOversizedGenerationBodyIsRejectedBeforeAuth,
  testMissingKeyDoesNotReserveCreditOrCallProvider,
  testCodeCraftOpenAICompatibleAdapter,
  testGeminiAdapterUsesServerKeyAndSeparateTokenBudget,
  testGeminiMissingKeyDoesNotReserveOrCallProvider,
  testGeminiRateLimitHardStopsWithoutCodeCraftFallback,
  testSettlementFailureUsesIndependentHardBlockRpc,
  testFailedHardBlockConfirmationIsReported,
  testMismatchedHardBlockConfirmationIsRejected,
  testNetworkFailureWithUnsettledTokensWarnsReservationHeld,
  testEmptyGeminiOutputWithUnsettledTokensWarnsReservationHeld,
  testGeminiBlockedBudgetStopsBeforeAnyProviderCall,
  testDuplicateDoesNotCallProvider,
  testReservationFailureDoesNotCallProviderOrLeakDatabaseDetail,
  testTokenCapDeniedRefundsAndStopsBeforeProvider,
  testTokenCapBlockedStopsBeforeProvider,
  testTokenBudgetRpcFailureFailsClosed,
  testDuplicateTokenReservationDoesNotCallProvider,
  testProviderRateLimitDoesNotTriggerFallback,
  testProviderQuotaOrBillingMessageHardBlocks,
  testProviderPaymentRequiredHardBlocks,
  testMissingUsageSettlesFullReservation,
  testQuotaSettlementFailureKeepsOutputAndReservation,
  testSettlementForWrongProviderIsNotConfirmed,
  testAmbiguousProviderNetworkFailureDoesNotFallback,
  testWorkerHasNoActiveAlternateForCertifiedPreSendFailure,
  testProviderTimeoutAbortsAndRefunds,
  testMalformedProviderOutputRefunds,
  testGeneratedOutputSurvivesCreditFinalizationFailure,
  testMigrationKeepsConfigServerOnly,
  testTokenCapMigrationIsPrivateAndCumulative,
  testGeminiBudgetMigrationKeepsCodeCraftAndAddsCooldown,
  testAdminPreflightNeedsNoLoginOrProviderCall
];

try {
  for (const test of tests) {
    await test();
    console.log("PASS " + test.name);
  }
  console.log(`Passed ${tests.length} local mock tests; no external network requests were made.`);
} finally {
  globalThis.fetch = previousFetch;
}
