# ADR-001 — Solution مخصص بـ Publisher و Prefix `mwf`

- **الحالة:** مقبول
- **التاريخ:** 2026-10-06

## السياق

كل مكوّنات Dataverse (Tables, Columns, Flows, Apps...) تُنشأ داخل Solution، وكل Solution مرتبط بـ Publisher يحدد الـ customization prefix. إن لم نحدد شيئاً، تذهب المكوّنات إلى Default Solution بـ Publisher افتراضي وprefix عشوائي (مثل `cr123_`)، ولا يمكن نقلها بنظافة بين البيئات.

## القرار

- Solution واحد مخصص: Unique name `Muwafaqa`، Display name `Muwafaqa`.
- Publisher مخصص: Unique name `muwafaqa`، Display name `Muwafaqa`، **Prefix `mwf`**.
- Choice value prefix: يُولَّد عند إنشاء الـ Publisher (رقم بين 10000 و 99999). **يُسجَّل هنا بعد الإنشاء:** `_____`.
- Solution من النوع Unmanaged في بيئة التطوير، ويُصدَّر Managed إلى بيئات الاختبار والإنتاج عبر pipelines.
- كل Schema names بالشكل `mwf_<name>` بأحرف صغيرة.
- لا يُنشأ أي مكوّن خارج هذا الـ Solution. يُنشأ دائماً من داخله، أو يُضاف إليه مباشرة.

## التنازلات (Trade-offs)

| الجانب | الإيجابي | السلبي |
|---|---|---|
| Solution مخصص | قابل للتصدير والنقل والـ source control والـ ALM | حِمل إداري: يجب الانتباه دائماً لـ Solution النشط عند الإنشاء |
| Prefix `mwf` ثابت | أسماء مقروءة وخالية من التعارض | لا يمكن تغيير الـ Prefix بعد إنشاء مكوّنات به. خطأ فيه يعني إعادة بناء |
| Publisher واحد | بساطة | لا فصل بين طبقات المشروع لاحقاً (مثل Solution للـ plugins مستقل). يمكن إضافة Solutions أخرى بنفس الـ Publisher دون مشكلة |
| Unmanaged في التطوير | تعديل مباشر وسريع | لا تُصدَّر Unmanaged إلى الإنتاج. يتطلب انضباطاً في الـ pipelines |

## بدائل مرفوضة

- **Default Solution:** مكوّنات غير قابلة للنقل، prefix عشوائي، غير مناسب لمشروع Portfolio يُظهر ممارسة ALM.
- **Publisher افتراضي بتغيير الـ prefix فقط:** يُلوّث الـ Default Publisher المشترك ولا يعزل الملكية.

## مراجع

- Publisher prefix: 2–8 أحرف/أرقام، يبدأ بحرف، ولا يبدأ بـ `mscrm`. `mwf` مستوفٍ للشرط.
