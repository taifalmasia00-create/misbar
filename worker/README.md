# نشر Worker مِسبار (يخبي مفتاح Gemini)

الملف `worker.js` ده بروكسي بسيط بيشتغل على Cloudflare Workers (فيه Free tier كفاية جدًا
لموقع شخصي). مفتاحين Gemini بتاعينك بيتخزّنوا كـ **Secrets** على السيرفر، مش في أي ملف
هتنشره — فمستخدمي الموقع مبيشوفوهمش خالص.

## الخطوات (أول مرة فقط، ~10 دقايق)

1. اعمل حساب مجاني على [dash.cloudflare.com](https://dash.cloudflare.com) لو مش عندك.
2. من جهازك (لازم Node.js متثبت):
   ```bash
   npm install -g wrangler
   wrangler login
   ```
   هيفتحلك المتصفح تسجّل دخول وتوافق.
3. جوه مجلد `worker/` شغّل:
   ```bash
   wrangler init --from-dash 2>/dev/null; true   # تجاهل الرسالة دي، هي احتياط بس
   ```
   أو ببساطة أنشئ ملف `wrangler.toml` بجوار `worker.js` بالمحتوى ده:
   ```toml
   name = "misbar-proxy"
   main = "worker.js"
   compatibility_date = "2024-01-01"
   ```
4. سجّل المفتاحين كـ Secrets (هيسألك تلصق كل مفتاح لوحده، مش هيتكتبوا في أي ملف):
   ```bash
   wrangler secret put GEMINI_API_KEY_1
   wrangler secret put GEMINI_API_KEY_2
   ```
5. انشر:
   ```bash
   wrangler deploy
   ```
   هياخدلك رابط زي:
   `https://misbar-proxy.<your-subdomain>.workers.dev`

6. افتح `assets/app.js` في موقع مِسبار، وحدّث السطر:
   ```js
   const WORKER_ENDPOINT = "https://misbar-proxy.YOUR-SUBDOMAIN.workers.dev/gemini";
   ```
   حط رابطك بالظبط (لازم يخلص بـ `/gemini`).

7. انشر الموقع نفسه زي ما هو موضح في `README.md` الرئيسي (GitHub Pages أو أي استضافة ثابتة).

## إزاي بيشتغل

- أي فحص من الموقع بيبعت طلب لـ `POST /gemini` على الـ Worker (بدون أي مفتاح في الطلب).
- الـ Worker بيجرب `GEMINI_API_KEY_1` الأول. لو رجع خطأ كوتة/صلاحية (429/403/RESOURCE_EXHAUSTED)،
  بيجرب `GEMINI_API_KEY_2` تلقائيًا من غير ما المستخدم يحس بحاجة.
- لو الموديل مزدحم مؤقتًا (503)، بيعيد المحاولة مرة على نفس المفتاح قبل ما ينتقل للمفتاح التاني.
- لو الاتنين فشلوا، بيرجع رسالة خطأ واضحة للموقع.

## تحديث أو تغيير المفاتيح لاحقًا

```bash
wrangler secret put GEMINI_API_KEY_1
```
هيستبدل القيمة القديمة بدون ما تحتاج تعمل deploy تاني.

## ملاحظة أمان

مهما كان، متكتبش المفتاحين نفسهم جوه `worker.js` أو أي ملف هترفعه على GitHub — استخدم
`wrangler secret put` بس زي ما هو موضح فوق. الملف ده مصمم عشان يفضل آمن حتى لو الريبو بتاعك عام.
