import { attemptProviderChain } from "./provider-failover.js";
const SUPABASE_URL = "https://mxseekqjwyrtkmjtyjun.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_3T4cxk_Yxvke5vsZU_g2pA_VlNO8gjD";
const ALLOWED_ORIGINS = new Set([
  "https://misba234.github.io",
  "https://payung-ai-studio.misbaahmed17.workers.dev"
]);
const ADMIN_SETTINGS_PATH = "/admin/provider-settings";
const ALLOWED_ACTIONS = new Set(["social-content", "storyboard", "calendar"]);
const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_COMPLETION_TOKENS = 6000;
const TOKEN_BUDGET_CAP = 500000;
const TOKEN_RESERVATION_OVERHEAD = 8192;

// Provider endpoints are code-allowlisted. Never accept an arbitrary base URL from the browser.
// New providers can be added here with their own fixed endpoint, secret binding, and adapter.
const PROVIDERS = Object.freeze({
  codecraft: Object.freeze({
    id: "codecraft",
    label: "CodeCraft API",
    baseUrl: "https://codecraftapi.com/v1",
    apiKeyEnv: "CODECRAFT_API_KEY",
    adapter: "openai-chat-completions",
    billingGroup: "codecraft-account",
    // No alternate provider is configured or authorized in this local patch.
    failovers: Object.freeze([])
  })
});

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://misba234.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Vary": "Origin"
  };
}

function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function rejectOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return { origin, response: reply({ error: "Origin tidak diizinkan." }, 403, origin) };
  return { origin, response: null };
}

async function readJsonBody(request, maxLength, origin) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxLength) {
    try { await request.body?.cancel(); } catch {}
    return { response: reply({ error: "Permintaan terlalu besar." }, 413, origin) };
  }
  const reader = request.body?.getReader();
  if (!reader) return { response: reply({ error: "Format permintaan tidak valid." }, 400, origin) };
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxLength) {
        try { await reader.cancel(); } catch {}
        return { response: reply({ error: "Permintaan terlalu besar." }, 413, origin) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    try { await reader.cancel(); } catch {}
    return { response: reply({ error: "Format permintaan tidak valid." }, 400, origin) };
  }
}

async function authenticateUser(request, origin) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= 7) {
    return { response: reply({ error: "Silakan login terlebih dahulu." }, 401, origin) };
  }

  let authResponse;
  try {
    authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Authorization": authorization
      }
    });
  } catch {
    return { response: reply({ error: "Layanan autentikasi tidak dapat dihubungi." }, 502, origin) };
  }
  if (!authResponse.ok) return { response: reply({ error: "Sesi login tidak valid. Silakan login ulang." }, 401, origin) };
  const user = await authResponse.json().catch(() => null);
  if (!user?.id) return { response: reply({ error: "Identitas pengguna tidak valid." }, 401, origin) };
  return { user };
}

function serviceRoleHeaders(env, extra = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return {
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Content-Type": "application/json",
    ...extra
  };
}

function estimateReservedTokens(prompt) {
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  return Math.min(TOKEN_BUDGET_CAP, promptBytes + MAX_COMPLETION_TOKENS + TOKEN_RESERVATION_OVERHEAD);
}

function reportedTokenUsage(providerData) {
  const value = providerData?.usage?.total_tokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerLimitBlockReason(status, providerData) {
  const error = providerData?.error;
  const details = [error?.code, error?.type, error?.message, providerData?.code, providerData?.message]
    .filter(value => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (status === 429 || /rate.?limit|too.?many.?requests|resource.?exhausted|tokens?.?per.?minute/.test(details)) {
    return "provider_rate_limited";
  }
  if (status === 402 || /quota|insufficient.?fund|payment.?required|billing|balance|credit.?exhaust|funds.?exhaust/.test(details)) {
    return "provider_quota_or_balance_exhausted";
  }
  return null;
}

async function reserveProviderTokenBudget(rpcHeaders, userId, idempotencyKey, requestedTokens) {
  try {
    const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/reserve_ai_provider_tokens", {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({
        p_provider: "codecraft",
        p_user_id: userId,
        p_idempotency_key: idempotencyKey,
        p_requested_tokens: requestedTokens
      })
    });
    if (!response.ok) return { ok: false, data: null };
    const data = await response.json().catch(() => null);
    if (!data || typeof data.allowed !== "boolean") return { ok: false, data: null };
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}

async function settleProviderTokenBudget(rpcHeaders, reservationId, usageTokens, forceBlockReason = null) {
  const payload = {
    p_reservation_id: reservationId,
    p_actual_tokens: usageTokens,
    p_usage_known: usageTokens !== null,
    p_force_block: forceBlockReason !== null,
    p_block_reason: forceBlockReason
  };
  const attempts = forceBlockReason ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/settle_ai_provider_tokens", {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify(payload)
      });
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      if (data && (data.settled === true || data.duplicate === true)) return { ok: true, data };
    } catch {}
  }
  return { ok: false, data: null };
}

function providerList(env) {
  return Object.values(PROVIDERS).map(provider => ({
    id: provider.id,
    label: provider.label,
    base_url: provider.baseUrl,
    adapter: provider.adapter,
    api_key_configured: typeof env[provider.apiKeyEnv] === "string" && env[provider.apiKeyEnv].trim().length > 0
  }));
}

async function loadProviderSettings(env) {
  const headers = serviceRoleHeaders(env);
  if (!headers) throw new Error("service-role-not-configured");
  const response = await fetch(
    SUPABASE_URL + "/rest/v1/ai_provider_settings?id=eq.1&select=active_provider,model_id,updated_at&limit=1",
    { headers }
  );
  if (!response.ok) throw new Error("provider-settings-unavailable");
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || !rows[0]) throw new Error("provider-settings-missing");
  return rows[0];
}

function adminSettingsPayload(settings, env) {
  const provider = PROVIDERS[settings.active_provider];
  if (!provider) return null;
  return {
    is_admin: true,
    active_provider: provider.id,
    model_id: String(settings.model_id || ""),
    updated_at: settings.updated_at || null,
    providers: providerList(env)
  };
}

async function handleAdminProviderSettings(request, env) {
  const { origin, response: originError } = rejectOrigin(request);
  if (originError) return originError;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "GET" && request.method !== "POST") {
    return reply({ error: "Method tidak diizinkan." }, 405, origin);
  }

  const auth = await authenticateUser(request, origin);
  if (auth.response) return auth.response;
  const adminEmail = String(env.PAYUNG_ADMIN_EMAIL || "").trim().toLowerCase();
  const userEmail = String(auth.user.email || "").trim().toLowerCase();
  if (!adminEmail) return reply({ error: "Akses admin belum dikonfigurasi pada Worker." }, 503, origin);
  if (!userEmail || userEmail !== adminEmail || !auth.user.email_confirmed_at) {
    return reply({ error: "Akses admin tidak diizinkan." }, 403, origin);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "Secret service-role belum dikonfigurasi pada Worker." }, 503, origin);
  }

  if (request.method === "GET") {
    let settings;
    try { settings = await loadProviderSettings(env); }
    catch { return reply({ error: "Pengaturan provider belum tersedia. Terapkan migrasi database terlebih dahulu." }, 503, origin); }
    const payload = adminSettingsPayload(settings, env);
    if (!payload) return reply({ error: "Provider aktif belum didaftarkan pada Worker." }, 503, origin);
    return reply(payload, 200, origin);
  }

  const parsed = await readJsonBody(request, 4000, origin);
  if (parsed.response) return parsed.response;
  const providerId = String(parsed.value?.active_provider || "").trim();
  const modelId = String(parsed.value?.model_id || "").trim();
  if (!PROVIDERS[providerId]) return reply({ error: "Provider tidak dikenal." }, 400, origin);
  if (!MODEL_ID_RE.test(modelId)) return reply({ error: "Model ID kosong atau formatnya tidak valid." }, 400, origin);

  let updateResponse;
  try {
    updateResponse = await fetch(SUPABASE_URL + "/rest/v1/ai_provider_settings?id=eq.1", {
      method: "PATCH",
      headers: serviceRoleHeaders(env, { "Prefer": "return=representation" }),
      body: JSON.stringify({
        active_provider: providerId,
        model_id: modelId,
        updated_at: new Date().toISOString(),
        updated_by: auth.user.id
      })
    });
  } catch {
    return reply({ error: "Pengaturan provider gagal disimpan." }, 502, origin);
  }
  if (!updateResponse.ok) return reply({ error: "Pengaturan provider gagal disimpan." }, 502, origin);
  const rows = await updateResponse.json().catch(() => null);
  if (!Array.isArray(rows) || !rows[0]) return reply({ error: "Baris pengaturan provider tidak ditemukan." }, 503, origin);
  const payload = adminSettingsPayload(rows[0], env);
  if (!payload) return reply({ error: "Provider tidak dikenal." }, 400, origin);
  return reply(payload, 200, origin);
}

function extractOpenAIChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => typeof part === "string" ? part : (part?.type === "text" ? String(part.text || "") : "")).join("\n").trim();
  }
  return "";
}

async function generate(request, env) {
  const { origin, response: originError } = rejectOrigin(request);
  if (originError) return originError;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return reply({ error: "Method tidak diizinkan." }, 405, origin);

  const parsed = await readJsonBody(request, 24000, origin);
  if (parsed.response) return parsed.response;
  const action = String(parsed.value?.action || "");
  const prompt = String(parsed.value?.prompt || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) return reply({ error: "Jenis generator tidak dikenal." }, 400, origin);
  if (!prompt || prompt.length > 12000) return reply({ error: "Prompt kosong atau terlalu panjang." }, 400, origin);
  const idempotencyKey = request.headers.get("Idempotency-Key") || "";
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return reply({ error: "Kunci idempotensi tidak valid. Muat ulang halaman lalu coba lagi." }, 400, origin);
  }

  const auth = await authenticateUser(request, origin);
  if (auth.response) return auth.response;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "Secret runtime SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi pada Worker." }, 503, origin);
  }

  let settings;
  try { settings = await loadProviderSettings(env); }
  catch { return reply({ error: "Pengaturan AI belum tersedia. Hubungi administrator." }, 503, origin); }
  const provider = PROVIDERS[settings.active_provider];
  const modelId = String(settings.model_id || "").trim();
  if (!provider || !MODEL_ID_RE.test(modelId)) {
    return reply({ error: "Provider atau model AI belum dikonfigurasi oleh administrator." }, 503, origin);
  }
  const apiKey = env[provider.apiKeyEnv];
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return reply({ error: "API key provider belum dipasang sebagai Worker secret." }, 503, origin);
  }
  if (provider.adapter !== "openai-chat-completions") {
    return reply({ error: "Adapter provider belum tersedia." }, 503, origin);
  }

  // Reserve one credit only after identity, provider configuration, model and key are valid.
  const rpcHeaders = serviceRoleHeaders(env);
  let reserveResponse;
  try {
    reserveResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/consume_ai_credit_idempotent", {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({
        p_user_id: auth.user.id,
        p_action: action,
        p_model: provider.id + ":" + modelId,
        p_idempotency_key: idempotencyKey
      })
    });
  } catch {
    return reply({ error: "Tidak dapat mengamankan kredit. Permintaan dibatalkan sebelum memanggil provider." }, 502, origin);
  }
  if (!reserveResponse.ok) {
    if (reserveResponse.status === 400 || reserveResponse.status === 403) {
      return reply({ error: "Kredit tidak cukup atau akun tidak valid." }, 403, origin);
    }
    return reply({ error: "Gagal mengamankan kredit. Permintaan dibatalkan." }, 502, origin);
  }

  const reservation = await reserveResponse.json().catch(() => null);
  const reservationId = Number(reservation?.reservation_id);
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    return reply({ error: "Respons reservasi kredit tidak valid. Hubungi administrator." }, 502, origin);
  }
  if (reservation?.duplicate === true) {
    return reply({
      error: "Permintaan ini sudah diterima sebelumnya. Tidak ada kredit tambahan atau permintaan AI kedua.",
      duplicate: true,
      reservation_id: reservationId,
      status: String(reservation.status || "unknown"),
      credits_remaining: reservation.credits_remaining == null ? null : Number(reservation.credits_remaining)
    }, 409, origin);
  }

  async function refundReservation() {
    try {
      const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/refund_ai_credit", {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify({ p_reservation_id: reservationId })
      });
      return response.ok;
    } catch { return false; }
  }

  const requestedTokenBudget = estimateReservedTokens(prompt);
  const tokenBudgetReservation = await reserveProviderTokenBudget(
    rpcHeaders, auth.user.id, idempotencyKey, requestedTokenBudget
  );
  if (!tokenBudgetReservation.ok) {
    const refunded = await refundReservation();
    return reply({
      error: "Batas token tidak dapat diamankan; permintaan provider dibatalkan.",
      credit_refunded: refunded
    }, 503, origin);
  }
  const tokenBudget = tokenBudgetReservation.data;
  if (tokenBudget.duplicate === true) {
    const refunded = await refundReservation();
    return reply({
      error: "Reservasi token untuk permintaan ini sudah ada; tidak ada panggilan provider kedua.",
      duplicate: true,
      credit_refunded: refunded
    }, 409, origin);
  }
  const tokenBudgetReservationId = Number(tokenBudget.reservation_id);
  if (tokenBudget.allowed !== true || !Number.isSafeInteger(tokenBudgetReservationId) || tokenBudgetReservationId <= 0) {
    const refunded = await refundReservation();
    const error = tokenBudget.blocked === true
      ? "Provider CodeCraft diblokir atau cap token Payung AI Studio telah tercapai. Tidak ada permintaan provider yang dikirim."
      : "Sisa cap token Payung AI Studio tidak cukup untuk permintaan ini. Tidak ada permintaan provider yang dikirim.";
    return reply({ error, credit_refunded: refunded }, 429, origin);
  }

  // No retries or key rotations. The helper advances only on a trusted, certified
  // pre-send failure; normal Cloudflare public-fetch errors remain ambiguous.
  let providerResponse;
  let providerUsed = provider;
  let modelUsed = modelId;
  const configuredTimeoutMs = Number(env.PROVIDER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 50 && configuredTimeoutMs <= 60000
    ? Math.floor(configuredTimeoutMs) : 45000;
  const providerAbort = new AbortController();
  const providerTimeout = setTimeout(() => providerAbort.abort(), timeoutMs);
  const providerCandidates = [
    { provider, modelId },
    ...(Array.isArray(provider.failovers) ? provider.failovers : []).map(fallback => ({
      provider: PROVIDERS[fallback.providerId],
      modelId: fallback.modelId
    }))
  ].filter(candidate => candidate.provider && MODEL_ID_RE.test(candidate.modelId || ""));
  try {
    const attempt = await attemptProviderChain(providerCandidates, ({ provider: selectedProvider, modelId: selectedModelId }) => {
      const selectedApiKey = env[selectedProvider.apiKeyEnv];
      if (typeof selectedApiKey !== "string" || !selectedApiKey.trim()) throw new Error("provider-key-not-configured");
      if (selectedProvider.adapter !== "openai-chat-completions") throw new Error("provider-adapter-not-configured");
      return fetch(selectedProvider.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + selectedApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModelId,
          messages: [{ role: "user", content: prompt }],
          max_tokens: MAX_COMPLETION_TOKENS
        }),
        signal: providerAbort.signal
      });
    });
    providerResponse = attempt.response;
    providerUsed = attempt.provider;
    modelUsed = attempt.modelId;
  } catch {
    const timedOut = providerAbort.signal.aborted;
    const tokenSettlement = await settleProviderTokenBudget(rpcHeaders, tokenBudgetReservationId, null);
    const refunded = await refundReservation();
    const error = timedOut
      ? (refunded ? "Provider melewati batas waktu. Kredit internal telah dikembalikan." : "Provider melewati batas waktu dan refund belum terkonfirmasi. Hubungi administrator.")
      : (refunded ? "Tidak dapat menghubungi provider. Kredit internal telah dikembalikan." : "Provider tidak dapat dihubungi dan refund belum terkonfirmasi. Hubungi administrator.");
    return reply({ error, token_budget_finalized: tokenSettlement.ok }, 502, origin);
  } finally {
    clearTimeout(providerTimeout);
  }

  const providerData = await providerResponse.json().catch(() => ({}));
  const usageTokens = reportedTokenUsage(providerData);
  const forceBlockReason = providerLimitBlockReason(providerResponse.status, providerData);
  const tokenSettlement = await settleProviderTokenBudget(
    rpcHeaders, tokenBudgetReservationId, usageTokens, forceBlockReason
  );
  if (!providerResponse.ok) {
    const refunded = await refundReservation();
    const message = String(providerData?.error?.message || providerData?.message || "Provider gagal memproses permintaan.").slice(0, 500);
    return reply({
      error: message,
      provider_status: providerResponse.status,
      provider_blocked: forceBlockReason !== null,
      token_budget_finalized: tokenSettlement.ok,
      credit_refunded: refunded
    }, 502, origin);
  }

  const output = extractOpenAIChatText(providerData);
  if (!output) {
    const refunded = await refundReservation();
    return reply({
      error: "Provider tidak menghasilkan teks.",
      token_budget_finalized: tokenSettlement.ok,
      credit_refunded: refunded
    }, 502, origin);
  }

  let finalizeResponse;
  const baseResult = {
    output,
    provider: providerUsed.id,
    model: modelUsed,
    token_budget_finalized: tokenSettlement.ok,
    credits_remaining: reservation.credits_remaining == null ? null : Number(reservation.credits_remaining)
  };
  try {
    finalizeResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/finalize_ai_credit", {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ p_reservation_id: reservationId })
    });
  } catch {
    return reply({
      ...baseResult,
      credit_finalized: false,
      warning: [
        "Hasil AI sudah dibuat, tetapi status kredit belum terkonfirmasi. Simpan hasil ini, jangan kirim ulang, dan hubungi administrator.",
        ...(tokenSettlement.ok ? [] : ["Pencatatan pemakaian token belum terkonfirmasi; reservasi maksimum tetap ditahan agar cap tidak terlampaui."])
      ].join(" ")
    }, 200, origin);
  }
  if (!finalizeResponse.ok || (await finalizeResponse.json().catch(() => false)) !== true) {
    return reply({
      ...baseResult,
      credit_finalized: false,
      warning: [
        "Hasil AI sudah dibuat, tetapi finalisasi kredit gagal. Simpan hasil ini, jangan kirim ulang, dan hubungi administrator.",
        ...(tokenSettlement.ok ? [] : ["Pencatatan pemakaian token belum terkonfirmasi; reservasi maksimum tetap ditahan agar cap tidak terlampaui."])
      ].join(" ")
    }, 200, origin);
  }

  const result = { ...baseResult, credit_finalized: true };
  if (!tokenSettlement.ok) {
    result.warning = "Pencatatan pemakaian token belum terkonfirmasi; reservasi maksimum tetap ditahan agar cap tidak terlampaui. Simpan hasil ini dan jangan kirim ulang.";
  } else if (tokenSettlement.data?.overrun === true) {
    result.warning = "Pemakaian token melebihi reservasi konservatif; provider diblokir untuk mencegah pemakaian lanjutan. Hubungi administrator.";
  }
  return reply(result, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/generate") return generate(request, env);
    if (url.pathname === ADMIN_SETTINGS_PATH) return handleAdminProviderSettings(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "Payung AI Studio API", status: "online" }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};
