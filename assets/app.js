/* =========================================================
   مِسبار — منطق التطبيق
   1) يجيب محتوى الصفحة عبر خدمة قراءة نصية (بدون مشاكل CORS)
   2) (اختياري) يكتشف منافسين حقيقيين عبر بحث جوجل المدمج في Gemini
      ويقرا محتوى مواقعهم، مع سبب اختيار كل واحد فيهم
   3) يبعت كل المحتوى لموديل Gemini (عبر Worker بيخبي المفتاح)
      ويطلب تقرير JSON منظم
   4) يعرض التقرير في الداشبورد، وبيدي المستخدم إمكانية "يعترض"
      على أي نقطة ويطلب من الذكاء الاصطناعي يراجعها تاني
========================================================= */

// المسار بتاع الـ Worker اللي بيخبي مفتاح Gemini على السيرفر (شوف worker/README.md للنشر)
const WORKER_ENDPOINT = "https://misbar-proxy.YOUR-SUBDOMAIN.workers.dev/gemini";
const MODEL = "gemini-2.5-flash-lite";
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
  urlInput.value = heroUrlInput.value;
  document.getElementById("analyze").scrollIntoView({ behavior: "smooth", block: "start" });
  urlInput.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = normalizeUrl(urlInput.value.trim());
  if (!url) return;

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
          showStatus("بنقرا مواقع المنافسين (" + found.length + ")...", "loading");
          competitors = await Promise.all(
            found.map(async (c) => {
              try {
                const text = await fetchPageContent(c.url, 4000);
                return { ...c, text };
              } catch (e) {
                return { ...c, text: null };
              }
            })
          );
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
});

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
  if (msg.includes("الـ Worker مش متظبط")) return msg;
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
async function fetchPageContent(url, maxLen = 12000) {
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

/* ---------- استدعاء موحّد لـ Gemini عبر الـ Worker (بيخبي المفتاح ويتنقل بين مفتاحين) ---------- */
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
  const prompt = `أنت محلل سوق. المطلوب: ابحث فعليًا على الإنترنت عن 2 إلى 3 منافسين حقيقيين ومباشرين
لهذا الموقع، في نفس المجال والسوق (ولو ممكن نفس الدولة أو المنطقة):

رابط الموقع: ${url}
لمحة عن نشاطه (من محتوى الصفحة): ${pageText.slice(0, 1500)}

رجّع فقط مصفوفة JSON بالشكل ده بالظبط، بدون أي نص إضافي قبلها أو بعدها، وبدون Markdown code fences:
[{"name": "اسم الشركة المنافسة", "url": "https://رابط موقعها الرسمي", "reason": "جملة قصيرة توضح ليه ده يعتبر منافس مباشر فعلي (نفس المجال، نفس الجمهور، نفس نوع المنتج...)"}]

اختار منافسين حقيقيين وموجودين فعليًا وفي نفس المجال، وتجنّب الشركات العالمية العملاقة إلا لو
كانت فعلاً منافس مباشر. لو معرفتش تلاقي منافسين حقيقيين، رجّع مصفوفة فاضية [].`;

  const data = await callGeminiViaWorker({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1000 },
  });

  const textPart = extractTextPart(data);
  const list = extractJson(textPart, "array");
  return normalizeCompetitorsList(list);
}

/* محاولة احتياطية من غير أداة بحث جوجل — بتعتمد على معرفة الموديل العامة فقط */
async function findCompetitorsFallback(url, pageText) {
  const prompt = `أنت محلل سوق. بناءً على معرفتك العامة (من غير بحث حي على الإنترنت)، اقترح 2 إلى 3
منافسين حقيقيين ومعروفين ومباشرين لهذا الموقع، في نفس المجال والسوق:

رابط الموقع: ${url}
لمحة عن نشاطه (من محتوى الصفحة): ${pageText.slice(0, 1500)}

رجّع فقط مصفوفة JSON بالشكل ده بالظبط، بدون أي نص إضافي قبلها أو بعدها:
[{"name": "اسم الشركة المنافسة", "url": "https://رابط موقعها الرسمي", "reason": "جملة قصيرة توضح ليه ده يعتبر منافس مباشر فعلي"}]

لازم تكون شركات حقيقية موجودة فعليًا وتعرفها بثقة، مش أسماء مخترعة. لو مش متأكد من أي منافس
حقيقي، رجّع مصفوفة فاضية [].`;

  const data = await callGeminiViaWorker({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
    },
  });

  const textPart = extractTextPart(data);
  const list = extractJson(textPart, "array");
  return normalizeCompetitorsList(list);
}

function normalizeCompetitorsList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && c.name && c.url)
    .slice(0, 3)
    .map((c) => ({
      name: String(c.name),
      url: normalizeUrl(String(c.url).trim()),
      reason: c.reason ? String(c.reason) : "",
    }));
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

  let system = `أنت خبير في تحليل المتاجر الإلكترونية والمواقع من ناحية التصميم وتجربة المستخدم والسيو والتحويل.
مهمتك: تحليل محتوى الصفحة المُرسلة لك وإرجاع تقرير بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، بدون Markdown code fences.
الصيغة المطلوبة بالضبط:
{
  "overall_score": رقم من 0 إلى 100,
  "summary": "ملخص من جملتين بالعربية عن الحالة العامة للموقع",
  "categories": [
    {"name": "التصميم والهوية", "score": رقم من 0 إلى 100, "diagnosis": "جملة أو اتنين بتشرح تحديدًا ليه المحور ده أخد النتيجة دي بناءً على المحتوى الفعلي", "improvements": ["خطوة عملية محددة لتحسين المحور ده 1", "خطوة عملية 2", "خطوة عملية 3"]},
    {"name": "تجربة المستخدم", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "السيو والمحتوى", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "عناصر الثقة", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]},
    {"name": "قابلية التحويل", "score": رقم من 0 إلى 100, "diagnosis": "...", "improvements": ["...", "...", "..."]}
  ],
  "strengths": ["نقطة قوة 1", "نقطة قوة 2", "نقطة قوة 3"],
  "weaknesses": ["نقطة ضعف 1", "نقطة ضعف 2", "نقطة ضعف 3"],
  "recommendations": ["توصية عملية 1", "توصية عملية 2", "توصية عملية 3", "توصية عملية 4"]`;

  if (hasCompetitors) {
    system += `,
  "competitive_summary": "فقرة من 2-3 جمل تلخص الوضع التنافسي للموقع الأساسي مقارنة بكل المنافسين مجتمعين",
  "competitors": [
    {
      "name": "اسم المنافس بالظبط زي ما وصلك",
      "url": "رابطه بالظبط زي ما وصلك",
      "strengths": ["حاجة المنافس ده أحسن فيها من الموقع الأساسي 1", "حاجة تانية 2"],
      "weaknesses": ["حاجة المنافس ده أضعف فيها من الموقع الأساسي 1", "حاجة تانية 2"],
      "comparison": "جملة أو اتنين توضح مين أفضل بالظبط بين الموقع الأساسي وده وليه"
    }
  ]`;
  }

  system += `
}
اكتب كل النصوص بالعربية الفصحى البسيطة، وكن محددًا وواقعيًا بناءً على المحتوى الفعلي المُرسل، لا تخترع معلومات غير موجودة في النص.`;

  if (hasCompetitors) {
    system += `
مهم: احسب نقاط القوة والضعف الخاصة بالموقع الأساسي (strengths/weaknesses) بمعزل عن المنافسين — دي خاصة بيه لوحده.
أما داخل مصفوفة "competitors"، فقارن كل منافس بالموقع الأساسي تحديدًا، بناءً على المحتوى الفعلي المُرسل لكل موقع فقط.`;
  }

  let userMsg = `رابط الموقع الأساسي: ${url}\n\nمحتوى الصفحة الأساسية (نص مستخرج):\n${pageText}`;

  if (hasCompetitors) {
    userMsg += `\n\n---\nمواقع المنافسين اللي تحتاج تقارن الموقع الأساسي بيهم:\n`;
    competitors.forEach((c, i) => {
      userMsg += `\n[منافس ${i + 1}] الاسم: ${c.name} — الرابط: ${c.url}\nمحتوى صفحته (نص مستخرج):\n${c.text || "(تعذّرت قراءة محتوى هذا الموقع مباشرة — اعتمد في المقارنة على معرفتك العامة عن هذه الشركة ونشاطها بدل ما ترفض المقارنة)"}\n`;
    });
  }

  const requestBody = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userMsg }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: hasCompetitors ? 3800 : 2600,
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
  toggleBtn.textContent = "💬 مش موافق على النقطة دي؟";
  wrap.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.className = "challenge-panel";
  panel.hidden = true;
  panel.innerHTML = `
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
  (data.categories || []).forEach((cat, idx) => {
    const s = clamp(Number(cat.score) || 0, 0, 100);
    const color = scoreColor(s);
    const catId = "cat-details-" + idx;

    const el = document.createElement("div");
    el.className = "cat-item";
    el.innerHTML = `
      <button type="button" class="cat-toggle" aria-expanded="false" aria-controls="${catId}">
        <span class="cat-name">${escapeHtml(cat.name)}</span>
        <span class="cat-toggle-right">
          <span class="cat-score" style="color:${color}">${Math.round(s)}</span>
          <span class="cat-chevron" aria-hidden="true">▾</span>
        </span>
      </button>
      <div class="cat-bar"><span style="width:${s}%; background:${color}"></span></div>
      <div class="cat-details" id="${catId}" hidden></div>
    `;

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

  fillList("strengths-list", data.strengths, "نقطة قوة");
  fillList("weaknesses-list", data.weaknesses, "نقطة تحتاج تحسين");

  const recoList = document.getElementById("recommendations-list");
  recoList.innerHTML = "";
  (data.recommendations || []).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
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
    card.className = "competitor-card";

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

function fillList(id, items, claimLabel) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  (items || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    if (claimLabel) li.appendChild(buildChallengeWidget(claimLabel, item));
    ul.appendChild(li);
  });
}

function scoreColor(score) {
  if (score >= 75) return "#22E6C5";
  if (score >= 50) return "#FFB020";
  return "#FF5C72";
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
