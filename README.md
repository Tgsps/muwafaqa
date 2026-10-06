# Muwafaqa

نظام إدارة عقود وموافقات مبني على Microsoft Power Platform (Dataverse · Model-driven app · Power Automate · Plugins · PCF).

مشروع Portfolio يُثبت مهارات PL-400 و AB-620.

## السيناريو

نموذج عقد خدمات في قطاع الضيافة (صيانة، مشتريات، تأمينات، مبيعات، خدمات): تسجيل العقود والأطراف المقابلة، ثم دورة اعتماد، ثم متابعة الانتهاء والتجديد.

> **كل البيانات مُختلقة بالكامل.** لا توجد عقود أو جهات أو أشخاص أو أرقام حقيقية في هذا المستودع.

## الحالة الحالية

**المرحلة ١ — النواة:** Counterparty + Contract. نموذج البيانات قيد المراجعة: [docs/data-model-phase1.md](docs/data-model-phase1.md).

## بنية المستودع

```
/src          الحل المفكوك (unpacked solution)
/plugins      Dataverse plugins (.NET)
/pcf          PCF controls
/pipelines    ALM / CI-CD
/docs         المواصفات والتوثيق
  /decisions  ADRs
/data         بيانات اختبار مُختلقة
```

## القرارات المعمارية

- [ADR-001 — Solution مخصص بـ Publisher و Prefix `mwf`](docs/decisions/ADR-001-dedicated-solution.md)
