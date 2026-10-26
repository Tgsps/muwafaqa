# Contract form script (UX only)

**Status (2026-10-26): tested by the owner on the real model-driven app; the five checks below passed after the fix of commit `7e90dfb`. Not tested: other browsers, the card and quick forms, an interactive non-admin user.** The script is registered in the development environment by the owner. The Xrm part (the real `formContext`) is covered by no automated test, only by the manual test below. **Known limitation, not fixed:** after the ribbon commands Activate / Deactivate the form keeps the old banner and locks until the user presses Refresh (see the manual test, check 5).

## First manual test (2026-10-26): partial failure, cause, fix

- **Observed (owner):** the script loaded, `onLoad` ran (the blue notification showed) and Currency got the lock icon, but on a saved Pending Approval contract **Value, Contract Type, Contract Direction and Counterparty stayed editable** (a change to Procurement / Expense / $100 showed as unsaved).
- **Cause (read from the form XML, not guessed):** the first version used `formContext.getControl(columnName)`. Learn: the argument of `getControl` is the control **name** (or an index), it returns null when no control has that name, and when several controls are bound to one column only the first is returned. In the main form `{a72298be-…}` the control id (its name) equals the column name only for `transactioncurrencyid`; for the other four it is a GUID (`mwf_value`, `mwf_contracttype`, `mwf_direction`, `mwf_counterpartyid`). So `getControl` returned null for those four and the code skipped them silently, which matches what the owner saw. Each of the five columns has exactly one control in the main form, and none appears in the card or quick form, so duplicate controls were **not** the cause here (the fix still covers them).
- **Fix:** the columns are locked through the attribute, `formContext.getAttribute(name).controls.forEach(c => c.setDisabled(flag))` (the pattern Learn gives for changing every control bound to a column). A missing attribute is skipped, and a failure on one column or one control is logged with `console.warn` and does not stop the others.
- **Proof in the unit tests:** the fake form now names the controls like the real one (GUID names, `getControl` matches by name). With the new tests, the **old code fails 8 of 16** (including the new regression test for GUID names and two controls per column) and the **new code passes 16 of 16** (script). This shows the logic against a fake, not that the real form now behaves; that is the retest.
- **Learn also says** that disabling a control bound to a Business Required column makes the form stop requiring a value for it before saving. Value, Contract Type, Direction and Counterparty are Business Required; they are only disabled when the status is not Draft and they already hold a value, and the server guard is the enforcement anyway.

**This is user-experience only, not security.** It disables controls on the Contract main form so that a user does not type into a column the server will refuse. The API, imports and other forms ignore it. The enforcement is the server-side Contract State Guard plug-in ([ADR-004](decisions/ADR-004-contract-state-guard.md)).

- File: `src/WebResources/mwf_contract_form.js` (web resource name `mwf_contract_form.js`, type Script JScript). Until it is registered and the solution is synced, `pac solution pack` of `src/` ignores it (checked locally: the pack succeeds and the zip has no copy of the file).
- Unit tests: `scripts/contract-form.test.mjs` (16 tests): the pure function `lockedColumnsFor`, the handlers against a fake form that copies the real control names, a column with two controls, a column that throws, and a comparison of the locked-column list with the table of ADR-004. They do not prove that the real Xrm object behaves the same.

## Rules

| # | Rule | Trigger | Detail |
|---|---|---|---|
| 1 | The **saved** status decides which columns are locked | `OnLoad`, and after every save (`PostSave`, registered from `OnLoad`) | Draft (`statuscode` = 1): Value, Currency, Contract Type, Contract Direction and Counterparty are **enabled**. Any other value, and an empty or unknown value (fail-safe): they are **disabled**. Works both ways, so Rejected to Draft unlocks them. Applied through `getAttribute(name).controls`, so every control bound to the column is covered. |
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

Before a retest after the fix: open the web resource `mwf_contract_form.js` in the solution, **Choose file** with the new `src/WebResources/mwf_contract_form.js`, Save, **Publish all customizations** (the form and its handler registration do not change), then hard refresh the app (Ctrl+F5). Use fictional data only.

| # | Check | You should see | Result |
|---|---|---|---|
| 1 | Create a **new** contract (Draft) | The five fields (Value, Currency, Contract Type, Contract Direction, Counterparty) are **editable**; no blue notice at the top. | **PASS** (2026-10-26) |
| 2 | In a Draft, fill the required fields, set Status Reason to **Pending Approval**, Save | After the save the five fields become **disabled** and the blue notice appears: "This contract is no longer a Draft…". (If the server refuses the save, read the message and report it.) | **PASS** (2026-10-26): banner and the five locks appeared right after the save, without a reload |
| 3 | Open an existing **Pending Approval** contract | The five fields are disabled, the notice is shown. | **PASS** after the fix (2026-10-26). **First attempt FAILED before the fix:** four fields stayed editable (cause: the control names are GUIDs, see above) |
| 4 | Open an **In Force** contract | The five fields are disabled, the notice is shown. | **PASS** (2026-10-26), on an existing In Force contract, looked at only |
| 5 | Open a **Rejected** contract, set Status Reason to **Draft**, Save | After the save the five fields become **editable** again and the notice disappears. | **PASS with a limitation** (2026-10-26): Pending to Rejected (Deactivate) and Rejected to Draft (Activate) were both accepted by the server. **After Activate / Deactivate the form keeps the old banner and locks until Refresh** (those commands do not run `OnLoad` or `PostSave`; not fixed). After Refresh the five fields were open and the banner gone. Pending to Draft by a normal Save also unlocked them. |
| 6 | On every one of the cases above look at **Contract Number** | It is read-only every time (it comes from the form XML, not from the script). | **PASS** (2026-10-26), in all the states above |

**What this test did and did not show (2026-10-26).** Who: the owner, with the **System Administrator** account (not a non-admin user), on the real model-driven app with flow v2 OFF, with one test contract (created, taken through the checks, set back to Draft and deleted; the contract count must be 11 again, the owner confirms it) and one existing In Force contract (looked at only). The owner saw the lock icons and the banner on screen; **typing into a locked field in Pending was not tried**, and that an unlocked field accepts typing was seen in an earlier attempt. **Not tested:** other browsers, the card and quick forms, an interactive non-admin user.

Also report anything unexpected (a locked new form, a notice that stays after Rejected to Draft, a script error banner). The browser console (F12) would show a script error.
