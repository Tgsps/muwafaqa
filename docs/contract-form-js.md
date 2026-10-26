# Contract form script (UX only)

**Status (2026-10-26): the script is written and its logic is unit tested against a fake form object. It is NOT registered in the environment and NOT in the solution yet, and it has NOT been tried on the real form. It is untested on the real form until the owner's manual test below passes.** The Xrm part (the real `formContext`) is not covered by any automated test.

**This is user-experience only, not security.** It disables controls on the Contract main form so that a user does not type into a column the server will refuse. The API, imports and other forms ignore it. The enforcement is the server-side Contract State Guard plug-in ([ADR-004](decisions/ADR-004-contract-state-guard.md)).

- File: `src/WebResources/mwf_contract_form.js` (web resource name `mwf_contract_form.js`, type Script JScript). Until it is registered and the solution is synced, `pac solution pack` of `src/` ignores it (checked locally: the pack succeeds and the zip has no copy of the file).
- Unit tests: `scripts/contract-form.test.mjs` (13 tests): the pure function `lockedColumnsFor`, the handlers against a fake form, and a comparison of the locked-column list with the table of ADR-004. They do not prove that the real Xrm object behaves the same.

## Rules

| # | Rule | Trigger | Detail |
|---|---|---|---|
| 1 | The **saved** status decides which columns are locked | `OnLoad`, and after every save (`PostSave`, registered from `OnLoad`) | Draft (`statuscode` = 1): Value, Currency, Contract Type, Contract Direction and Counterparty are **enabled**. Any other value, and an empty or unknown value (fail-safe): they are **disabled**. Works both ways, so Rejected to Draft unlocks them. |
| 2 | An INFO notification explains the lock | same | Fixed id `mwf_contract_locked`; cleared in the Draft case. |

Decisions behind this (owner, 2026-10-26): `getInitialValue()` is not used, because Learn documents it only for Yes/No, Choice and Choices columns and `statuscode` is a Status column; the value is read with `getValue()` at `OnLoad` and again at `PostSave`. The status filter on Status Reason and the lock of Status Reason on a Create form were considered and dropped.

**One addition not in the owner's wording:** when `statuscode` has no value **on a Create form** only, the script treats the record as a Draft, because the server accepts only Draft on Create (ADR-004). Without it a new form could open fully locked if the platform gives no value to a new record. It is unit tested with a fake; whether the real form needs it is not known.

**Not touched on purpose (ADR-004):** Contract Subject, the three dates and the owner stay editable in every status. Contract Number, Exchange Rate, Value (Base) and Value (USD, Frozen) are already `disabled` in the form XML, so they need no script. There is no show/hide rule on Contract Type or Direction, because no real dependency exists in the data model (decision D10: independent columns).

## Registration in the maker portal (done by the owner)

1. Solutions, open **Muwafaqa**. New, More, Web resource. Display name `Muwafaqa Contract Form Script`, **Name** `contract_form.js` with the publisher prefix shown before it (the full name must be `mwf_contract_form.js`), type **Script (JScript)**, upload `src/WebResources/mwf_contract_form.js`. Save, Publish.
2. Solutions, Muwafaqa, Tables, Contract, Forms, open the main form **Information**.
3. In the form editor open **Form properties** (or Events), Form libraries: **Add** `mwf_contract_form.js`.
4. Events, **OnLoad**, Add: library `mwf_contract_form.js`, function **`Muwafaqa.ContractForm.onLoad`**, Enabled, **tick "Pass execution context as first parameter"**. This is the only handler; the script adds its own PostSave handler from `OnLoad` (Learn: `addOnPostSave`, Unified Interface only; the execution context is passed automatically). Do **not** add an `OnSave` handler.
5. Save the form, **Publish**.
6. Run the manual test below. Then, in this repository: `pac solution sync` and `node scripts/scrub-emails.mjs` (the rule of CLAUDE.md), so the web resource, the form events and the solution manifest enter `src/`.

## Manual test (the owner)

Use fictional data only. Hard refresh the app (Ctrl+F5) before the test.

| # | Check | You should see | Result |
|---|---|---|---|
| 1 | Create a **new** contract (Draft) | The five fields (Value, Currency, Contract Type, Contract Direction, Counterparty) are **editable**; no blue notice at the top. | not run |
| 2 | In a Draft, fill the required fields, set Status Reason to **Pending Approval**, Save | After the save the five fields become **disabled** and the blue notice appears: "This contract is no longer a Draft…". (If the server refuses the save, read the message and report it.) | not run |
| 3 | Open an existing **Pending Approval** contract | The five fields are disabled, the notice is shown. | not run |
| 4 | Open an **In Force** contract | The five fields are disabled, the notice is shown. | not run |
| 5 | Open a **Rejected** contract, set Status Reason to **Draft**, Save | After the save the five fields become **editable** again and the notice disappears. | not run |
| 6 | On every one of the cases above look at **Contract Number** | It is read-only every time (it comes from the form XML, not from the script). | not run |

Also report anything unexpected (a locked new form, a notice that stays after Rejected to Draft, a script error banner). The browser console (F12) would show a script error.
