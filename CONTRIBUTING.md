# Contributing

Discuss substantial behavior or architecture changes in an issue before implementation. Keep changes focused, add tests for behavior changes, and update public documentation when the user contract changes.

## Validate changes

```text
npm ci
npm run release:candidate
```

`release:candidate` runs type checks, tests, coverage, security, package inspection, packed-install compatibility, scheduled-writer validation, and publication dry-run checks without publishing.

The stronger `npm run release:candidate:runtime` additionally requires an authenticated Pi 0.80.6 installation on a qualified macOS host. Native Linux and Windows lifecycle gates run through `.github/workflows/phase-5-qualification.yml`.
