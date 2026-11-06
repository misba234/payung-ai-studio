const SUPABASE_URL = "https://mxseekqjwyrtkmjtyjun.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_3T4cxk_Yxvke5vsZU_g2pA_VlNO8gjD";
const ALLOWED_ORIGINS = new Set(["https://misba234.github.io", "https://payung-ai-studio.misbaahmed17.workers.dev"]);
const GEMINI_MODEL = "gemini-3.8-flash";
const ALLOWED_ACTIONS = new Set(["social-content", "storyboard", "calendar"]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://misba234.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}
function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) }
  });
}
async function generate(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return reply({ error: "Origin tidak diizinkan." }, 403, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return reply({ error: "Method tidak diizinkan." }, 405, origin);
  if (!env.GEMINI_API_KEY) return reply({ error: "Secret runtime GEMINI_API_KEY belum dikonfigurasi pada Worker." }, 503, origin);

  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply({ error: "Silakan login terlebih dahulu." }, 401, origin);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 24000) return reply({ error: "Permintaan terlalu besar." }, 413, origin);
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "Format permintaan tidak valid." }, 400, origin);
  }
  const action = String(body.action || "");
  const prompt = String(body.prompt || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) return reply({ error: "Jenis generator tidak dikenal." }, 400, origin);
  if (!prompt || prompt.length > 12000) return reply({ error: "Prompt kosong atau terlalu panjang." }, 400, origin);

  const token = authorization.slice(7);
  let authResponse;
  try {
    authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": "Bearer " + token }
    });
  } catch {
    return reply({ error: "Layanan autentikasi tidak dapat dihubungi." }, 502, origin);
  }
  if (!authResponse.ok) return reply({ error: "Sesi login tidak valid. Silakan login ulang." }, 401, origin);
  const user = await authResponse.json();
  if (!user?.id) return reply({ error: "Identitas pengguna tidak valid." }, 401, origin);

  // Call Gemini first. Failed generations never consume credits.
  let geminiResponse;
  try {
    geminiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 6000 }
      })
    });
  } catch {
    return reply({ error: "Tidak dapat menghubungi Gemini. Kredit tidak dipotong." }, 502, origin);
  }
  const geminiData = await geminiResponse.json().catch(() => ({}));
  if (!geminiResponse.ok) {
    const message = geminiData?.error?.message || "Gemini gagal memproses permintaan.";
    return reply({ error: message, provider_status: geminiResponse.status }, 502, origin);
  }
  const output = (geminiData?.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\n").trim();
  if (!output) return reply({ error: "Gemini tidak menghasilkan teks. Kredit tidak dipotong." }, 502, origin);

  // Debit only via service-role protected RPC; identity is revalidated by the SQL function.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "Secret runtime SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi pada Worker." }, 503, origin);
  }
  const debitResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/consume_ai_credit", {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: user.id, p_action: action, p_model: GEMINI_MODEL })
  });
  if (!debitResponse.ok) {
    const detail = await debitResponse.text().catch(() => "");
    if (debitResponse.status === 400 || debitResponse.status === 403) {
      return reply({ error: "Kredit tidak dapat dipotong. Pastikan sesi dan saldo akun valid." }, 403, origin);
    }
    return reply({ error: "Hasil AI tersedia, tetapi pemotongan kredit gagal. Hubungi administrator sebelum mengulang.", detail: detail.slice(0, 300) }, 502, origin);
  }
  const remaining = await debitResponse.json();
  return reply({ output, model: GEMINI_MODEL, credits_remaining: Number(remaining) }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/generate") return generate(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "Payung AI Studio API", status: "online" }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};
