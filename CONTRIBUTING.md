# Contributing

Create a branch from the latest `main` and keep changes focused.

Run before opening a PR:

```bash
npm ci
npm run check
npm run build
npm test
```

Tests should exercise real filesystem and SQLite behavior and clean up resources they create.
