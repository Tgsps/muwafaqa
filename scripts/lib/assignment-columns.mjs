// Names of the Approver Assignment table that scripts send to the Web API, in one place.
//
// USER_BIND_KEY is the key of the lookup mwf_user (to systemuser) in a request body. The part before @odata.bind is the NAVIGATION PROPERTY name, which is
// case-sensitive and is NOT the column's logical name: for this lookup it is "mwf_User" (capital U), read from the entity metadata on 2026-10-25
// (ManyToOneRelationships, ReferencingEntityNavigationPropertyName). "mwf_user@odata.bind" is refused with HTTP 400 "Error identified in Payload".
// scripts/load-approver-assignment.mjs and scripts/test-auditing-user-change.mjs both use this constant; a unit test keeps them equal.
export const USER_BIND_KEY = 'mwf_User@odata.bind';
