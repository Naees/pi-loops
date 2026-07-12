# Contributing

Pi Loops is in early development. Discuss substantial behavior or architecture changes in an issue before implementation.

## Development

```text
npm install
npm run check
npm run pack:inspect
```

Keep changes focused, add tests for behavior changes, and update public documentation when the user contract changes.

Internal design records belong under `.project-design/` during development. Production code and tests must not import or read that directory. It will be removed before the first public release.
