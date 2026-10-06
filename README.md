# Muwafaqa

A contract and approval management system built on Microsoft Power Platform (Dataverse, model-driven app, Power Automate, plugins, PCF).

Portfolio project demonstrating PL-400 and AB-620 skills.

## Scenario

A service-contract model for the hospitality sector (maintenance, procurement, insurance, sales, services): register contracts and counterparties, run an approval cycle, then track expiry and renewal.

> **All data is entirely fictitious.** No real contracts, organizations, people, or figures exist in this repository.

## Environment constraints

- Base currency: **TRY** (Turkish Lira)
- Base language: **English**

The environment already existed, and TRY is a deliberate decision. The base currency can be changed through Base Currency Conversion, but that is a heavy process, so it is treated as practically fixed. Contract base amounts are therefore in TRY, while the approval authority threshold is in US dollars. Phase 2 computes an independent USD value and freezes it at submission. See [ADR-001](docs/decisions/ADR-001-dedicated-solution.md).

## Current status

**Phase 1 — Core:** Counterparty and Contract. Data model: [docs/data-model-phase1.md](docs/data-model-phase1.md).

## Repository layout

```
/src          Unpacked solution
/plugins      Dataverse plugins (.NET)
/pcf          PCF controls
/pipelines    ALM / CI-CD
/docs         Specifications and documentation
  /decisions  ADRs
/data         Fictitious test data
```

## Architecture decisions

- [ADR-001 — Dedicated solution with publisher prefix `mwf`](docs/decisions/ADR-001-dedicated-solution.md)
- [ADR-002 — Contract number: plain text now, plugin in Phase 2](docs/decisions/ADR-002-contract-number.md)
