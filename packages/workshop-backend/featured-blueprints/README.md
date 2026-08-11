# Featured starter blueprints

Each subdirectory is bundled at build time into an ownerless ordinary blueprint and listed in the
deployment's featured collection on first `/api` traffic.

Required structure:

```text
<slug>/
  blueprint.json
  client.js
  server.js
  README.md
```

`blueprint.json` accepts `blueprintId`, `title`, `description`, `author`, and `revision`.
Existing starters may include an empty `bindings` array/object for source readability, but bundled
starters currently install with no required bindings. Keep `blueprintId` stable after deploy;
installation and updates are keyed by it.
