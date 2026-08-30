/* =========================================================
   مِسبار — منطق التطبيق
   1) يجيب محتوى الصفحة عبر خدمة قراءة نصية (بدون مشاكل CORS)
   2) (اختياري) يكتشف منافسين حقيقيين عبر بحث جوجل المدمج في Gemini
      ويقرا محتوى مواقعهم، مع سبب اختيار كل واحد فيهم
   3) يبعت كل المحتوى لموديل Gemini (عبر Supabase Edge Function بتخبي المفتاح)
      ويطلب تقرير JSON منظم
   4) يعرض التقرير في الداشبورد، وبيدي المستخدم إمكانية "يعترض"
      على أي نقطة ويطلب من الذكاء الاصطناعي يراجعها تاني
========================================================= */

// المسار بتاع Supabase Edge Function اللي بتخبي مفتاح Gemini على السيرفر
// (شوف supabase/README.md لخطوات النشر). الشكل العام:
// https://<project-ref>.supabase.co/functions/v1/gemini-proxy
const WORKER_ENDPOINT = "https://eydjkndgjoqtimkzdady.supabase.co/functions/v1/gemini-proxy";
const MODEL = "gemini-3.1-flash-lite";
const READER_PREFIX = "https://r.jina.ai/";

const form = document.getElementById("analyze-form");
const urlInput = document.getElementById("site-url");
const heroForm = document.getElementById("quick-scan-form");
const heroUrlInput = document.getElementById("hero-url");
const compareBox = document.getElementById("compare-competitors");
const scanBtn = document.getElementById("scan-btn");
const scanBtnText = document.getElementById("scan-btn-text");
const statusBox = document.getElementById("status");
const report = document.getElementById("report");

const heroMock = document.getElementById("hero-mock");
const heroBrowserUrl = document.getElementById("hero-browser-url");
const heroBrowserBody = document.getElementById("hero-browser-body");
const heroScreenshot = document.getElementById("hero-screenshot");
const heroBadgeEls = [1, 2, 3, 4].map((n) => document.getElementById("hero-badge-" + n));

// سياق آخر فحص متاح — بنستخدمه لما المستخدم يعترض على نقطة معينة ويطلب مراجعتها
const lastContext = { url: "", pageText: "", competitorsFound: [] };

heroForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalizeUrl(heroUrlInput.value.trim());
  if (!url) return;
  urlInput.value = heroUrlInput.value;
  document.getElementById("analyze").scrollIntoView({ behavior: "smooth", block: "start" });
  // مش بس بننزل تحت — الفحص لازم يبدأ فعليًا من غير ما المستخدم يحتاج يدوس زرار تاني
  runScan(url);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = normalizeUrl(urlInput.value.trim());
  if (!url) return;
  runScan(url);
});

async function runScan(url) {
  setLoading(true);
  report.hidden = true;
  resetHeroPreview();

  try {
    showStatus("بنقرأ محتوى الصفحة...", "loading");
    const pageText = await fetchPageContent(url);

    lastContext.url = url;
    lastContext.pageText = pageText;
    lastContext.competitorsFound = [];

    let competitors = [];
    let competitorsNote = "";
    if (compareBox && compareBox.checked) {
      try {
        showStatus("بندوّر على منافسين حقيقيين في نفس المجال...", "loading");
        const found = await findCompetitors(url, pageText);

        if (found.length) {
          lastContext.competitorsFound = found;
          showStatus("بنتأكد إن روابط المنافسين شغالة فعليًا (" + found.length + ")...", "loading");
          // نتأكد إن كل رابط منافس شغال وبيرجع محتوى حقيقي فعليًا قبل ما نعرضه.
          // لو الرابط مش شغال أو فاضي، منعرضوش خالص — أحسن من عرض رابط غلط أو منافس مش موجود.
          const verified = await Promise.all(
            found.map(async (c) => {
              try {
                const text = await fetchPageContent(c.url, 6000);
                if (!text || text.trim().length < 80) return null;
                if (looksLikeParkedOrDeadPage(text)) return null;
                if (!nameAppearsOnPage(c.name, text)) return null;
                return { ...c, text };
              } catch (e) {
                return null;
              }
            })
          );
          competitors = verified.filter(Boolean);

          if (!competitors.length) {
            competitorsNote = "لقينا أسماء منافسين محتملين لكن روابطهم معرفناش نتأكد منها فعليًا، فالتقرير هيبقى من غيرهم.";
          }
        } else {
          competitorsNote = "معرفناش نلاقي منافسين حقيقيين واضحين لموقعك، فالتقرير هيبقى من غيرهم.";
        }
      } catch (e) {
        console.error("competitor discovery failed:", e);
        competitors = [];
        competitorsNote = "حصلت مشكلة أثناء البحث عن المنافسين، فالتقرير هيبقى من غيرهم.";
      }
    }

    showStatus("بنحلل الموقع بالذكاء الاصطناعي...", "loading");
    const analysis = await runAnalysis(url, pageText, competitors);

    attachCompetitorReasons(analysis, competitors);

    renderReport(url, analysis);
    updateHeroPreview(url, analysis);
    if (competitorsNote) {
      showStatus(competitorsNote);
    } else {
      statusBox.hidden = true;
    }
  } catch (err) {
    console.error(err);
    showStatus(friendlyError(err), "error");
    if (heroBrowserBody) heroBrowserBody.classList.remove("is-scanning");
  } finally {
    setLoading(false);
  }
}

function normalizeUrl(raw) {
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return "https://" + raw;
  return raw;
}

function attachCompetitorReasons(analysis, competitorsWithText) {
  if (!analysis || !Array.isArray(analysis.competitors)) return;
  analysis.competitors.forEach((c) => {
    const match = competitorsWithText.find(
      (found) => found.url === c.url || (found.name && c.name && found.name.trim() === c.name.trim())
    );
    if (match && match.reason) c.reason = match.reason;
  });
}

function resetHeroPreview() {
  if (!heroMock) return;
  heroBrowserBody.classList.add("is-scanning");
}

function updateHeroPreview(url, data) {
  if (!heroMock) return;

  heroBrowserBody.classList.remove("is-scanning");
  heroBrowserUrl.textContent = hostOf(url);

  const shotUrl = "https://image.thum.io/get/width/900/crop/700/noanimate/" + url;
  heroScreenshot.onload = () => {
    heroBrowserBody.classList.add("has-screenshot");
    heroScreenshot.hidden = false;
  };
  heroScreenshot.onerror = () => {
    heroBrowserBody.classList.remove("has-screenshot");
    heroScreenshot.hidden = true;
  };
  heroScreenshot.src = shotUrl;

  const cats = (data.categories || []).slice(0, heroBadgeEls.length);
  heroBadgeEls.forEach((el, i) => {
    if (!el) return;
    const cat = cats[i];
    if (!cat) {
      el.hidden = true;
      return;
    }
    const labelEl = el.querySelector(".badge-label");
    const valueEl = el.querySelector("b");
    if (labelEl) labelEl.textContent = cat.name;
    if (valueEl) valueEl.textContent = Math.round(clamp(Number(cat.score) || 0, 0, 100));
    el.hidden = false;
    el.classList.remove("badge-updated");
    void el.offsetWidth;
    el.classList.add("badge-updated");
  });
}

/* بيتحقق إن الصفحة مش دومين متوقف/فاضي/قيد الإنشاء بدل ما تكون موقع شركة فعلي شغال */
function looksLikeParkedOrDeadPage(text) {
  const signals = [
    "domain may be for sale",
    "domain is for sale",
    "buy this domain",
    "this domain is parked",
    "coming soon",
    "under construction",
    "قيد الإنشاء",
    "الموقع تحت التطوير",
    "هذا النطاق للبيع",
    "index of /",
    "apache2 ubuntu default page",
    "welcome to nginx",
    "this site can't be reached",
    "404 not found",
    "account has been suspended",
  ];
  const lower = text.toLowerCase();
  // صفحة حقيقية بيبقى فيها محتوى كافي غالبًا؛ صفحة parked بتبقى قصيرة جدًا ومفيهاش غير
  // جملة أو اتنين، فبنجمع الطول القليل مع وجود عبارة من العبارات دي كإشارة أقوى
  const hasSignal = signals.some((s) => lower.includes(s));
  return hasSignal && text.trim().length < 600;
}

/* بيتأكد إن اسم الشركة اللي رجّعه الموديل فعليًا موجود في نص صفحتها — تحقق بسيط إن
   الرابط مش لموقع تاني مختلف تمامًا (حتى لو الرابط نفسه شغال وحقيقي) */
function nameAppearsOnPage(name, text) {
  if (!name) return true;
  const normalize = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[إأآا]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
      .trim();

  const normalizedText = normalize(text);
  const words = normalize(name)
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (!words.length) return true;
  // يكفي إن جزء مهم من الاسم (كلمة معتبرة أو أكتر) يكون موجود فعليًا في نص الصفحة
  return words.some((w) => normalizedText.includes(w));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setLoading(isLoading) {
  scanBtn.disabled = isLoading;
  scanBtnText.textContent = isLoading ? "جاري الفحص..." : "ابدأ الفحص";
}

function showStatus(msg, type) {
  statusBox.hidden = false;
  statusBox.textContent = msg;
  statusBox.className = "status" + (type ? " status-" + type : "");
}

function friendlyError(err) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes("الفنكشن مش متظبطة")) return msg;
  if (msg.includes("فشلت كل المفاتيح")) {
    return "الأداة وصلت لحد الاستخدام المجاني المتاح دلوقتي من الطرفين. جرّب تاني بعد شوية.";
  }
  if (msg.includes("400") || msg.includes("401") || msg.includes("403") || msg.includes("API_KEY_INVALID")) {
    return "في مشكلة في إعداد الأداة من ناحيتنا. جرّب تاني كمان شوية.";
  }
  if (msg.includes("no longer available") || (msg.includes("404") && msg.includes("model"))) {
    return "الموديل اللي بتستخدمه اتقفل من جوجل. حدّث ثابت MODEL في assets/app.js لأحدث موديل متاح.";
  }
  if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand")) {
    return "الموديل زحمة جدًا من كتر الطلب دلوقتي حتى بعد إعادة المحاولة. جرّب تاني بعد شوية.";
  }
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    return "تجاوزنا الحد المجاني المسموح به مؤقتًا. استنى شوية وحاول تاني.";
  }
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "في مشكلة اتصال. تأكد من الإنترنت أو من صحة الرابط وحاول تاني.";
  }
  if (msg.includes("قراءة الصفحة")) {
    return msg;
  }
  return "حصل خطأ أثناء الفحص: " + msg;
}

/* ---------- 1) قراءة محتوى الصفحة ---------- */
async function fetchPageContent(url, maxLen = 18000) {
  const readerUrl = READER_PREFIX + url;
  let res;
  try {
    res = await fetch(readerUrl, { headers: { "X-Return-Format": "text" } });
  } catch (e) {
    throw new Error("تعذّرت قراءة الصفحة، تأكد من صحة الرابط.");
  }
  if (!res.ok) {
    throw new Error("تعذّرت قراءة الصفحة (كود " + res.status + "). جرّب رابط تاني.");
  }
  const text = await res.text();
  return text.slice(0, maxLen);
}

/* ---------- استدعاء موحّد لـ Gemini عبر Supabase Edge Function (بتخبي المفتاح وتتنقل بين مفتاحين) ---------- */
async function callGeminiViaWorker(body) {
  let res;
  try {
    res = await fetch(WORKER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, body }),
    });
  } catch (e) {
    throw new Error("Failed to fetch: تعذّر الوصول لسيرفر الأداة.");
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("رد غير متوقع من سيرفر الأداة.");
  }

  if (!res.ok) {
    throw new Error(data.error || "API " + res.status);
  }
  return data;
}

function extractTextPart(data) {
  const candidate = (data.candidates || [])[0];
  const finishReason = candidate && candidate.finishReason;
  const textPart =
    candidate &&
    candidate.content &&
    (candidate.content.parts || []).map((p) => p.text || "").join("");

  if (!textPart) {
    if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
      throw new Error("النموذج رفض تحليل هذا الرابط لأسباب تتعلق بالمحتوى.");
    }
    throw new Error("لم يرجع النموذج أي رد نصي.");
  }
  return textPart;
}

/* ---------- 2) اكتشاف منافسين حقيقيين عبر بحث جوجل المدمج في Gemini ---------- */
async function findCompetitors(url, pageText) {
  let list = [];
  try {
    list = await findCompetitorsGrounded(url, pageText);
  } catch (e) {
    console.error("grounded competitor search failed:", e);
  }

  if (list.length) return list;

  try {
    return await findCompetitorsFallback(url, pageText);
  } catch (e) {
    console.error("fallback competitor search failed:", e);
    return [];
  }
}

async function findCompetitorsGrounded(url, pageText) {
  const prompt = `أنت محلل سوق محترف. المطلوب خطوتين بالترتيب:

الخطوة 1 — تحديد السوق المستهدف (فكّر فيها الأول، من غير ما تكتبها في الرد):
حدد بدقة من رابط الموقع ومحتوى صفحته: (أ) الدولة أو السوق الجغرافي اللي الموقع ده بيستهدفه
فعليًا — استنتجها من نطاق الدومين (.eg, .sa, .ae...)، اللغة/اللهجة، العملة المذكورة، أرقام
التليفون، العناوين، أو أي إشارة تانية في النص. (ب) الجمهور المستهدف بالظبط (نوع العميل،
شريحة السعر، حجم الشركة لو B2B... إلخ).

الخطوة 2 — البحث الفعلي:
ابحث فعليًا على الإنترنت عن 2 إلى 3 منافسين حقيقيين مباشرين، بشرط إنهم:
- بيشتغلوا وبيبيعوا فعليًا في نفس الدولة/السوق اللي حددتها في الخطوة 1 (مش بس نفس اللغة —
  لازم يكونوا فعليًا موجودين وبيخدموا نفس السوق الجغرافي).
- بيستهدفوا نفس شريحة الجمهور (نفس نوع العميل ونفس نطاق السعر تقريبًا، مش شركة فاخرة جدًا
  قصاد شركة اقتصادية مثلاً).
- مواقعهم شغالة فعليًا دلوقتي (مش دومين متوقف أو صفحة "قيد الإنشاء" أو موقع اتقفل).
- قبل ما تحط أي منافس في القائمة، اسأل نفسك: "هل عميل بيدور على نفس المنتج/الخدمة في نفس
  الدولة، ممكن فعليًا يقارن بين الموقعين دول قبل ما يشتري؟" لو الإجابة لأ، متحطوش خالص.

رابط الموقع: ${url}
لمحة عن نشاطه (من محتوى الصفحة): ${pageText.slice(0, 1500)}

رجّع فقط مصفوفة JSON بالشكل ده بالظبط، بدون أي نص إضافي قبلها أو بعدها، وبدون Markdown code fences:
[{"name": "اسم الشركة المنافسة", "url": "https://رابط موقعها الرسمي", "reason": "جملة توضح ليه ده منافس مباشر فعلي: نفس الدولة/السوق، نفس الجمهور والشريحة السعرية، ونفس نوع المنتج أو الخدمة بالظبط"}]

مهم جدًا بخصوص الروابط: استخدم فقط الرابط اللي شفته فعليًا في نتائج البحث اللي عملتها الآن،
حرفيًا زي ما هو من غير تعديل أو تخمين. ممنوع تكتب رابط من ذاكرتك أو تتوقعه بناءً على اسم الشركة.
لو بحثت عن شركة ومتأكد إنها منافس حقيقي بس مش متأكد 100% من الرابط الدقيق بتاعها من نتائج
البحث، استبعدها كلها بدل ما تخمن رابط ممكن يكون غلط.

تجنّب الشركات العالمية العملاقة إلا لو كانت فعلاً بتخدم نفس الدولة والجمهور بشكل مباشر ومباشر.
لو معرفتش تلاقي منافسين مستوفيين كل الشروط دي وواثق من روابطهم، رجّع مصفوفة فاضية [] —
أحسن بكتير من منافس مش مناسب أو رابط غير مؤكد.`;

  const data = await callGeminiViaWorker({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1300 },
  });

  const textPart = extractTextPart(data);
  const list = extractJson(textPart, "array");
  // بيانات الـ grounding بتحتوي الروابط الحقيقية اللي البحث رجّعها فعليًا،
  // بنستخدمها عشان نتأكد إن الموديل مش بيخترع رابط من عنده رغم إنه عمل بحث حقيقي.
  const groundingSources = extractGroundingSources(data);
  return normalizeCompetitorsList(list, groundingSources);
}

/* محاولة احتياطية من غير أداة بحث جوجل — بتعتمد على معرفة الموديل العامة فقط.
   ملحوظة: دي أقل موثوقية من الطريقة اللي بتستخدم بحث جوجل، فبنستخدمها بس لما البحث
   الحقيقي معرفش يلاقي حاجة، وبرضو بيتم التحقق من كل رابط فعليًا بعدين قبل ما يتعرض. */
async function findCompetitorsFallback(url, pageText) {
  const prompt = `أنت محلل سوق. بناءً على معرفتك العامة (من غير بحث حي على الإنترنت)، اقترح 2 إلى 3
منافسين حقيقيين ومعروفين ومباشرين لهذا الموقع:

رابط الموقع: ${url}
لمحة عن نشاطه (من محتوى الصفحة): ${pageText.slice(0, 1500)}

الشروط:
- لازم يكونوا بيشتغلوا فعليًا في نفس الدولة/السوق الجغرافي بتاع الموقع ده (استنتجها من
  الدومين، اللغة، العملة، أو أي إشارة تانية في النص) — مش بس نفس اللغة.
- لازم يستهدفوا نفس شريحة الجمهور ونفس نطاق السعر تقريبًا.
- لازم تكون شركات حقيقية موجودة فعليًا وواثق من رابطها الرسمي بثقة تامة، مش أسماء أو روابط
  مخترعة أو متوقعة.

رجّع فقط مصفوفة JSON بالشكل ده بالظبط، بدون أي نص إضافي قبلها أو بعدها:
[{"name": "اسم الشركة المنافسة", "url": "https://رابط موقعها الرسمي", "reason": "جملة توضح ليه ده منافس مباشر فعلي: نفس الدولة/السوق، نفس الجمهور، نفس نوع المنتج"}]

لو مش متأكد 100% من وجود المنافس أو من رابطه الدقيق، استبعده. أحسن ترجّع مصفوفة فاضية []
من إنك تحط منافس أو رابط مش متأكد منه.`;

  const data = await callGeminiViaWorker({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
    },
  });

  const textPart = extractTextPart(data);
  const list = extractJson(textPart, "array");
  return normalizeCompetitorsList(list);
}

/* بيرجع أسماء الدومينات الحقيقية اللي ظهرت في نتائج بحث جوجل المدمج مع الرد (لو موجودة) */
function extractGroundingSources(data) {
  const candidate = (data.candidates || [])[0];
  const chunks = (candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) || [];
  return chunks.map((c) => c && c.web && c.web.uri).filter(Boolean);
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

function normalizeCompetitorsList(list, groundingSources) {
  if (!Array.isArray(list)) return [];
  const groundedHosts = (groundingSources || []).map(hostnameOf).filter(Boolean);

  return list
    .filter((c) => c && c.name && c.url)
    .map((c) => {
      const url = normalizeUrl(String(c.url).trim());
      const host = hostnameOf(url);
      if (!host) return null;

      // لو عندنا نتائج بحث حقيقية اتعملت، لازم رابط المنافس يكون فعلاً جزء منها
      // (أو دومين فرعي/أب ليها) — وإلا الموديل يكون كتب رابط من عنده رغم إنه بحث،
      // فبنستبعده بدل ما نعرض رابط غلط أو غير موجود.
      if (groundedHosts.length) {
        const isGrounded = groundedHosts.some(
          (h) => h === host || host.endsWith("." + h) || h.endsWith("." + host)
        );
        if (!isGrounded) return null;
      }

      return {
        name: String(c.name),
        url,
        reason: c.reason ? String(c.reason) : "",
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/* استخراج JSON من رد قد يحتوي نص إضافي حول الكائن/المصفوفة المطلوبة */
function extractJson(text, kind) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const open = kind === "array" ? "[" : "{";
    const close = kind === "array" ? "]" : "}";
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

/* ---------- 3) تحليل عبر Google Gemini API (عن طريق الـ Worker) ---------- */
async function runAnalysis(url, pageText, competitors) {
  const hasCompetitors = Array.isArray(competitors) && competitors.length > 0;

  let system = `أنت خبير محترف في تحليل المتاجر الإلكترونية والمواقع من ناحية التصميم وتجربة المستخدم والسيو والتحويل،
وعندك خبرة عملية طويلة في تدقيق مواقع حقيقية. مهمتك تحليل نص الصفحة المُرسل لك بعمق وبدقة،
مش تلخيصه بشكل عام. اقرأ النص المُرسل بالكامل (مش بس أول كام سطر) قبل ما تحكم على أي محور.

قواعد صارمة لازم تتبعها في كل نقطة من التقرير:
1. أي "diagnosis" أو نقطة قوة/ضعف أو توصية لازم تكون مبنية على دليل محدد وحقيقي من النص المُرسل
   فعليًا — زي عنوان معين موجود، جملة تسويقية، غياب عنصر معين (رقم تليفون، عنوان، سياسة استرجاع،
   شهادات عملاء، وصف منتج، دعوة لاتخاذ إجراء)، طول النص، تكرار كلمات معينة... إلخ. اذكر الدليل
   ده بنفسك جوه النص اللي بتكتبه (مش بس "التصميم كويس" من غير سبب).
2. ممنوع تمامًا الكلام العام اللي ينطبق على أي موقع في العالم زي "حسّن السيو" أو "خلي الموقع أوضح"
   من غير ما تحدد بالظبط إيه اللي ناقص أو غلط في المحتوى ده تحديدًا.
3. غطّي كل محور من الخمسة بشكل مستقل وكامل — متسيبش محور بتشخيص سطحي عشان ركزت في محور تاني.
4. لو معلومة معينة مش موجودة في النص المُرسل خالص (زي السرعة الفعلية أو تفاصيل بصرية مش موجودة
   كنص)، منها متحكمش عليها بالتخمين — قول إنها مش واضحة من النص المتاح بدل ما تخترع رقم أو حكم.
5. التوصيات لازم تكون كل وحدة فيها مرتبطة بنقطة ضعف محددة اتذكرت فعليًا، وقابلة للتنفيذ (خطوة
   واضحة، مش نصيحة عامة).

مهمتك: إرجاع تقرير بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، بدون Markdown code fences.
الصيغة المطلوبة بالضبط:
{
  "overall_score": رقم من 0 إلى 100,
  "summary": "ملخص من جملتين بالعربية عن الحالة العامة للموقع، مبني على أهم حاجة لاحظتها فعليًا",
  "categories": [
    {"name": "التصميم والهوية", "score": رقم من 0 إلى 100, "diagnosis": "شرح محدد ومبني على دليل فعلي من النص ليه المحور ده أخد النتيجة دي", "improvements": ["خطوة عملية محددة ومرتبطة بالتشخيص 1", "خطوة عملية 2", "خطوة عملية 3"]},
    {"name": "تجربة المستخدم", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "السيو والمحتوى", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "عناصر الثقة", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "قابلية التحويل", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]}
  ],
  "strengths": ["نقطة قوة محددة ومبنية على دليل فعلي 1", "نقطة قوة 2", "نقطة قوة 3"],
  "weaknesses": ["نقطة ضعف محددة ومبنية على دليل فعلي 1", "نقطة ضعف 2", "نقطة ضعف 3"],
  "recommendations": ["توصية عملية مرتبطة بنقطة ضعف محددة 1", "توصية عملية 2", "توصية عملية 3", "توصية عملية 4"]`;

  if (hasCompetitors) {
    system += `,
  "competitive_summary": "فقرة من 2-3 جمل تلخص الوضع التنافسي للموقع الأساسي مقارنة بكل المنافسين مجتمعين، مبنية على مقارنة فعلية للمحتوى",
  "competitors": [
    {
      "name": "اسم المنافس بالظبط زي ما وصلك",
      "url": "رابطه بالظبط زي ما وصلك",
      "strengths": ["حاجة محددة المنافس ده أحسن فيها فعليًا من الموقع الأساسي، بدليل من محتوى صفحته 1", "حاجة تانية 2"],
      "weaknesses": ["حاجة محددة المنافس ده أضعف فيها فعليًا من الموقع الأساسي 1", "حاجة تانية 2"],
      "comparison": "جملة أو اتنين توضح مين أفضل بالظبط بين الموقع الأساسي وده وليه، بناءً على مقارنة فعلية للمحتوى"
    }
  ]`;
  }

  system += `
}
اكتب كل النصوص بالعربية الفصحى البسيطة، وكن محددًا وواقعيًا بناءً على المحتوى الفعلي المُرسل فقط، لا تخترع معلومات غير موجودة في النص.`;

  if (hasCompetitors) {
    system += `
مهم: احسب نقاط القوة والضعف الخاصة بالموقع الأساسي (strengths/weaknesses) بمعزل عن المنافسين — دي خاصة بيه لوحده.
أما داخل مصفوفة "competitors"، فقارن كل منافس بالموقع الأساسي تحديدًا بناءً على المحتوى الفعلي المُرسل لكل موقع فقط —
كل نقطة قوة أو ضعف للمنافس لازم يكون ليها دليل واضح من نص صفحته الفعلي، مش افتراض عام عن الشركة.`;
  }

  let userMsg = `رابط الموقع الأساسي: ${url}\n\nمحتوى الصفحة الأساسية (نص مستخرج بالكامل، اقرأه كله):\n${pageText}`;

  if (hasCompetitors) {
    userMsg += `\n\n---\nمواقع المنافسين اللي تحتاج تقارن الموقع الأساسي بيهم (كل النصوص دي حقيقية ومستخرجة فعليًا من مواقعهم):\n`;
    competitors.forEach((c, i) => {
      userMsg += `\n[منافس ${i + 1}] الاسم: ${c.name} — الرابط: ${c.url}\nمحتوى صفحته (نص مستخرج):\n${c.text}\n`;
    });
  }

  const requestBody = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userMsg }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: hasCompetitors ? 5200 : 3600,
      responseMimeType: "application/json",
    },
  };

  const data = await callGeminiViaWorker(requestBody);
  const textPart = extractTextPart(data);
  const cleaned = textPart.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("تعذّر تفسير رد النموذج كـ JSON.");
  }
}

/* ---------- 3.5) مراجعة نقطة معينة لو المستخدم شايف إنها مش صح ---------- */
async function askAboutClaim(claimLabel, claimText, userNote) {
  const prompt = `أنت مراجع تدقيق مستقل. معاك تحليل سابق لموقع اتعمل بناءً على محتوى صفحته الفعلي.
المستخدم (صاحب الموقع أو حد بيراجع التحليل) شايف إن نقطة معينة من التحليل ممكن تكون غير دقيقة،
وعايز رأي تاني فيها بناءً على نفس المحتوى الفعلي.

رابط الموقع: ${lastContext.url}
محتوى الصفحة الفعلي (نفس النص اللي اتحلل عليه الموقع، مقتطف): ${lastContext.pageText.slice(0, 4000)}

النقطة المتنازع عليها من التحليل: "${claimLabel}: ${claimText}"
اعتراض/ملاحظة المستخدم: "${userNote}"

راجع النقطة دي بحياد تام بناءً على المحتوى الفعلي بس، من غير ما تنحاز لأي طرف. رجّع فقط JSON
بدون أي نص إضافي وبدون Markdown fences بالشكل ده:
{"verdict": "agree" أو "disagree" أو "partial", "explanation": "شرح واضح ومختصر (2-3 جمل) بالعربية ليه رأيك كده، وهل التحليل الأصلي كان دقيق فعلاً ولا لأ بناءً على المحتوى"}
verdict = "agree" يعني بتتفق مع اعتراض المستخدم (التحليل الأصلي كان غلط أو غير دقيق).
verdict = "disagree" يعني التحليل الأصلي كان صح واعتراض المستخدم مش له أساس في المحتوى.
verdict = "partial" يعني في جزء صح وجزء محتاج توضيح.`;

  const data = await callGeminiViaWorker({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 500,
      responseMimeType: "application/json",
    },
  });

  const textPart = extractTextPart(data);
  const parsed = extractJson(textPart, "object");
  if (!parsed || !parsed.verdict) {
    throw new Error("تعذّر تفسير رد المراجعة.");
  }
  return parsed;
}

/* ودجت "اعتراض على نتيجة" بيتحط جنب أي نقطة في التقرير */
function buildChallengeWidget(claimLabel, claimText) {
  const wrap = document.createElement("div");
  wrap.className = "challenge";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "challenge-toggle";
  toggleBtn.textContent = "؟";
  toggleBtn.title = "مش موافق على النقطة دي؟ اسأل الذكاء الاصطناعي يراجعها";
  toggleBtn.setAttribute("aria-label", "مش موافق على النقطة دي؟ اسأل الذكاء الاصطناعي يراجعها");
  wrap.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.className = "challenge-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <span class="challenge-panel-label">مش متفق مع النقطة دي؟</span>
    <textarea class="challenge-input" rows="2" placeholder="اكتب ليه شايف إن النقطة دي مش صح..."></textarea>
    <button type="button" class="challenge-submit link-btn">اسأل الذكاء الاصطناعي يراجعها</button>
    <div class="challenge-result" hidden></div>
  `;
  wrap.appendChild(panel);

  const textarea = panel.querySelector(".challenge-input");
  const submitBtn = panel.querySelector(".challenge-submit");
  const resultBox = panel.querySelector(".challenge-result");

  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) textarea.focus();
  });

  submitBtn.addEventListener("click", async () => {
    const note = textarea.value.trim();
    if (!note) {
      textarea.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "بنراجع...";
    resultBox.hidden = true;

    try {
      const verdict = await askAboutClaim(claimLabel, claimText, note);
      resultBox.hidden = false;
      resultBox.className =
        "challenge-result challenge-" +
        (verdict.verdict === "agree" ? "agree" : verdict.verdict === "partial" ? "partial" : "disagree");
      const verdictLabel =
        verdict.verdict === "agree"
          ? "الذكاء الاصطناعي بيتفق مع ملاحظتك"
          : verdict.verdict === "partial"
          ? "في جزء صح من ملاحظتك"
          : "الذكاء الاصطناعي لسه شايف إن التحليل الأصلي صح";
      resultBox.innerHTML = `<b>${escapeHtml(verdictLabel)}</b><p>${escapeHtml(verdict.explanation || "")}</p>`;
    } catch (e) {
      resultBox.hidden = false;
      resultBox.className = "challenge-result challenge-error";
      resultBox.textContent = friendlyError(e);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "اسأل الذكاء الاصطناعي يراجعها";
    }
  });

  return wrap;
}

/* ---------- 4) عرض التقرير ---------- */

/* نفس أيقونات محاور التحليل الظاهرة في قسم "ماذا نفحص" بالصفحة الرئيسية —
   بنكررها هنا في التقرير عشان يفضل في هوية بصرية واحدة متسقة في الموقع كله */
const CATEGORY_ICONS = {
  "التصميم والهوية": "UI",
  "تجربة المستخدم": "UX",
  "السيو والمحتوى": "SEO",
  "عناصر الثقة": "TR",
  "قابلية التحويل": "CVR",
};
const CATEGORY_ICON_FALLBACK = ["UI", "UX", "SEO", "TR", "CVR"];
function categoryIcon(name, idx) {
  return CATEGORY_ICONS[name] || CATEGORY_ICON_FALLBACK[idx] || "•";
}

function renderReport(url, data) {
  report.hidden = false;

  const score = clamp(Number(data.overall_score) || 0, 0, 100);
  document.getElementById("overall-score").textContent = Math.round(score);
  document.getElementById("report-title").textContent = "نتيجة تحليل " + hostOf(url);
  document.getElementById("report-summary-text").textContent = data.summary || "";

  const ring = document.getElementById("ring-fg");
  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (score / 100) * circumference;
  ring.style.stroke = scoreColor(score);
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = offset;
  });

  const catGrid = document.getElementById("cat-grid");
  catGrid.innerHTML = "";
  const catCircumference = 2 * Math.PI * 22;
  const ringsToAnimate = [];

  (data.categories || []).forEach((cat, idx) => {
    const s = clamp(Number(cat.score) || 0, 0, 100);
    const color = scoreColor(s);
    const catId = "cat-details-" + idx;
    const ringId = "cat-ring-fg-" + idx;
    const icon = categoryIcon(cat.name, idx);

    const el = document.createElement("div");
    el.className = "cat-item bracket-frame";
    el.innerHTML = `
      <button type="button" class="cat-toggle" aria-expanded="false" aria-controls="${catId}">
        <span class="cat-gauge">
          <svg viewBox="0 0 56 56" width="56" height="56">
            <circle cx="28" cy="28" r="22" class="cat-ring-bg"/>
            <circle cx="28" cy="28" r="22" class="cat-ring-fg" id="${ringId}" style="stroke:${color}"/>
          </svg>
          <span class="cat-gauge-num" style="color:${color}">${Math.round(s)}</span>
        </span>
        <span class="cat-copy">
          <span class="cat-icon-tag">${icon}</span>
          <span class="cat-name">${escapeHtml(cat.name)}</span>
        </span>
        <span class="cat-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="cat-details" id="${catId}" hidden></div>
    `;

    const ringFg = el.querySelector("#" + ringId);
    ringFg.style.strokeDasharray = catCircumference;
    ringFg.style.strokeDashoffset = catCircumference;
    ringsToAnimate.push({ el: ringFg, offset: catCircumference - (s / 100) * catCircumference, delay: idx * 90 });

    const detailsEl = el.querySelector(".cat-details");
    const hasDetails = cat.diagnosis || (cat.improvements && cat.improvements.length);
    if (hasDetails) {
      let detailsHtml = "";
      if (cat.diagnosis) {
        detailsHtml += `<p class="cat-diagnosis">${escapeHtml(cat.diagnosis)}</p>`;
      }
      if (cat.improvements && cat.improvements.length) {
        detailsHtml += `<h5>إزاي تحسّنه</h5><ul>${cat.improvements
          .map((imp) => `<li>${escapeHtml(imp)}</li>`)
          .join("")}</ul>`;
      }
      detailsEl.innerHTML = detailsHtml;

      if (cat.diagnosis) {
        detailsEl.appendChild(buildChallengeWidget(cat.name, cat.diagnosis));
      }

      const toggleBtn = el.querySelector(".cat-toggle");
      toggleBtn.addEventListener("click", () => {
        const isOpen = el.classList.contains("cat-item-open");
        el.classList.toggle("cat-item-open", !isOpen);
        detailsEl.hidden = isOpen;
        toggleBtn.setAttribute("aria-expanded", String(!isOpen));
      });
    } else {
      el.querySelector(".cat-toggle").classList.add("cat-toggle-static");
    }

    catGrid.appendChild(el);
  });

  requestAnimationFrame(() => {
    ringsToAnimate.forEach(({ el, offset, delay }) => {
      setTimeout(() => {
        el.style.strokeDashoffset = offset;
      }, delay);
    });
  });

  fillList("strengths-list", data.strengths, "li-icon-good", "✓", "نقطة قوة");
  fillList("weaknesses-list", data.weaknesses, "li-icon-bad", "!", "نقطة تحتاج تحسين");

  const recoList = document.getElementById("recommendations-list");
  recoList.innerHTML = "";
  (data.recommendations || []).forEach((r, idx) => {
    const li = document.createElement("li");
    const numSpan = document.createElement("span");
    numSpan.className = "reco-num";
    numSpan.textContent = String(idx + 1);
    const textSpan = document.createElement("span");
    textSpan.className = "reco-text";
    textSpan.textContent = r;
    li.appendChild(numSpan);
    li.appendChild(textSpan);
    li.appendChild(buildChallengeWidget("توصية", r));
    recoList.appendChild(li);
  });

  renderCompetitors(data.competitors, data.competitive_summary);

  report.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCompetitors(competitors, summary) {
  const block = document.getElementById("competitors-block");
  const grid = document.getElementById("competitors-grid");
  const summaryEl = document.getElementById("competitors-summary");

  if (!Array.isArray(competitors) || competitors.length === 0) {
    block.hidden = true;
    return;
  }

  block.hidden = false;
  summaryEl.textContent = summary || "";
  grid.innerHTML = "";

  competitors.forEach((c) => {
    const card = document.createElement("div");
    card.className = "competitor-card bracket-frame";

    const safeUrl = /^https?:\/\//i.test(c.url || "") ? c.url : "";
    const linkHtml = safeUrl
      ? `<a class="competitor-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(hostOf(safeUrl))}</a>`
      : "";

    card.innerHTML = `
      <div class="competitor-head">
        <span class="competitor-name">${escapeHtml(c.name || "منافس")}</span>
        ${linkHtml}
      </div>
      ${c.reason ? `<p class="competitor-reason"><b>ليه اخترناه؟</b> ${escapeHtml(c.reason)}</p>` : ""}
      ${c.comparison ? `<p class="competitor-comparison">${escapeHtml(c.comparison)}</p>` : ""}
      <div class="competitor-lists">
        <div class="competitor-strengths">
          <h5>نقاط قوته مقارنة بيك</h5>
          <ul></ul>
        </div>
        <div class="competitor-weaknesses">
          <h5>نقاط ضعفه مقارنة بيك</h5>
          <ul></ul>
        </div>
      </div>
    `;

    const strengthsUl = card.querySelector(".competitor-strengths ul");
    (c.strengths || []).forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      strengthsUl.appendChild(li);
    });

    const weaknessesUl = card.querySelector(".competitor-weaknesses ul");
    (c.weaknesses || []).forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      weaknessesUl.appendChild(li);
    });

    if (c.comparison) {
      card.appendChild(buildChallengeWidget("مقارنة مع " + (c.name || "المنافس"), c.comparison));
    }

    grid.appendChild(card);
  });
}

function fillList(id, items, iconClass, iconChar, claimLabel) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  (items || []).forEach((item) => {
    const li = document.createElement("li");

    const icon = document.createElement("span");
    icon.className = "li-icon " + iconClass;
    icon.textContent = iconChar;
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "li-text";
    text.textContent = item;

    li.appendChild(icon);
    li.appendChild(text);
    if (claimLabel) li.appendChild(buildChallengeWidget(claimLabel, item));
    ul.appendChild(li);
  });
}

function scoreColor(score) {
  if (score >= 75) return "#55B189"; // good — أخضر مطفّي
  if (score >= 50) return "#D98C3D"; // medium — نحاسي/برتقالي
  return "#E2665B"; // poor — أحمر مرجاني
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
