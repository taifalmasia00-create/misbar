// =========================================================
// مِسبار — Supabase Edge Function
// بروكسي بسيط بين الموقع و Gemini API.
// المفتاحين مش مكتوبين هنا خالص — بيتقروا وقت التشغيل من
// Secrets اسمها GEMINI_API_KEY_1 و GEMINI_API_KEY_2، تحطهم
// إنت عبر أمر `supabase secrets set` (شوف supabase/README.md
// لخطوات النشر). لو مفتاح رجع خطأ كوتة/صلاحية، الفنكشن تجرب
// المفتاح التاني تلقائيًا من غير ما المستخدم يحس بحاجة.
// =========================================================

const ALLOWED_ORIGIN = "*"; // لو عايز تقفلها على دومين موقعك بس، غيّرها لـ "https://username.github.io"

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

/* أخطاء بتستاهل نجرب المفتاح التاني أو نعيد المحاولة عليها */
function isKeyOrQuotaError(status: number, bodyText: string) {
  if (status === 401 || status === 403 || status === 429) return true;
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(bodyText)) return true;
  if (/RESOURCE_EXHAUSTED/i.test(bodyText)) return true;
  return false;
}

function isTransientError(status: number) {
  return status === 503 || status >= 500;
}

async function callGemini(model: string, apiKey: string, requestBody: unknown) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ error: "الطريقة غير مدعومة، استخدم POST." }, 405);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: "جسم الطلب مش JSON صالح." }, 400);
  }

  const { model, body } = payload || {};
  if (!model || !body) {
    return json({ error: "محتاجين model و body في الطلب." }, 400);
  }

  // المفاتيح دي Secrets مربوطة بالمشروع وقت النشر، مش مكتوبة في الكود
  const keys = [Deno.env.get("GEMINI_API_KEY_1"), Deno.env.get("GEMINI_API_KEY_2")].filter(
    Boolean
  ) as string[];

  if (keys.length === 0) {
    return json(
      {
        error:
          "الفنكشن مش متظبطة لسه — لازم تضيف Secrets باسم GEMINI_API_KEY_1 و GEMINI_API_KEY_2 عبر supabase secrets set.",
      },
      500
    );
  }

  let lastStatus = 500;
  let lastText = "حصل خطأ غير متوقع.";

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const apiKey = keys[keyIndex];

    // محاولتين لنفس المفتاح لو الخطأ مؤقت (503/زحمة)، بعدين ننتقل للمفتاح التاني
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await callGemini(model, apiKey, body);

      if (result.ok) {
        return new Response(result.text, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      lastStatus = result.status;
      lastText = result.text;

      if (isKeyOrQuotaError(result.status, result.text)) {
        // نطلع من لوب المحاولات على نفس المفتاح، ونجرب المفتاح التاني في اللوب الخارجي
        break;
      }

      if (isTransientError(result.status) && attempt === 1) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      // خطأ تاني (زي طلب غلط) مش هيتحل بتغيير المفتاح — نرجعه على طول
      return json({ error: `API ${result.status}: ${result.text.slice(0, 300)}` }, 502);
    }
  }

  // كل المفاتيح فشلت (كوتة/صلاحية/زحمة مستمرة)
  return json(
    { error: `فشلت كل المفاتيح المتاحة. آخر خطأ (${lastStatus}): ${lastText.slice(0, 300)}` },
    502
  );
});
