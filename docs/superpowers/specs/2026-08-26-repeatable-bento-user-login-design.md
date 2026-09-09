# Repeatable Bento frontend login

Map every existing frontend `User Login` source event to Bento `user:login` through the user-event registry with `delivery: 'every'` and no event-specific fields. The shared auth guard already emits before organization routing, covering self-signups, invited users, password, SSO, and magic-link sessions; delivery remains best-effort through the existing repeatable-event path. Test the exact mapping and delivery mode without changing authentication flows.
