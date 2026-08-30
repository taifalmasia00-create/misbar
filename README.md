# نشر Edge Function مِسبار على Supabase (يخبي مفتاح Gemini)

الفنكشن دي (`functions/gemini-proxy/index.ts`) بروكسي بسيط بيشتغل على **Supabase Edge
Functions** (مبنية على Deno، وفيها Free tier كفاية جدًا لموقع شخصي). مفتاحين Gemini
بتاعينك بيتخزّنوا كـ **Secrets** على مشروع Supabase، مش في أي ملف هتنشره — فمستخدمي
الموقع مبيشوفوهمش خالص.

## الخطوات (أول مرة فقط، ~10 دقايق)

1. اعمل حساب مجاني على [supabase.com](https://supabase.com) لو مش عندك، وأنشئ **مشروع
   جديد** (Organization + Project) من الداشبورد. هتحتاج كلمة سر لقاعدة البيانات، بس
   إحنا مش هنستخدم قاعدة بيانات هنا أصلًا — بس الخطوة مطلوبة عشان ينشئ المشروع.
2. من جهازك (لازم Node.js متثبت)، ثبّت الـ CLI بتاع Supabase:
   ```bash
   npm install -g supabase
   ```
3. سجّل دخولك:
   ```bash
   supabase login
   ```
   هيفتحلك المتصفح تسجّل دخول وتوافق.
4. اربط مجلد المشروع (`misbar/`) بمشروع Supabase بتاعك. هتلاقي الـ **Project Ref**
   (سلسلة حروف وأرقام) في رابط الداشبورد أو من **Project Settings → General**:
   ```bash
   cd misbar
   supabase link --project-ref YOUR_PROJECT_REF
   ```
5. سجّل المفتاحين كـ Secrets (بيتخزّنوا مشفّرين على السيرفر، مش في أي ملف):
   ```bash
   supabase secrets set GEMINI_API_KEY_1=المفتاح_الأول
   supabase secrets set GEMINI_API_KEY_2=المفتاح_الثاني
   ```
6. انشر الفنكشن. **مهم:** لازم تستخدم `--no-verify-jwt` عشان الموقع (اللي مفيهوش تسجيل
   دخول) يقدر ينادي الفنكشن مباشرة من غير ما يبعت مفتاح Supabase:
   ```bash
   supabase functions deploy gemini-proxy --no-verify-jwt
   ```
   هياخدلك رابط زي:
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-proxy`

7. افتح `assets/app.js` في موقع مِسبار، وحدّث السطر:
   ```js
   const WORKER_ENDPOINT = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-proxy";
   ```
   حط رابطك بالظبط (لازم يخلص بـ `/gemini-proxy`).

8. انشر الموقع نفسه زي ما هو موضح في `README.md` الرئيسي (GitHub Pages أو أي استضافة
   ثابتة).

## إزاي بيشتغل

- أي فحص من الموقع بيبعت طلب `POST` مباشرة لرابط الفنكشن (بدون أي مفتاح في الطلب).
- الفنكشن بتجرب `GEMINI_API_KEY_1` الأول. لو رجع خطأ كوتة/صلاحية
  (429/403/RESOURCE_EXHAUSTED)، بتجرب `GEMINI_API_KEY_2` تلقائيًا من غير ما المستخدم
  يحس بحاجة.
- لو الموديل مزدحم مؤقتًا (503)، بتعيد المحاولة مرة على نفس المفتاح قبل ما تنتقل
  للمفتاح التاني.
- لو الاتنين فشلوا، بترجع رسالة خطأ واضحة للموقع.

## تحديث أو تغيير المفاتيح لاحقًا

```bash
supabase secrets set GEMINI_API_KEY_1=مفتاح_جديد
```
مفيش داعي تعمل `deploy` تاني بعد تغيير الـ Secrets؛ الفنكشن بتقرأها تلقائيًا في أول
طلب جاي.

## لو عايز تعدّل كود الفنكشن نفسه

بعد أي تعديل في `functions/gemini-proxy/index.ts`، لازم تعيد النشر عشان التعديل يتفعّل:
```bash
supabase functions deploy gemini-proxy --no-verify-jwt
```

## ملاحظة أمان

مهما كان، متكتبش المفتاحين نفسهم جوه `index.ts` أو أي ملف هترفعه على GitHub — استخدم
`supabase secrets set` بس زي ما هو موضح فوق. الملف ده مصمم عشان يفضل آمن حتى لو الريبو
بتاعك عام.

> ℹ️ الـ `--no-verify-jwt` بيخلي أي حد على الإنترنت يقدر ينادي الفنكشن (زي ما كان الحال
> بالظبط مع Cloudflare Worker قبل كده). ده مقبول لأداة عامة زي دي، لكن لو حابب تقفلها
> أكتر تقدر تحصر الـ CORS على دومين موقعك بس عن طريق تغيير `ALLOWED_ORIGIN` في أول
> `index.ts` من `"*"` لرابط موقعك، زي `"https://username.github.io"`.
