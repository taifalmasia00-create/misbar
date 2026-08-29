/* =========================================================
   مِسبار — منطق التطبيق
   1) يجيب محتوى الصفحة عبر خدمة قراءة نصية (بدون مشاكل CORS)
   2) (اختياري) يكتشف منافسين حقيقيين عبر بحث جوجل المدمج في Gemini
      ويقرا محتوى مواقعهم
   3) يبعت كل المحتوى لموديل Gemini ويطلب تقرير JSON منظم (يشمل
      مقارنة بالمنافسين لو موجودين)
   4) يعرض التقرير في الداشبورد
========================================================= */

const MODEL = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
const READER_PREFIX = "https://r.jina.ai/";
const STORAGE_KEY = "misbar_api_key";

const form = document.getElementById("analyze-form");
const urlInput = document.getElementById("site-url");
const heroForm = document.getElementById("quick-scan-form");
const heroUrlInput = document.getElementById("hero-url");
const apiKeyInput = document.getElementById("api-key");
const rememberBox = document.getElementById("remember-key");
const compareBox = document.getElementById("compare-competitors");
const toggleKeyBtn = document.getElementById("toggle-key");
const scanBtn = document.getElementById("scan-btn");
const scanBtnText = document.getElementById("scan-btn-text");
const statusBox = document.getElementById("status");
const report = document.getElementById("report");

// استرجاع مفتاح محفوظ سابقًا
const savedKey = localStorage.getItem(STORAGE_KEY);
if (savedKey) {
  apiKeyInput.value = savedKey;
  rememberBox.checked = true;
}

toggleKeyBtn.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleKeyBtn.textContent = showing ? "إظهار" : "إخفاء";
});

// زر الفحص السريع في الـ hero يمرر القيمة للفورم الرئيسي ويسكرول له
heroForm.addEventListener("submit", (e) => {
  e.preventDefault();
  urlInput.value = heroUrlInput.value;
  document.getElementById("analyze").scrollIntoView({ behavior: "smooth", block: "start" });
  apiKeyInput.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = normalizeUrl(urlInput.value.trim());
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showStatus("محتاج تدخل مفتاح Google AI Studio (Gemini) الأول عشان الأداة تشتغل.", "error");
    return;
  }

  if (rememberBox.checked) {
    localStorage.setItem(STORAGE_KEY, apiKey);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  setLoading(true);
  report.hidden = true;

  try {
    showStatus("بنقرأ محتوى الصفحة...", "loading");
    const pageText = await fetchPageContent(url);

    let competitors = [];
    if (compareBox && compareBox.checked) {
      try {
        showStatus("بندوّر على منافسين حقيقيين في نفس المجال...", "loading");
        const found = await findCompetitors(apiKey, url, pageText);

        if (found.length) {
          showStatus("بنقرا مواقع المنافسين (" + found.length + ")...", "loading");
          const withText = await Promise.all(
            found.map(async (c) => {
              try {
                const text = await fetchPageContent(c.url, 4000);
                return { ...c, text };
              } catch (e) {
                return { ...c, text: null };
              }
            })
          );
          // نستبعد أي منافس تعذّرت قراءة موقعه بالكامل
          competitors = withText.filter((c) => c.text);
        }
      } catch (e) {
        console.error("competitor discovery failed:", e);
        // فشل اكتشاف المنافسين مش لازم يوقف الفحص الأساسي — نكمل من غيرهم
        competitors = [];
      }
    }

    showStatus("بنحلل الموقع بالذكاء الاصطناعي...", "loading");
    const analysis = await runAnalysis(apiKey, url, pageText, competitors);

    renderReport(url, analysis);
    statusBox.hidden = true;
  } catch (err) {
    console.error(err);
    showStatus(friendlyError(err), "error");
  } finally {
    setLoading(false);
  }
});

function normalizeUrl(raw) {
  if (!/^https?:\/\//i.test(raw)) return "https://" + raw;
  return raw;
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
  if (msg.includes("400") || msg.includes("401") || msg.includes("403") || msg.includes("API_KEY_INVALID") || msg.includes("authentication")) {
    return "مفتاح الـ API مش صحيح أو مش مفعّل. تأكد منه من aistudio.google.com/apikey.";
  }
  if (msg.includes("no longer available") || (msg.includes("404") && msg.includes("model"))) {
    return "الموديل اللي بتستخدمه اتقفل من جوجل. حدّث ثابت MODEL في assets/app.js لأحدث موديل متاح (شوف ai.google.dev/gemini-api/docs/models).";
  }
  if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand")) {
    return "الموديل زحمة جدًا من كتر الطلب دلوقتي حتى بعد إعادة المحاولة. جرّب تاني بعد شوية.";
  }
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    return "تجاوزت الحد المجاني المسموح به مؤقتًا. استنى شوية وحاول تاني.";
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
  // نحدد الطول عشان ما نتجاوزش حدود السياق
  return text.slice(0, maxLen);
}

/* ---------- 2) اكتشاف منافسين حقيقيين عبر بحث جوجل المدمج في Gemini ---------- */
async function findCompetitors(apiKey, url, pageText) {
  const prompt = `أنت محلل سوق. المطلوب: ابحث فعليًا على الإنترنت عن 2 إلى 3 منافسين حقيقيين ومباشرين
لهذا الموقع، في نفس المجال والسوق (ولو ممكن نفس الدولة أو المنطقة):

رابط الموقع: ${url}
لمحة عن نشاطه (من محتوى الصفحة): ${pageText.slice(0, 1500)}

رجّع فقط مصفوفة JSON بالشكل ده بالظبط، بدون أي نص إضافي قبلها أو بعدها، وبدون Markdown code fences:
[{"name": "اسم الشركة المنافسة", "url": "https://رابط موقعها الرسمي"}]

اختار منافسين حقيقيين وموجودين فعليًا وفي نفس المجال، وتجنّب الشركات العالمية العملاقة إلا لو
كانت فعلاً منافس مباشر. لو معرفتش تلاقي منافسين حقيقيين، رجّع مصفوفة فاضية [].`;

  const res = await fetch(GEMINI_ENDPOINT(MODEL, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error("API " + res.status + ": " + errBody.slice(0, 200));
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0];
  const textPart =
    candidate &&
    candidate.content &&
    (candidate.content.parts || []).map((p) => p.text || "").join("");

  if (!textPart) return [];

  const list = extractJson(textPart, "array");
  if (!Array.isArray(list)) return [];

  return list
    .filter((c) => c && c.name && c.url)
    .slice(0, 3)
    .map((c) => ({ name: String(c.name), url: normalizeUrl(String(c.url).trim()) }));
}

/* استخراج JSON من رد قد يحتوي نص إضافي حول الكائن/المصفوفة المطلوبة */
function extractJson(text, kind) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // نحاول نلقط أول [ ... ] أو { ... } موجودة في النص
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
/* ---------- 3) تحليل عبر Google Gemini API (مجاني عبر AI Studio) ---------- */
async function runAnalysis(apiKey, url, pageText, competitors) {
  const hasCompetitors = Array.isArray(competitors) && competitors.length > 0;

  let system = `أنت خبير في تحليل المتاجر الإلكترونية والمواقع من ناحية التصميم وتجربة المستخدم والسيو والتحويل.
مهمتك: تحليل محتوى الصفحة المُرسلة لك وإرجاع تقرير بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، بدون Markdown code fences.
الصيغة المطلوبة بالضبط:
{
  "overall_score": رقم من 0 إلى 100,
  "summary": "ملخص من جملتين بالعربية عن الحالة العامة للموقع",
  "categories": [
    {"name": "التصميم والهوية", "score": رقم من 0 إلى 100},
    {"name": "تجربة المستخدم", "score": رقم من 0 إلى 100},
    {"name": "السيو والمحتوى", "score": رقم من 0 إلى 100},
    {"name": "عناصر الثقة", "score": رقم من 0 إلى 100},
    {"name": "قابلية التحويل", "score": رقم من 0 إلى 100}
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
      userMsg += `\n[منافس ${i + 1}] الاسم: ${c.name} — الرابط: ${c.url}\nمحتوى صفحته (نص مستخرج):\n${c.text || "(تعذّرت قراءة محتوى هذا الموقع)"}\n`;
    });
  }

  const requestBody = JSON.stringify({
    systemInstruction: {
      role: "system",
      parts: [{ text: system }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userMsg }],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: hasCompetitors ? 3000 : 1800,
      responseMimeType: "application/json",
    },
  });

  const MAX_ATTEMPTS = 3;
  let res, errBody;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(GEMINI_ENDPOINT(MODEL, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (res.ok) break;

    errBody = await res.text();
    const transient = res.status === 503 || res.status === 429 || res.status >= 500;
    if (!transient || attempt === MAX_ATTEMPTS) {
      throw new Error("API " + res.status + ": " + errBody.slice(0, 200));
    }
    // النموذج مزدحم مؤقتًا (503) أو تجاوزنا معدل الطلبات (429) — نعيد المحاولة بعد توقف قصير
    showStatus("الموديل مزدحم مؤقتًا، بنعيد المحاولة (" + attempt + "/" + MAX_ATTEMPTS + ")...", "loading");
    await sleep(1200 * attempt);
  }

  const data = await res.json();

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

  const cleaned = textPart.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("تعذّر تفسير رد النموذج كـ JSON.");
  }
}

/* ---------- 4) عرض التقرير ---------- */
function renderReport(url, data) {
  report.hidden = false;

  const score = clamp(Number(data.overall_score) || 0, 0, 100);
  document.getElementById("overall-score").textContent = Math.round(score);
  document.getElementById("report-title").textContent = "نتيجة تحليل " + hostOf(url);
  document.getElementById("report-summary-text").textContent = data.summary || "";

  const ring = document.getElementById("ring-fg");
  const circumference = 2 * Math.PI * 52; // ~327
  const offset = circumference - (score / 100) * circumference;
  ring.style.stroke = scoreColor(score);
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = offset;
  });

  const catGrid = document.getElementById("cat-grid");
  catGrid.innerHTML = "";
  (data.categories || []).forEach((cat) => {
    const s = clamp(Number(cat.score) || 0, 0, 100);
    const el = document.createElement("div");
    el.className = "cat-item";
    el.innerHTML = `
      <span class="cat-name">${escapeHtml(cat.name)}</span>
      <span class="cat-score" style="color:${scoreColor(s)}">${Math.round(s)}</span>
      <div class="cat-bar"><span style="width:${s}%; background:${scoreColor(s)}"></span></div>
    `;
    catGrid.appendChild(el);
  });

  fillList("strengths-list", data.strengths);
  fillList("weaknesses-list", data.weaknesses);

  const recoList = document.getElementById("recommendations-list");
  recoList.innerHTML = "";
  (data.recommendations || []).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
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

    grid.appendChild(card);
  });
}

function fillList(id, items) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  (items || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
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
