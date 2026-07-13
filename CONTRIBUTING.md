# Contributing

Pi Loops is in early development. Discuss substantial behavior or architecture changes in an issue before implementation.

## Development

```text
npm install
npm run check
npm run security:check
npm run pack:inspect
npm run test:packed
npm run test:packed:state
npm run release:dry-run
```

Keep changes focused, add tests for behavior changes, and update public documentation when the user contract changes. `npm run release:candidate` runs the non-authenticated release-candidate baseline. `npm run release:candidate:runtime` additionally requires the validated macOS Pi 0.80.6 installation, authenticated model access, and production process-lifecycle gates; it does not publish.

Internal design records belong under `.project-design/` during development. Production code and tests must not import or read that directory. It will be removed before the first public release.
