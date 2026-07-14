# Contributing

Discuss substantial behavior or architecture changes in an issue before implementation. Keep changes focused, add tests for behavior changes, and update public documentation when the user contract changes.

## Validate changes

```text
npm ci
npm run release:candidate
```

`release:candidate` runs type checks, tests, coverage, security, package inspection, packed-install compatibility, scheduled-writer validation, and publication dry-run checks without publishing.

The stronger `npm run release:candidate:runtime` additionally requires an authenticated Pi 0.80.6 installation on a qualified macOS host. Native Linux and Windows lifecycle gates run through `.github/workflows/phase-5-qualification.yml`.

## Release

Releases are deliberate and never performed by the candidate workflows.

1. Update the package version and changelog in a focused change.
2. From a clean qualified macOS checkout, run `npm ci` and `npm run release:check`.
3. Confirm CI, security, and Phase 5 qualification pass for the release commit.
4. Inspect the npm tarball, inventory, SBOM, and checksum produced by the release-candidate workflow.
5. Merge the reviewed release commit into `main`, then create and push the protected matching `v<version>` tag.
6. From `main`, dispatch `.github/workflows/publish.yml` with that tag through the protected `npm` environment.

Before the first dispatch, create the GitHub `npm` environment, require reviewers, and restrict deployment to protected branches. For the initial publication, place a short-lived granular token in the environment's `NPM_TOKEN` secret. After the package exists, configure npm trusted publishing for `Naees/pi-loops`, workflow `publish.yml`, environment `npm`, and the `npm publish` action, then remove `NPM_TOKEN`. The workflow rebuilds and checks the tagged candidate without OIDC access; only the separate artifact-publishing job receives the token and OIDC permission needed for provenance. It must not be run until every release gate is green.
