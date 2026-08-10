## i18n

This directory keeps the English source catalog used by Vue i18n.

- `en.json` — English UI strings (source of truth for the app).
- `en.context.json` — translator context for each key (where/how the string is used).

Non-English catalogs are generated on demand by the translation worker from `en.json`, using `en.context.json` to disambiguate meaning. Results are cached by a checksum of both files, so only English sources are committed.

Regenerate contexts after adding or moving keys:

```bash
node scripts/generate-translation-contexts.mjs
```

Do not put context inside `en.json`: the inlang message-format schema and Vue i18n expect string values only.
