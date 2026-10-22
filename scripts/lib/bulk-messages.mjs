/**
 * Pure helpers of scripts/test-bulk-messages.mjs (bulk messages CreateMultiple / UpdateMultiple against the guard, the number generator and the
 * approval chain builder). No network, no ids, no addresses: everything here can be unit tested.
 *
 * Web API shapes (from Learn, "Use bulk operation messages"): POST <entity set>/Microsoft.Dynamics.CRM.CreateMultiple and
 * POST <entity set>/Microsoft.Dynamics.CRM.UpdateMultiple with { "Targets": [ { "@odata.type": "Microsoft.Dynamics.CRM.<logical name>", ... } ] }.
 * CreateMultiple answers 200 with { Ids: [...] }; UpdateMultiple answers 204. On a standard table any error rolls back the whole request.
 */

export const ENTITY = 'mwf_contract';
export const ENTITY_SET = 'mwf_contracts';

/** The request path of a bulk message for the contract table. */
export const bulkPath = (message) => `${ENTITY_SET}/Microsoft.Dynamics.CRM.${message}`;

/** The body of a bulk message: every Target gets its @odata.type (required by the platform). Input rows are not mutated. */
export function bulkBody(targets) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('a bulk message needs at least one target');
  return { Targets: targets.map((t) => ({ '@odata.type': `Microsoft.Dynamics.CRM.${ENTITY}`, ...t })) };
}

/** UpdateMultiple targets carry the primary key and only the columns that change. */
export const updateTarget = (id, changes) => ({ mwf_contractid: id, ...changes });

/** "ABC-0012" -> { prefix: 'ABC', n: 12 }, anything else -> null. The prefix may contain letters and digits. */
export function parseNumber(text) {
  const m = /^([A-Za-z0-9]+)-(\d{4,})$/.exec(String(text ?? ''));
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
}

/**
 * Checks the numbers a batch generated for ONE type against the counter before the batch.
 * @param last    counter value before the batch
 * @param prefix  the prefix of that type
 * @param numbers the numbers in the order of the Targets (strings)
 * @returns {{ok:boolean, setOk:boolean, inOrder:boolean, detail:string}}
 *   setOk: the suffixes are exactly last+1 .. last+k (no gap, no duplicate); inOrder: they also follow the order of the Targets
 */
export function checkSequence(last, prefix, numbers) {
  const parsed = numbers.map(parseNumber);
  if (parsed.some((p) => !p || p.prefix !== prefix)) return { ok: false, setOk: false, inOrder: false, detail: `a number does not look like ${prefix}-NNNN` };
  const suffixes = parsed.map((p) => p.n);
  const expected = numbers.map((_, i) => last + 1 + i);
  const sorted = [...suffixes].sort((a, b) => a - b);
  const setOk = sorted.every((v, i) => v === expected[i]);
  const inOrder = suffixes.every((v, i) => v === expected[i]);
  return { ok: setOk, setOk, inOrder, detail: `suffixes ${suffixes.join(',')} (expected ${expected.join(',')})` };
}

/** Types whose counter differs between two readings (both { [type]: {last} }). */
export function movedCounters(before, after) {
  return Object.keys(before).filter((t) => after[t] === undefined || before[t].last !== after[t].last);
}

/** Number of approval steps the seed matrix gives a value in USD (bands (min, max], value 0 on the first band): 10,000 / 50,000 / 100,000 / above. */
export function chainLengthFor(valueUsd) {
  if (valueUsd <= 10000) return 1;
  if (valueUsd <= 50000) return 2;
  if (valueUsd <= 100000) return 3;
  return 5;
}

/** A short, id-free summary of a failed batch for the log. */
export function failureText(status, message) {
  return `HTTP ${status}${message ? `: ${String(message).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

/** Whether every workflow row of the approval flows is OFF (statecode 0). rows: [{statecode}]. An empty list is not "all off". */
export function allFlowsOff(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every((r) => r.statecode === 0);
}
