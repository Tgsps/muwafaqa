# Schema log

Cumulative record of schema changes made by script, newest last. Plug-in registration is in `docs/plugin-registration-log.md`. Every entry says what was read back and what was not tested.

## 2026-10-22: approval chain tables (ADR-007, batch 1 of 4)

**Before (read only, script):** 3 consecutive GET requests succeeded; the approval flow OFF; 11 contracts, latest `modifiedon` 2026-10-07T17:23:48Z (the 11 legacy rows untouched); 0 TEST-TMP rows; 0 temporary counterparties; counters 0/0/0/0/0; git clean.

**Run (script `create-approval-chain-tables.mjs`, `--auth=az`):** created `mwf_approvalstep` (12 columns including the primary name; 3 lookups; key `mwf_ApprovalStepKey` on contract + round + order) and `mwf_approverassignment` (3 columns; key `mwf_ApproverAssignmentKey` on role), both in solution Muwafaqa. Updated the descriptions of `mwf_minvalueusd` ("lower bound of the value band, exclusive") and `mwf_maxvalueusd` ("upper bound, inclusive; empty means no upper limit") and published `mwf_approvalmatrix`. Both key indexes reached Active. No error, nothing retried.

**Decision recorded while building:** a Lookup is a valid alternate key column type (Learn, "Work with alternate keys", fetched 2026-10-22), and the key was created and enforced on the server, so no text column `mwf_stepkey` exists.

**Approver rows (script `load-approver-assignment.mjs`):** the test account was taken from the existing approval flow at run time (read only; the same account the flow uses today) and passed to the loader through the process environment only. Its value was never printed or stored. 5 rows created, validate: 5 rows, one per role, all Active, 1 distinct user.

**Read-back and live test (script `verify-approval-chain-schema.mjs --cascade-test`):** 42 PASS, 0 FAIL, 2 OBS. The first read-only run had 1 FAIL that was a bug of the checker, not of the schema: the server returns key columns in alphabetical order and the script compared them in creation order. The comparison was changed to ignore order and the run repeated. OBS: the 5 roles resolve to 1 user (development); managed platform roles hold privileges on both tables (no custom role exists). Live: duplicate key rejected (HTTP 412), same order in another round accepted, deleting the Draft contract deleted its 3 steps. Cleanup: 11 contracts, 0 TEST-TMP, 0 temporary counterparties, 0 steps, counter MNT restored 1 to 0.

**Not tested:** import of the two tables with the solution; anything that writes the step rows (batches 2 and 3); security roles for the submitter (security phase). `src/` was **not** synced.

## 2026-10-26: reminder columns on `mwf_approvalstep` (ADR-010)

**Run (script `add-reminder-columns.mjs --mode=apply`, Azure CLI sign-in; as recorded in ADR-010, "Implementation note (2026-10-26)"):** created `mwf_remindedon` and `mwf_escalatedon` on `mwf_approvalstep`: Date and Time, user local, not required, audit ON in the creation request, valid for create and update; null means that nothing was recorded yet for the step. The baseline (11 contracts, 110 active matrix rows, 5 active assignments, 0 approval steps, all flow rows OFF) was identical before and after.

**Read back (script):** 10 PASS for each column (type, behavior, required level, audit, create and update validity, labels); `--mode=check` afterwards 0 failed checks; `configure-auditing.mjs --mode=apply` made no write ("audit already ON"); the schema verifier 37 PASS, 0 FAIL, 3 OBS after it was taught the two columns. The columns are in the solution because the table is a component with all subcomponents (an inference, as for `mwf_decidedon`, not proven by a component row); `pac solution sync` exported both into `src/Entities/mwf_ApprovalStep/Entity.xml` (+80 lines).

**Source of this entry:** ADR-010 (the sections named above) and `src/Entities/mwf_ApprovalStep/Entity.xml` (read on 2026-11-15: both columns `datetime`, not required, audit enabled). **Not tested:** an import of the solution into another environment. The reminder flow wrote the columns in the two test windows of 2026-10-29 (ADR-010, "Test evidence"; test variant, v2 simulated by seeded rows).
