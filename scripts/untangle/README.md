# Untangle analysis scripts

Phase 1 only. No product code.

```bash
node scripts/untangle/import-graph.mjs > scripts/untangle/import-graph-summary.json
node scripts/untangle/cochange.mjs > scripts/untangle/cochange-summary.json
node scripts/untangle/skeleton.mjs
node scripts/untangle/comment-estimate.mjs
node scripts/untangle/find-candidates.mjs
```

Output for the decision log lives in `docs/untangle/decision-log.md`.
