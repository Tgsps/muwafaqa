# Verification Checklist

Manual tests performed in the development environment while building, with results recorded afterwards. Each item lists steps, an **expected result**, and an empty **Actual result** to fill in.

The expected results are **hypotheses** based on understanding of Dataverse, not confirmed facts. If the actual result differs, update the affected document ([data-model-phase1.md](data-model-phase1.md), [flow-approval-v1.md](flow-approval-v1.md), or an ADR).

Environment: Base currency TRY, Base language English. Use only fictitious data.

| # | Item | Affects |
|---|---|---|
| 1 | Rename default Status Reason options | Data model section 2 |
| 2 | KWD precision | Data model, test data |
| 3 | Exchange rate change and its effect on existing records | Phase 2 independent USD value |
| 4 | Rejected → Draft transition | Data model section 2, flow test plan |
| 5 | Alternate key with empty values | Phase 2 Contract Number |
| 6 | Flow sets Status Reason only: is State derived? | Flow spec section 7 |
| 7 | Flow loop guard and re-trigger behavior | Flow spec section 6 |
| 8 | Import of `statuscode` from CSV | data/README.md |

---

## 1. Rename default Status Reason options

**Steps**
1. Open the solution → table Contract → Columns → **Status Reason**.
2. Note the default options and their State (expected defaults: one under Active, one under Inactive).
3. Rename the default Active-state option to `Draft`.
4. Add `Pending Approval` and `In Force` under State Active.
5. Rename the default Inactive-state option to `Rejected`.
6. Try to delete a default option (do this on a spare option, not a needed one).
7. Create a new Contract row and note the default Status Reason.
8. Record the numeric values Dataverse assigned to each option.

**Expected result**
- Default options can be renamed. New options can be added under each State.
- The new row defaults to Draft. (Where the default is set per State is not known, record it.)
- Deletion of a default option is probably blocked. Record what happens.

**Actual result**:

---

## 2. KWD precision

**Steps**
1. Create the currency record `Kuwaiti Dinar` (ISO `KWD`, exchange rate 0.30 assumed) with precision 3.
2. On the Contract Value column, note the Precision setting options (currency precision / pricing precision / fixed 0–4).
3. Create a Contract in KWD with Value `6500.250`.
4. Check what the form shows, what the grid shows, what Web API returns for `mwf_value`, and what `mwf_value_base` shows.
5. Repeat in USD with Value `100.255`.

**Expected result**
- If the column precision follows the currency record, KWD shows 3 decimals and USD shows 2 (rounding `100.255`).
- If the column uses a fixed precision (e.g. 2), `6500.250` is rounded to 2 decimals in KWD as well.
- `mwf_value_base` may use the base currency precision (2 for TRY).

**Actual result**:

Decision to take from the result: which precision source the Value column should use.

---

## 3. Exchange rate change and its effect on existing records

Also confirms the **direction** of the exchange rate convention.

**Steps**
1. Set the AED currency rate to `3.67` (assumed).
2. Create Contract A: AED, Value `367250`. Record `exchangerate` and `mwf_value_base`.
3. Compute `367250 / 3.67` (≈ 100,068.12) and compare with `mwf_value_base`. This confirms whether base = value ÷ rate.
4. Change the AED currency rate to `3.70`.
5. Open Contract A. Record `exchangerate` and `mwf_value_base`.
6. Edit Contract A (change Subject only, save). Record both again.
7. Edit Contract A's Value to `367251`, save. Record both again.
8. Create Contract B in AED, Value `367250`. Record `exchangerate` and `mwf_value_base`.
9. Try to edit `exchangerate` directly on a record (form and API) and record whether it is allowed.

**Expected result**
- Convention: base = value ÷ rate (rate = units of the currency per 1 unit of the base currency, TRY). **Confirmed by test on 2026-10-06** (see data model section 8).
- Step 5: Contract A keeps the rate and base amount it had (3.67).
- Step 6: unchanged.
- Step 7: possibly unchanged, possibly refreshed to 3.70. Unknown.
- Step 8: Contract B takes 3.70.
- Step 9: `exchangerate` is read-only on forms. API behavior unknown.

**Actual result**:

Decision to take from the result: how the Phase 2 plugin freezes the independent USD value (the platform base amount is in TRY, not USD).

---

## 4. Rejected → Draft transition

**Steps**
1. Take a contract in Rejected (State Inactive), e.g. `TEST-CT-0007`.
2. Open its form. Record whether fields are read-only.
3. Use the command bar **Reactivate**. Record the Status Reason options offered.
4. Select Draft. Record the resulting State and whether the form becomes editable.
5. Via the flow connector or API, update a Rejected row's Status Reason to Draft directly. Record the result.
6. Optionally, in the Status Reason column, enable status transitions and restrict allowed transitions. Retest steps 3–5.

**Expected result**
- Inactive form is read-only.
- Reactivate offers Draft and the other Active-state options (Pending Approval, In Force). Choosing Draft sets State = Active.
- Direct API update may be allowed or blocked. Unknown.
- Restricting transitions could block Reactivate options you want to allow. Unknown.

**Actual result**:

Decision to take from the result: whether Rejected is final or recoverable in Phase 1, and whether the Reactivate offer of In Force (skipping approval) needs restriction.

---

## 5. Alternate key with empty values

**Steps**
1. On Contract, create an Alternate key on `mwf_contractnumber`. Wait until the key's index status is **Active**.
2. Create 2 contracts with empty Contract Number. Record whether the second is accepted.
3. Create a contract with Number `TEST-DUP-1`, then another with the same number. Record the error.
4. Try creating the key on a table that already has duplicate non-empty values (use a spare environment or a scratch table). Record the outcome.
5. Repeat step 1–2 for Counterparty `mwf_commercialregistration` (optional).

**Expected result**
- Duplicate non-empty values are rejected (duplicate key error).
- Multiple empty values: probably allowed, since null is not treated as a value. Unknown.
- Key creation is asynchronous and fails if existing data already contains duplicates.

**Actual result**:

Decision to take from the result: whether an Alternate key can guarantee Contract Number uniqueness for the Phase 2 plugin (see [ADR-002](decisions/ADR-002-contract-number.md)).

---

## 6. Flow sets Status Reason only: is State derived?

**Steps**
1. In the flow (or a test flow), run *Update a row* on a Pending Approval contract setting **only** Status Reason = In Force.
2. Check State afterwards.
3. Repeat setting Status Reason = Rejected only.
4. If State is wrong or the action fails, set Status (State) explicitly and retest.

**Expected result**
- State follows the Status Reason's parent State (In Force → Active, Rejected → Inactive).

**Actual result** (2026-10-07, from the live flow): *Update a row* with only Status Reason set works for In Force. For Rejected it fails unless Status (State) = Inactive is also set, with the error "2 is not a valid status code for state code mwf_ContractState.Active". With State set to Inactive and Status Reason Rejected, the update succeeds. The expectation "State is always derived from Status Reason" is therefore **only partly true**.

---

## 7. Flow loop guard and re-trigger behavior

**Steps**
1. Complete flow Scenario 1 (full approval). Open run history. Count runs for that contract.
2. Edit an unrelated column on a Pending Approval row (e.g. Subject). Confirm no run starts.
3. Save a Pending Approval row again without changing Status Reason. Confirm whether a run starts.
4. Set Pending Approval → Draft → Pending Approval quickly. Count runs and whether they overlap, with concurrency control = 1.
5. While an approval is outstanding, move the contract to Draft, then let the approver respond. Record what the flow does.

**Expected result**
- Step 1: exactly one run (the flow's own update does not start another, because Filter rows no longer matches).
- Step 2: no run.
- Step 3: unknown.
- Step 4: unknown.
- Step 5: the flow overwrites the status when the approver responds (known gap, flow spec section 6).

**Actual result** (2026-10-07): step 1 only. 5 runs for 5 contracts, one run per contract, no re-trigger from the flow's own status update. Steps 2 to 5 (unrelated column edit, same-value save, quick Pending → Draft → Pending with concurrency = 1, status change while an approval is outstanding) were **not tested**.

---

## 8. Import of `statuscode` from CSV

**Steps**
1. Import `data/contracts.csv` following [data/README.md](../data/README.md) with the approval flow turned **off**.
2. Check each row's Status Reason and State.
3. Check that Lookups for Counterparty and Currency resolved, and Choice values mapped by label.
4. Check Date Only values (no day shift).

**Expected result**
- If the import accepts `statuscode`, In Force/Draft/Pending Approval rows are Active, Rejected is Inactive.
- If not, all rows import as Draft and statuses are set manually afterwards.

**Actual result**:

---

## Results log

### 2026-10-07 — approval flow (see [flow-approval-v1.md](flow-approval-v1.md) section 9)

| Scenario | Result |
|---|---|
| 1. Full approval | **Passed** |
| 2. Rejection at stage 1 | **Passed** after a correction. The first attempt **failed** because Status (State) was not set: Status Reason Rejected is invalid for State Active. Fixed by setting State = Inactive together with Status Reason = Rejected |
| 3. Rejection at stage 2 | **Passed** |

Related, covered above: item 6 (partly answered) and item 7 (step 1 only).

**Not tested, still open:** items 1 to 5 and 8 are not recorded here, and the flow's quick Pending → Draft → Pending sequence, concurrency, same-value save, and the outstanding-approval race (flow spec section 6) remain untested.
