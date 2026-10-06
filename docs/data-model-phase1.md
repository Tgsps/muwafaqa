# نموذج البيانات — المرحلة ١ (النواة)

- **الحالة:** مسودة للمراجعة. لا بناء قبل الموافقة.
- **Prefix:** `mwf` (انظر [ADR-001](decisions/ADR-001-dedicated-solution.md))
- **النطاق:** Table: `Counterparty` و `Contract` فقط.
- **التسمية:** Schema names بالإنجليزية وأحرف صغيرة. Dataverse يشتق Logical name من Schema name بأحرف صغيرة.
- كل قيم الأمثلة وهمية.

مفتاح الأعمدة: **Required level** = `System` (يفرضه Dataverse) · `Business Required` (يُفرض في الـ forms فقط) · `Business Recommended` · `Optional`.

---

## ١. Table: Counterparty (الطرف المقابل)

| الخاصية | القيمة |
|---|---|
| Display name | الطرف المقابل |
| Plural display name | الأطراف المقابلة |
| Schema name | `mwf_counterparty` |
| Entity set (Web API) | `mwf_counterparties` (يُشتق تلقائياً. يُتحقق منه بعد الإنشاء) |
| Ownership | Organization-owned (انظر D4) |
| Primary name column | `mwf_name` |

| Display name | Schema name | نوع العمود | Required level | القيم (Choice) | ملاحظة |
|---|---|---|---|---|---|
| الاسم | `mwf_name` | Single line of text (Text) | System (Primary name) | — | Primary name. الطول الافتراضي 100. أقترح 200. |
| النوع | `mwf_counterpartytype` | Choice (local) | Business Required | مورّد · عميل · مقاول · شريك · أخرى — **افتراض مني، لم تحدد القائمة** | انظر D6. |
| السجل التجاري | `mwf_commercialregistration` | Single line of text (Text) | Optional | — | قيم وهمية فقط، مثل `TEST-CR-0001`. انظر الملاحظة ٧. |
| جهة الاتصال | `mwf_contactname` | Single line of text (Text) | Optional | — | نص حر، **ليس** Lookup إلى Contact. دور/قسم وهمي فقط (مثل "قسم المشتريات - تجريبي"). ممنوع أسماء أشخاص. انظر D6. |
| البريد | `mwf_email` | Single line of text، Format = Email | Optional | — | عناوين وهمية على نطاق محجوز فقط: `example.com` أو `example.test` (محجوزان بموجب RFC 2606). |

أعمدة النظام (لا تُنشأ يدوياً): `mwf_counterpartyid` (GUID)، `statecode`، `statuscode`، `createdon`، `modifiedon`، `createdby`، `modifiedby`، `ownerid`/Owning business unit بحسب الـ ownership.

---

## ٢. Table: Contract (العقد)

| الخاصية | القيمة |
|---|---|
| Display name | العقد |
| Plural display name | العقود |
| Schema name | `mwf_contract` |
| Entity set (Web API) | `mwf_contracts` (يُتحقق منه بعد الإنشاء) |
| Ownership | User or team owned (انظر D4) |
| Primary name column | `mwf_name` |

| Display name | Schema name | نوع العمود | Required level | القيم (Choice) | ملاحظة |
|---|---|---|---|---|---|
| موضوع العقد | `mwf_name` | Single line of text | System (Primary name) | — | Primary name. أقترح طول 200. |
| رقم العقد | `mwf_contractnumber` | Single line of text | Optional | — | مؤقت: نص عادي. يُولَّد بـ plugin في المرحلة ٢ (انظر D3). |
| نوع العقد | `mwf_contracttype` | Choice (local) | Business Required | صيانة · مشتريات · تأمينات · مبيعات · خدمات | "تأمينات" ملتبسة: انظر D7. |
| اتجاه العقد | `mwf_direction` | Choice (local) | Business Required | دخل · مصروف | الاسم المنطقي `Income / Expense`. العلاقة مع النوع: انظر D7. |
| الطرف الثاني | `mwf_counterpartyid` | Lookup → `mwf_counterparty` | Business Required | — | علاقة N:1. سلوك الحذف: انظر D5. في الـ Web API يظهر كـ `_mwf_counterpartyid_value` (انظر الملاحظة ١٠). |
| القيمة | `mwf_value` | Currency | Business Required | — | انظر D1. ينشئ تلقائياً: `mwf_value_base` (Currency Value Base). |
| العملة | `transactioncurrencyid` | Lookup → Currency (أصلي في Dataverse) | Business Required (يُضاف تلقائياً عند أول عمود Currency) | — | **انحراف عن طلبك** (كان Choice). السبب والبديل في D1. |
| سعر الصرف | `exchangerate` | Decimal (أصلي) | System | — | يُملأ تلقائياً من سجل العملة عند الإنشاء. للقراءة فقط. |
| تاريخ التوقيع | `mwf_signeddate` | Date and time، Format = Date only، Behavior = Date only | Optional | — | يكون فارغاً في المسودة. |
| تاريخ السريان | `mwf_effectivedate` | Date and time، Format = Date only، Behavior = Date only | Business Recommended | — | قد يختلف عن التوقيع. |
| تاريخ الانتهاء | `mwf_expirydate` | Date and time، Format = Date only، Behavior = Date only | Business Recommended | — | أساس تنبيهات الانتهاء لاحقاً. |
| الحالة | `mwf_status` | Choice (local) | Business Required | مسودة (افتراضي) · قيد الاعتماد · ساري · مرفوض | **مُتّبع كما طلبت**، لكن أوصي بالبديل الأصلي `statuscode`. انظر D2. |

أعمدة النظام: `mwf_contractid`، `statecode`، `statuscode`، `ownerid`، `createdon`... إلخ.

### قيم Choice

- **قيم الأرقام:** يولدها Dataverse من الـ Choice value prefix في الـ Publisher (انظر ADR-001). لا أخترع أرقاماً هنا. تُسجَّل بعد الإنشاء من الـ solution المفكوك.
- **ترتيب القوائم** كما أعلاه.
- **قائمة العملات المقترحة (افتراض مني، ليست متطلباً):** هذه **سجلات** في جدول Currency وليست Choice. السجلات المقترحة: USD · EUR · GBP · SAR · AED. العملة الأساسية (Base currency) تُحدَّد عند إنشاء البيئة ولا تتغير بعدها. **لا أعرف عملة بيئتك الأساسية.** أخبرني بها.

---

## ٣. العلاقات

| العلاقة | النوع | Parent | Child | سلوك مقترح |
|---|---|---|---|---|
| Counterparty → Contract | 1:N | `mwf_counterparty` | `mwf_contract` | Referential, **Restrict** على Delete (انظر D5) |

---

## ٤. مؤجَّل عمداً

**المراحل أدناه مقترحة مني، وليست خارطة طريق مؤكدة.** لم تعطني خطة المراحل بعد المرحلة ٢ (توليد رقم العقد بـ plugin). عدّلها كما تريد.

| البند | سبب التأجيل | المرحلة المقترحة |
|---|---|---|
| القيمة بالدولار المجمّدة (frozen USD value) | تحتاج plugin يثبّت سعر الصرف عند لحظة محددة (مثلاً الانتقال إلى "ساري") ولا يعيد حسابه | ٢ (مع plugin توليد الرقم) |
| نوع القيمة (ثابتة / متغيرة / سقف...) | يؤثر على معنى حقل القيمة. الأفضل تثبيت الأساس أولاً | ٣ |
| نوع التجديد (تلقائي / يدوي / بدون) | مرتبط بتدفقات التجديد والتنبيهات | ٣ |
| الالتزامات (Obligations) | Table تابع بعلاقة 1:N مع Contract. يتطلب نموذجاً مستقلاً | ٤ |
| الملاحق (Addenda / Amendments) | علاقة Contract→Contract أو Table مستقل. قرار مفتوح يؤثر على القيمة والتواريخ | ٤ |
| الكيان القانوني / الموقع (Legal entity / Site) | Tables مرجعية جديدة وLookups. لا حاجة لها لإثبات النواة | ٣ |
| دورة الاعتماد (Approvals) | Power Automate + Approvals. يحتاج استقرار `mwf_status` أولاً | ٢–٣ |
| Auditing وصلاحيات (Security roles) | يُفعَّل Auditing على Table/Column. الصلاحيات تُصمَّم مع الـ Ownership | ٢ |

---

## ٥. نقاط تحتاج قراري

### D1 — العملة: Currency column الأصلي أم Choice + Decimal

طلبت: القيمة (Currency/Decimal) + العملة (Choice).

**المشكلة:** عمود من نوع Currency في Dataverse يفرض وجود `transactioncurrencyid` (Lookup إلى جدول Currency) و `exchangerate` على الـ Table، ويُنشئ عمود `_base` محسوباً. لا يمكنك استخدام Choice كعملة لعمود Currency. Choice مع Currency يعني عمودين للعملة (واحد منهما مهمل ومربك).

| الخيار | الإيجابي | السلبي |
|---|---|---|
| **A (أوصي به):** Currency column + `transactioncurrencyid` الأصلي | مدعوم أصلياً: تنسيق، `_base` للتجميع بعملة موحدة، سعر صرف مخزّن، Rollups/Charts تعمل. يُظهر معرفة بنموذج Dataverse (مفيد لـ PL-400) | القائمة سجلات تُدار في جدول Currency وليست Choice. سعر الصرف يُدار يدوياً (لا تحديث تلقائي) |
| **B:** Decimal + Choice للعملة | كامل التحكم بالقائمة. لا اعتماد على جدول Currency | لا `_base` ولا سعر صرف. التجميع بين عملات مختلفة يدوي. تعيد اختراع شيء موجود |

### D2 — الحالة: Choice مخصص أم `statuscode` الأصلي

| الخيار | الإيجابي | السلبي |
|---|---|---|
| **A:** `mwf_status` Choice مخصص (كما طلبت) | سهل الفهم. لا ارتباط بـ State | يتجاهل `statecode`/`statuscode` الموجودين أصلاً (فيصبح لدينا نظامان للحالة). لا قفل للقراءة فقط تلقائياً |
| **B (أوصي به):** استخدام `statuscode` (Status Reason) مع `statecode` (Active/Inactive). مثال: مسودة/قيد الاعتماد/ساري ← Active. مرفوض ← Inactive | يتكامل مع Views الافتراضية، وقفل السجلات غير النشطة، وأزرار Activate/Deactivate. لا عمود إضافي | `statecode` ثنائي. التحول بين الحالات المنطقية (مثلاً "منتهٍ" لاحقاً) يحتاج تخطيطاً مسبقاً. التعديل على الـ transitions محدود |

الجدول أعلاه يتبع A كما طلبت. أحوّله إلى B إن وافقت.

### D3 — رقم العقد: Plugin أم Autonumber column

| الخيار | الإيجابي | السلبي |
|---|---|---|
| **A: Plugin (خطتك)** | تحكم كامل: بادئة بحسب نوع العقد/السنة، إعادة العد سنوياً. يُظهر مهارة plugin (PL-400) | كود يُصان ويُنشر. ومخاطرة تكرار الرقم عند التزامن (concurrency) ما لم تُعالَج |
| **B:** Autonumber column الأصلي (مثل `CT-{SEQNUM:5}`) | بدون كود. التزامن مُدار من المنصة | لا بادئة ديناميكية بحسب نوع العقد (لا أعرف إن كانت تدعم إعادة العد سنوياً: تحقق قبل الاعتماد عليها) |

إن كان الهدف إثبات plugin، فـ A مبرَّر، لكن قلها صراحة في ADR لاحق أن Autonumber كان بديلاً أبسط.

### D4 — Ownership (لا يمكن تغييره بعد الإنشاء)

- **Contract:** أوصي بـ **User or team owned**. يتيح صلاحيات على مستوى السجل (Row-level) ومشاركة، ومطلوب لتصميم صلاحيات واقعي. التنازل: مزيد من تعقيد الـ security roles.
- **Counterparty:** خياران:
  - **Organization-owned:** أبسط، الكل يقرأ بحسب الدور. لا صلاحيات لكل سجل. (توصيتي: بيانات مرجعية)
  - **User or team owned:** يسمح بإخفاء أطراف معينة. التنازل: تعقيد، وLookup من Contract قد يفشل لمن لا يرى الطرف.

### D5 — سلوك حذف الـ Lookup (Contract → Counterparty)

| الخيار | النتيجة | التنازل |
|---|---|---|
| **Restrict (أوصي به)** | يمنع حذف Counterparty له عقود | الحذف يتطلب حذف/إعادة تعيين العقود أولاً. أمان أعلى |
| Remove Link (الافتراضي لعلاقات Referential) | الحذف ينجح ويصبح Lookup فارغاً | عقد بلا طرف مقابل، وهو مخالف لكونه Business Required |
| Cascade | حذف الطرف يحذف عقوده | خطر فقدان بيانات. غير مناسب |

### D6 — Counterparty: قائمة النوع و جهة الاتصال

- قائمة النوع (مورّد · عميل · مقاول · شريك · أخرى) افتراض مني. أكّدها أو غيّرها.
- **جهة الاتصال كنص:** أبسط، ولا تلوّث بيانات حقيقية. التنازل: لا تعدد جهات اتصال، ولا ربط بجدول Contact الأصلي.
- **بديل:** Lookup إلى Contact الأصلي. التنازل: تعقيد أكبر، ودفع نحو بيانات أشخاص (مخالف لسياسة السرّية).

### D7 — نوع العقد واتجاهه

- **"تأمينات":** كلمة ملتبسة في العربية: Insurance (تأمين) أم Security deposits (تأمينات/ودائع ضمان). أيهما تقصد؟ الاسم الإنجليزي للـ Choice يتبع ذلك.
- **تداخل النوع والاتجاه:** "مبيعات" ≈ دخل دائماً، و"مشتريات" ≈ مصروف دائماً. بينما "صيانة/خدمات" قد تكون في الاتجاهين. الاستقلال بين العمودين يسمح بتركيبات غير منطقية (مبيعات + مصروف).
  - **A:** تبقى مستقلة، مع Business rule/plugin يمنع التركيبات غير المنطقية. مرونة، لكن قاعدة تُصان.
  - **B:** اشتقاق الاتجاه من النوع حيث يمكن. أبسط، لكنه يقيّد حالات الاستخدام النادرة.

### D8 — Choice محلي أم Global

أوصي بـ **Local** لكل الأعمدة الآن (لا يتشاركها Table آخر). إن ظهرت حاجة لمشاركة (مثل اتجاه العقد في جدول الالتزامات)، يُحوَّل إلى Global. التنازل: التحويل لاحقاً ممكن لكنه عمل يدوي.

### D9 — لغة Display names

Schema names إنجليزية. Display names عربية كما في الجداول أعلاه. **لا أعرف اللغة الأساسية (Base language) لبيئتك.** إن كانت إنجليزية، فالتسميات العربية تُضاف كـ translations (Export/Import translations) أو تُكتب مباشرة كـ Display name في اللغة الأساسية. التنازل: عرض عربي كامل بسهولة مقابل تعقيد في ملفات الترجمة وفي بعض الأدوات عند الأسماء العربية.

---

## ٦. ملاحظات Dataverse تؤثر على التصميم

1. **Currency:** إضافة أول عمود Currency تُنشئ تلقائياً `transactioncurrencyid` و `exchangerate`، وتنشئ `<column>_base` محسوباً. العملة الأساسية للبيئة تُحدَّد عند الإنشاء ولا تتغير. سعر الصرف على السجل يُنسخ من سجل العملة عند الإنشاء (أعتقد أن تغيير سعر العملة لاحقاً لا يُعيد حساب السجلات القديمة. **يجب التحقق منه في بيئة التطوير** قبل الاعتماد عليه في تصميم "القيمة المجمّدة").
2. **Required level لا يُفرض على الـ API:** `Business Required` يُفرض في واجهات الـ forms فقط. أي Flow أو import أو Web API أو plugin يستطيع إنشاء سجل بدونه. القواعد الحرجة تحتاج plugin أو Business rule مضبوطة على الخادم.
3. **Lookup:** العلاقة الناتجة 1:N. سلوك الحذف يُحدد عند الإنشاء ويمكن تعديله لاحقاً من خصائص العلاقة. Lookup لا يضمن Required فعلياً (النقطة ٢).
4. **Primary name:** كل Table له Primary name column واحد، نصي فقط، لا يُحذف، ويُظهر في Lookups والـ views. اختيار اسم غير معبّر يضر بتجربة المستخدم في كل مكان. لذلك "موضوع العقد" مناسب كاسم أساسي. رقم العقد ليس اسماً أساسياً لأنه سيُولَّد لاحقاً.
5. **Date only:** عمود Date and time له Behavior: User local / Date only / Time-zone independent. اخترنا **Date only** لتفادي انزياح اليوم بحسب المنطقة الزمنية. تغيير الـ Behavior بعد الإنشاء مقيّد، فيُحسم الآن.
6. **Ownership:** يُحدَّد عند إنشاء الـ Table ولا يمكن تغييره. راجع D4 قبل الإنشاء.
7. **Choice:** القيم أرقام يولدها Dataverse، ولا تتغير بتغيير الـ Label. أي كود (plugin/Flow) يجب أن يتعامل بالقيمة لا بالنص. حذف قيمة Choice مستخدمة لا يُنظَّف تلقائياً من السجلات.
8. **السجل التجاري والبيانات الحساسة:** حتى لو الحقل نص بسيط، لا يدخل أي رقم حقيقي. الأرقام الوهمية تتبع نمطاً واضح الزيف مثل `TEST-CR-0001`.
9. **Alternate key:** يمكن لاحقاً جعل السجل التجاري (أو رقم العقد) Alternate key لضمان التفرد. لم أتحقق من سلوكه مع القيم الفارغة، فلا أعتمد عليه الآن.
10. **أسماء الجداول:** `mwf_counterpartyid` اسم Lookup في Contract، وهو أيضاً اسم الـ primary key في Counterparty (النمط المعتاد: `<tablename>id`). لا تعارض فعلي لأنهما في جدولين مختلفين، لكن ينتبه عند كتابة FetchXML/Web API ($expand، `_mwf_counterpartyid_value`). إن فضّلت اسماً أوضح مثل `mwf_counterparty` للـ Lookup، فهذا خيار ثانوي.
