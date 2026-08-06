# Stale Current Organization Fallback Design

## Problem

`fetchOrganizations()` keeps the current organization's ID while replacing the
organization map with fresh `get_orgs_v7` results. If the selected organization
is no longer present or selectable, the final lookup assigns `undefined` to
`currentOrganization` even when another selectable organization exists. The
`/apps` page then reports `Current organization is null, cannot fetch apps` and
renders an empty list.

This can happen after organization membership is revoked, an organization is
deleted, or another refresh leaves the client holding a selection that is no
longer valid for the authenticated user.

## Design

Selection restoration remains the responsibility of the organization store.
After fetching organizations, the store will preserve the in-memory selection
only when its ID occurs in the freshly computed `selectableOrganizations` list.
If it is invalid, the store will try the persisted organization ID using the
same validation. If neither candidate is valid, it will select the first
selectable organization, which is already ordered by application count.

The `/apps` page will not add retries or special recovery behavior. Every
consumer should observe the same valid store invariant: whenever at least one
selectable organization exists after a successful refresh,
`currentOrganization` references one of those fresh organization objects.

## Error Handling

The existing behavior for users with no selectable organizations remains
unchanged: the store clears the current selection and resolves initial loading
so the authentication flow can redirect to onboarding. RPC errors continue to
be surfaced by `fetchOrganizations()` and do not change selection state.

## Testing

Add a unit regression test around `fetchOrganizations()`:

1. Load an initial organization and select it.
2. Refresh with results that remove that organization but include another
   selectable organization.
3. Assert that the remaining organization becomes current and that the current
   selection is never left undefined.

The focused unit test must be observed failing before implementation and
passing after it. Run the full unit suite, lint, and typecheck before opening
the pull request.
