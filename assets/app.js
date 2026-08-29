/* =========================================================
   مِسبار — منطق التطبيق
   1) يجيب محتوى الصفحة عبر خدمة قراءة نصية (بدون مشاكل CORS)
   2) يبعت المحتوى لموديل Claude ويطلب تقرير JSON منظم
   3) يعرض التقرير في الداشبورد
========================================================= */

const MODEL = "gemini-2.5-flash";
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

    showStatus("بنحلل الموقع بالذكاء الاصطناعي...", "loading");
    const analysis = await runAnalysis(apiKey, url, pageText);

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
async function fetchPageContent(url) {
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
  return text.slice(0, 12000);
}

/* ---------- 2) تحليل عبر Google Gemini API (مجاني عبر AI Studio) ---------- */
async function runAnalysis(apiKey, url, pageText) {
  const system = `أنت خبير في تحليل المتاجر الإلكترونية والمواقع من ناحية التصميم وتجربة المستخدم والسيو والتحويل.
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
  "recommendations": ["توصية عملية 1", "توصية عملية 2", "توصية عملية 3", "توصية عملية 4"]
}
اكتب كل النصوص بالعربية الفصحى البسيطة، وكن محددًا وواقعيًا بناءً على المحتوى الفعلي المُرسل، لا تخترع معلومات غير موجودة في النص.`;

  const userMsg = `رابط الموقع: ${url}\n\nمحتوى الصفحة (نص مستخرج):\n${pageText}`;

  const res = await fetch(GEMINI_ENDPOINT(MODEL, apiKey), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
        maxOutputTokens: 1800,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error("API " + res.status + ": " + errBody.slice(0, 200));
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

/* ---------- 3) عرض التقرير ---------- */
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

  report.scrollIntoView({ behavior: "smooth", block: "start" });
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
