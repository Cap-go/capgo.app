# Plans Checkout Completion Analytics

The current Plans analytics page measures checkout intent only. Completion must remain deferred until Capgo emits a reliable server-side `Checkout Completed` event.

The future event must contain `org_id`, a stable `checkout_attempt_id`, Stripe checkout session ID, product ID, recurrence, and completion timestamp. `Checkout Started` must carry the same `checkout_attempt_id` into Stripe metadata so completion is joined directly rather than inferred from a redirect.

The future full-width daily stacked chart uses the attributed Plans-opening UTC day. Each organization that started checkout that day appears once as Completed or Not completed. Recent attempts remain pending until the agreed observation window has elapsed; they must not be labeled abandoned prematurely.

Implementation requires a separate approved design for the observation window, late completions, retries, plan changes, and existing subscribers.
