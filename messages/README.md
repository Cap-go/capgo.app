## i18n

This directory keeps the English source catalog used by Vue i18n.

- `en.json` — English UI strings (source of truth for the app).
- `en.context.json` — translator context for each key (UI role + stable console area).

Non-English catalogs are generated on demand by the translation worker from `en.json`, using `en.context.json` to disambiguate meaning. Results are cached by a checksum of both files, so only English sources are committed.

Context areas are folder-based (not file names), so renames inside the same folder do not churn translation caches.

Regenerate contexts after adding or moving keys:

```bash
bun run i18n:contexts
```

Do not put context inside `en.json`: the inlang message-format schema and Vue i18n expect string values only.
