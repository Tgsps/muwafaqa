/*
 * Muwafaqa - Contract main form: lock and unlock columns in the form (web resource mwf_contract_form.js).
 *
 * UX ONLY, NOT SECURITY. This script only disables controls on the form so that a user does not type into a column
 * the server will refuse. Anyone who uses the API, an import or another form is not affected by it. The enforcement is the
 * server-side Contract State Guard plug-in (docs/decisions/ADR-004-contract-state-guard.md); this file must never be
 * described as protection.
 *
 * Rule 1: the SAVED status decides. Draft (1): the five columns of ADR-004 are enabled. Any other status, and any unknown
 *         or empty value (fail-safe): the five columns are disabled. It runs at OnLoad and again after every save
 *         (PostSave, registered from OnLoad), so Rejected -> Draft unlocks the columns again.
 * Rule 2: while the columns are locked, an INFO form notification (fixed id) says why; it is cleared in the Draft case.
 *
 * Not touched on purpose (ADR-004): Contract Subject, the three dates and the owner stay editable in every status;
 * Contract Number, Exchange Rate, Value (Base) and Value (USD, Frozen) are disabled in the form XML itself.
 *
 * Registration (maker portal): library mwf_contract_form.js, ONE OnLoad handler: Muwafaqa.ContractForm.onLoad,
 * "Pass execution context as first parameter" ticked. See docs/contract-form-js.md.
 */
var Muwafaqa = Muwafaqa || {};
Muwafaqa.ContractForm = (function () {
  'use strict';

  var DRAFT = 1; // Status Reason "Draft" (docs/data-model-phase1.md, status mapping)
  var CREATE_FORM = 1; // Xrm form type: Create
  var NOTIFICATION_ID = 'mwf_contract_locked';
  var NOTIFICATION_TEXT =
    'This contract is no longer a Draft, so Value, Currency, Contract Type, Contract Direction and Counterparty are locked in this form. ' +
    'The server enforces this rule; this notice only explains it.';

  // The five columns of ADR-004 that are locked after submission. One list; a unit test compares it with the ADR table.
  var LOCKED_COLUMNS = Object.freeze([
    'mwf_value',
    'transactioncurrencyid',
    'mwf_contracttype',
    'mwf_direction',
    'mwf_counterpartyid'
  ]);

  // Pure: which columns must be disabled for a saved status value. Only Draft unlocks; everything else locks (fail-safe).
  function lockedColumnsFor(statusValue) {
    return statusValue === DRAFT ? [] : LOCKED_COLUMNS.slice();
  }

  function readStatus(formContext) {
    var attribute = formContext.getAttribute('statuscode');
    var value = attribute ? attribute.getValue() : null;
    // A new record can have no status value yet; the server only accepts Draft on Create (ADR-004), so a Create form is a Draft.
    if ((value === null || value === undefined) && formContext.ui && formContext.ui.getFormType && formContext.ui.getFormType() === CREATE_FORM) {
      return DRAFT;
    }
    return value;
  }

  function warn(message, error) {
    if (typeof console !== 'undefined' && console.warn) console.warn('mwf_contract_form: ' + message, error);
  }

  // Through the ATTRIBUTE, not getControl(name): getControl matches the control NAME (the control id in the form XML), which
  // is a GUID for four of the five columns, and returns only the first control when a column has several. attribute.controls
  // covers every control bound to the column. A missing attribute is skipped; a failure on one column (or one control)
  // is logged and never stops the others.
  function setColumnDisabled(formContext, name, disabled) {
    try {
      var attribute = formContext.getAttribute(name);
      if (!attribute) return;
      attribute.controls.forEach(function (control) {
        try {
          control.setDisabled(disabled);
        } catch (controlError) {
          warn('setDisabled failed on a control of ' + name, controlError);
        }
      });
    } catch (columnError) {
      warn('could not change ' + name, columnError);
    }
  }

  function apply(formContext) {
    var locked = lockedColumnsFor(readStatus(formContext));
    LOCKED_COLUMNS.forEach(function (name) {
      setColumnDisabled(formContext, name, locked.indexOf(name) !== -1);
    });
    try {
      if (locked.length > 0) formContext.ui.setFormNotification(NOTIFICATION_TEXT, 'INFO', NOTIFICATION_ID);
      else formContext.ui.clearFormNotification(NOTIFICATION_ID);
    } catch (notificationError) {
      warn('could not change the notification', notificationError);
    }
  }

  function onPostSave(executionContext) {
    apply(executionContext.getFormContext());
  }

  function onLoad(executionContext) {
    var formContext = executionContext.getFormContext();
    apply(formContext);
    formContext.data.entity.addOnPostSave(onPostSave);
  }

  return {
    LOCKED_COLUMNS: LOCKED_COLUMNS,
    lockedColumnsFor: lockedColumnsFor,
    onLoad: onLoad,
    onPostSave: onPostSave
  };
})();

// Lets the unit tests (node) load this file; in the browser `module` does not exist and nothing happens.
if (typeof module !== 'undefined' && module.exports) module.exports = Muwafaqa.ContractForm;
