const SUPABASE_URL = "https://mxseekqjwyrtkmjtyjun.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_3T4cxk_Yxvke5vsZU_g2pA_VlNO8gjD";
const ALLOWED_ORIGIN = "https://misba234.github.io";
const MODEL = "gemini-3.8-flash";
const ACTIONS = new Set(["social-content", "storyboard", "calendar"]);

function cors(origin) {
  const allowed = origin === ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request.headers.get("Origin") || "") });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin") || "";
  if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin tidak diizinkan." }, 403, origin);
  if (!env.GEMINI_API_KEY) return json({ error: "Konfigurasi Gemini belum lengkap. Secret runtime GEMINI_API_KEY belum dipasang." }, 503, origin);

  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Silakan login terlebih dahulu." }, 401, origin);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 24000) return json({ error: "Permintaan terlalu besar." }, 413, origin);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Format permintaan tidak valid." }, 400, origin);
  }

  const action = String(body.action || "");
  const prompt = String(body.prompt || "").trim();
  if (!ACTIONS.has(action)) return json({ error: "Jenis generator tidak dikenal." }, 400, origin);
  if (!prompt || prompt.length > 12000) return json({ error: "Prompt kosong atau terlalu panjang." }, 400, origin);

  const token = authorization.slice(7);
  const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + token }
  });
  if (!authResponse.ok) return json({ error: "Sesi login tidak valid. Silakan login ulang." }, 401, origin);
  const user = await authResponse.json();

  const creditResponse = await fetch(SUPABASE_URL + "/rest/v1/ai_credits?select=balance&user_id=eq." + encodeURIComponent(user.id), {
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + token }
  });
  if (!creditResponse.ok) return json({ error: "Tidak dapat memeriksa kredit AI." }, 502, origin);
  const creditRows = await creditResponse.json();
  const balance = Number(creditRows?.[0]?.balance ?? 0);
  if (balance < 1) return json({ error: "Kredit AI Anda habis." }, 402, origin);

  let geminiResponse;
  try {
    geminiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 6000 }
      })
    });
  } catch {
    return json({ error: "Tidak dapat menghubungi layanan Gemini. Kredit Anda tidak dipotong." }, 502, origin);
  }

  const geminiData = await geminiResponse.json().catch(() => ({}));
  if (!geminiResponse.ok) {
    const message = geminiData?.error?.message || "Gemini gagal memproses permintaan.";
    return json({ error: message, credits_remaining: balance }, 502, origin);
  }
  const output = (geminiData?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  if (!output) return json({ error: "Gemini tidak menghasilkan teks. Kredit Anda tidak dipotong." }, 502, origin);

  const debitResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/consume_ai_credit", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: user.id, p_action: action, p_model: MODEL })
  });
  if (!debitResponse.ok) return json({ error: "Hasil AI dibuat, tetapi pencatatan kredit gagal. Hubungi administrator sebelum mencoba ulang." }, 502, origin);
  const remaining = await debitResponse.json();
  return json({ output, model: MODEL, credits_remaining: Number(remaining) }, 200, origin);
}
