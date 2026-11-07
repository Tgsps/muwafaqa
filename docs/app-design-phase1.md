# App Design — Phase 1 (Model-driven app)

A click-by-click specification for make.powerapps.com. Nothing here is built yet.

- **Source of truth for columns:** [data-model-phase1.md](data-model-phase1.md)
- **Environment:** base currency TRY, base language English (see [ADR-001](decisions/ADR-001-dedicated-solution.md))
- **Solution:** `Muwafaqa` (publisher `MuwafaqaDev`, prefix `mwf`). Create everything from inside this solution.
- Items marked **(not verified)** were not confirmed by the Microsoft Learn pages listed in section 8.

## 0. Phase 1 limits (read first)

Everything the form does to restrict users is **client-side only** (read-only, hidden, required on the form). It does not stop the API, flows, imports, or plugins. Real enforcement is Phase 2 (plugin and JavaScript). *Update 2026-10-26: enforcement is the server plug-in (ADR-004); a form script exists only as a UX aid; its first manual test on the real form partly failed, it was fixed in code and is not retested yet, see [contract-form-js.md](contract-form-js.md).* Known gaps in Phase 1:

| Gap | Why it exists | Phase |
|---|---|---|
| Any user who can edit a Contract can set Status Reason to **In Force** or **Rejected** by hand, bypassing the approval flow | Status Reason is a normal editable column | 2 |
| Contract can be saved without a currency | `transactioncurrencyid` has Required level None (verified, see data model section 8) | 2 |
| Illogical Type/Direction combinations are possible (e.g. Sales + Expense) | Decision D10 | 2 |
| Contract Number is free text and not unique | ADR-002 | 2 |

## 1. The app

| Property | Value |
|---|---|
| Name | Muwafaqa Contracts |
| Type | Model-driven app (modern app designer), created inside solution `Muwafaqa` |
| Tables added | Contract (`mwf_contract`), Counterparty (`mwf_counterparty`) (the Phase 1 scope of this document). Read from `src/AppModules/mwf_MuwafaqaContracts/AppModule.xml` on 2026-11-07: the app module also lists `mwf_approvalmatrix` and, since 2026-11-07, `mwf_obligation` (line 16) |
| Description | Contract and counterparty management. Phase 1 core. |

### Navigation

| Group | Item | Table | Default view |
|---|---|---|---|
| Contracts | Contracts | Contract | In Force Contracts (see section 4) |
| Reference data | Counterparties | Counterparty | Active Counterparties |
| Reference data | Obligations (added 2026-11-07; the default view of the page is not recorded) | Obligation | not recorded |

### Steps

1. Open make.powerapps.com, select the development environment, then **Solutions**, then open `Muwafaqa`.
2. **New** > **App** > **Model-driven app**. Enter the name `Muwafaqa Contracts` and select **Create**. The app opens in the app designer.
3. Select **Add page** > **Dataverse table** > **Contract**, then **Add**.
4. Repeat for **Counterparty**.
5. In the navigation, create two groups (**Contracts**, **Reference data**) and arrange the pages as in the table above. *(Exact UI for navigation groups: not verified in the pages fetched.)*
6. **Save**, then **Publish**.
7. **Apps** in the left pane > select **Muwafaqa Contracts** to run it.

## 2. Contract main form

Edit the default main form: **Solutions** > `Muwafaqa` > table **Contract** > **Forms** > select the main form > **Edit**. When finished: **Save and publish**.

The form has one tab. Order of columns is top to bottom, left column then right column.

**Tab: General**

| Section | Columns (in order) | Read-only on form | Notes |
|---|---|---|---|
| **Contract** (2 columns) | Contract Number (`mwf_contractnumber`) · Contract Subject (`mwf_name`) · Contract Type (`mwf_contracttype`) · Contract Direction (`mwf_direction`) · Counterparty (`mwf_counterpartyid`) | none | Subject, Type, Direction, Counterparty show as required (Business Required). Contract Number is free text until Phase 2 |
| **Financial** (2 columns) | Value (`mwf_value`) · Currency (`transactioncurrencyid`) · Exchange Rate (`exchangerate`) · Value (Base) (`mwf_value_base`) | Exchange Rate, Value (Base) | See section 5. Base amount is in **TRY** |
| **Dates** (3 columns or 1) | Signed Date (`mwf_signeddate`) · Effective Date (`mwf_effectivedate`) · Expiry Date (`mwf_expirydate`) | none | Date Only. Effective and Expiry are Business Recommended |
| **Status** | Status Reason (`statuscode`) | none in Phase 1 | See the gap in section 0. Also show Owner (`ownerid`) in the form header |

### Hidden columns

None are hidden in Phase 1. Reasoning and trade-off:
- **Show Exchange Rate and Value (Base), read-only.** Upside: the team can see how the base amount was derived while the rate logic is still being validated. Downside: more fields for end users. Revisit when the Phase 2 USD value exists.
- Do not add `mwf_contractid`, `statecode`, or the `...name` virtual columns (`mwf_contracttypename`, `mwf_directionname`, `mwf_counterpartyidname`). They are system or helper columns.

### Mark as read-only: how

For Exchange Rate and Value (Base): select the column in the form designer, open its properties, and set it read-only if the option is offered. Microsoft states these two columns can't be edited when added to a form (section 5), so this is a clarity setting, not the protection. *(Exact property label: not verified.)*

### Steps

1. Open the Contract main form in the form designer (path above).
2. Rename the form **Information** if it has another name (title is shown to users).
3. Select the existing tab, rename it **General**. Create the sections **Contract**, **Financial**, **Dates**, **Status** with the column counts above. *(Tab and section property labels: see [add-move-or-delete-sections-on-form](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/add-move-or-delete-sections-on-form), not fetched.)*
4. In the **Table columns** pane, drag each column from the table above into its section, in the listed order.
5. Set Exchange Rate and Value (Base) read-only.
6. Remove any default columns that are not in the table (for example Owner in the body).
7. **Save and publish**.

## 3. Counterparty form and view

### Main form (simple)

**Tab: General**, one section **Counterparty** (2 columns):

| Order | Column |
|---|---|
| 1 | Name (`mwf_name`) |
| 2 | Type (`mwf_counterpartytype`) |
| 3 | Commercial Registration (`mwf_commercialregistration`) |
| 4 | Contact (`mwf_contactname`) |
| 5 | Email (`mwf_email`) |

Add a **Contracts** subgrid (related Contracts) only if the designer offers it without extra work. Optional, not required for Phase 1.

### Views

Edit the existing public view **Active Counterparties**: **Solutions** > `Muwafaqa` > **Counterparty** > **Views**.

| Column order | Sort | Filter |
|---|---|---|
| Name · Type · Commercial Registration · Contact · Email · Created On | Name ascending | Status = Active (existing default filter, keep) |

Keep **Inactive Counterparties** unchanged.

## 4. Contract views

Default views created with a custom table: Active, Inactive, Quick Find Active, Advanced Find, Associated, Lookup. **Active Contracts** filters on **Status** (State) = Active, so it includes Draft, Pending Approval, and In Force rows. It cannot be deleted. Create the public views below for clearer lists.

Common columns for the first three views, in order: Contract Number · Contract Subject · Counterparty · Contract Type · Contract Direction · Value · Currency · Value (Base) · Expiry Date · Status Reason.

| View name | Filter | Sort | Notes |
|---|---|---|---|
| **In Force Contracts** | Status Reason **equals** In Force | Expiry Date ascending | App default view |
| **Pending Approval Contracts** | Status Reason **equals** Pending Approval | Created On descending (add Created On as a column) | |
| **Draft Contracts** | Status Reason **equals** Draft | Created On descending | |
| **Rejected Contracts** | Status Reason **equals** Rejected | Modified On descending (add Modified On) | The default **Inactive Contracts** view also lists these |

Keep **Active Contracts** and **Inactive Contracts** as they are, but update their columns to the common list above.

### Steps (per view)

1. **Solutions** > `Muwafaqa` > **Contract** > **Views** > **Add view**. Enter the name, select **Create**.
2. In the view designer, select **+ View column** or drag from **Table columns**, and add the columns in order.
3. Select the **Status Reason** column header > **Filter by** and set the condition. Sorting: select the column header, then **Sort ascending / descending**.
4. **Publish**.
5. In the app designer, open the page **Contracts** and add the new views to the view list. Make **In Force Contracts** the default. *(Exact "set default" control: not verified.)*

## 5. System columns: show, hide, or lock

| Column | Created by | Decision | Reason and source |
|---|---|---|---|
| `transactioncurrencyid` (Currency) | Automatically with the first Currency column | **Show**, editable | Microsoft: this lookup lets people choose the currency that applies to the row. It also changes the currency symbol on the form. [Source](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields) |
| `exchangerate` (Exchange Rate) | Automatically | **Show, read-only** | Microsoft: "people can see the value, but they can't edit it". Same source |
| `mwf_value_base` (Value (Base)) | Automatically for the Currency column | **Show, read-only** | Microsoft: the `_Base` column stores the calculation of the value and the base currency, and "it can't be edited". Same source |

Notes:
- **Base amount is in TRY**, not USD. Label it clearly on the form if users may confuse it. Setting the Display name of `mwf_value_base` to "Value (Base, TRY)" would help, but changing a system-generated column's label was **not verified**.
- **Exchange rate meaning.** Verified by test in this environment: base amount = value ÷ rate, rate = units of the currency per 1 TRY. The Microsoft admin page for adding currencies describes the **Currency Conversion** field as "the value of the selected currency in terms of one US dollar". That wording does not match what the test showed with a TRY base. Trust the test, and treat the Microsoft wording as unreliable for non-USD bases. [Source](https://learn.microsoft.com/en-us/power-platform/admin/manage-transactions-with-multiple-currencies)
- The exchange rate is stored on the record at creation. Changing a currency record later does not necessarily update old rows (**not verified**, checklist item 3).
- A deactivated or deleted currency record: Microsoft states currencies in use cannot be deleted, only deactivated. [Source](https://learn.microsoft.com/en-us/power-platform/admin/manage-transactions-with-multiple-currencies)

## 6. Order of work (suggested)

1. App shell and navigation (section 1).
2. Contract form (section 2), then check by creating one test Contract by hand in USD, and confirm Exchange Rate and Value (Base) fill automatically.
3. Contract views (section 4).
4. Counterparty form and view (section 3).
5. Load test data with the script (see `scripts/load-test-data.mjs`).

## 6a. The Obligations page and the Obligations grid (added 2026-11-07, ADR-011)

**Not part of Phase 1.** This section records what exists in the app after the work of 2026-11-07.

**Read by the assistant (files of `src/` and the environment):**
- **The page:** `mwf_obligation` is a table component of the app (`AppModule.xml:16`) and the site map has a sub-area for it **under "Reference data"**, after the Approval Matrix (`AppModuleSiteMap.xml:33`). It could not be placed under "Contracts" (the owner could not drag it there; cosmetic).
- **The Obligation main form** holds Owner, Name, Contract, Party, Due Date and Obligation Status; the default of the status is the value of Open. Name is not required (the owner's statement).
- **The grid on the Contract main form:** a read-only grid (the subgrid control of the new designer) named "Obligations", in a new last section of the single tab (`mwf_Contract/FormXml/main/{a72298be-…}.xml`, lines 168 to 199): relationship `mwf_contract_obligation`, table `mwf_obligation`, view Active Obligations (the control is at line 179). **The form library `mwf_contract_form.js` and the onload handler are unchanged and still registered** (compared with the previous revision: the block from `formLibraries` to `events` is identical). The script locks only the five columns of ADR-004; it does not touch the grid, so the grid stays usable on a Pending Approval or In Force contract (owner decision 3 of ADR-011: adding obligations to an In Force contract is allowed).
- **The view Active Obligations shows only Name and Created On.** Because Name is not required, an obligation created by hand may look blank in the grid. **Changing the view columns is a pending step.**

**Reported by the owner, NOT verified by the assistant:** the work was done as System Administrator; the first two attempts to add the grid failed with "We ran into a problem adding the component" (cause unknown) and it worked after discarding and reopening the form in a fresh session; in the running app, on an In Force contract the script banner and the five locks still work, the Obligations section appears with a New Obligation button and Rows 0, and the Contract lookup on the Obligation form lists contracts; the Obligation form was saved and published.

**NOT tested:** creating an obligation (deliberately, to keep the baseline at 0), opening the app as a non-admin user (the four project roles are not linked to the app and have no privilege on the table: ADR-008, "Update 2026-11-07"), the email link.

## 7. Not verified

1. Exact label and location of the **Read-only** and **Required** properties in the modern form designer. The fetched form pages only link to the column-properties page.
2. Whether the default main form already contains the Currency, Exchange Rate, and Value (Base) columns after they were created through the API. Check the form before adding them.
3. Whether the navigation group editor in the modern app designer matches the steps in section 1. The fetched tutorial covers Add page and Save/Publish only.
4. How to set a default view for a page in the app designer.
5. Whether the Display name of the auto-created `mwf_value_base` can be changed.
6. Whether filtering a view on custom **Status Reason** options works through the view designer UI. Expected to work, since the options are normal Status Reason options.
7. Whether a Status Reason shown on the form can be limited to some options. Not possible without status transitions or code, and transitions are not enabled.

## 8. Sources

- [Build your first modern model-driven app](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/build-first-model-driven-app)
- [Create, edit, or configure forms using the model-driven form designer](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/create-and-edit-forms)
- [Create or edit model-driven app main forms](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/create-edit-main-forms)
- [Create or edit a model-driven app view](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/create-edit-views)
- [Create and edit public or system views](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/create-edit-views-app-designer)
- [Column data types in Dataverse (Using currency columns)](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields)
- [Manage transactions with multiple currencies](https://learn.microsoft.com/en-us/power-platform/admin/manage-transactions-with-multiple-currencies)
