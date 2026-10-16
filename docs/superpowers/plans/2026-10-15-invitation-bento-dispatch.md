# Superseded invitation dispatcher plan

The partitioned, scheduled-recipient design in this draft was replaced before
shipping. The approved implementation is defined in
[the evaluation-runner specification](../specs/2026-10-16-bento-evaluation-runner.md)
and [its implementation plan](2026-10-16-bento-evaluation-runner.md).

The original CLI-created feature migration remains the single migration for the
unmerged feature and is rewritten to the approved two-table design. The already
shipped initial-email queue migration remains unchanged. Live Bento publication
continues to be deferred.
