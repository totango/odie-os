# GitHub Actions Deployment

The `Release` workflow publishes immutable release artifacts for the hosted deployment service. It
does not run `wrangler deploy` against the production instance. Instance-specific bindings, resource
IDs, and Worker secrets remain owned by the deployment service rather than this repository.

## Flow

1. Pull requests and `main` run `.github/workflows/ci.yml` without deployment credentials.
2. After a push-triggered `CI` workflow succeeds on `main`, or after a manual workflow dispatch from
   `main`, the tested commit is checked out and built as an immutable GitHub Actions artifact. This
   unprivileged job receives no deployment credentials.
3. The `promote` job waits for approval from the protected `production` GitHub environment, then
   downloads the exact artifact and uploads it under `candidates/<releaseId>/manifest.json`.
4. The approved job copies the candidate manifest to `releases/<releaseId>/manifest.json`. The deployment
   service sees only promoted manifests and applies the release to configured instances.

GitHub Actions concurrency prevents two release workflows or production promotions from publishing
at the same time. The promotion script also refuses to publish a candidate when a newer workflow run
has already been released.

## Credentials

Configure these as Actions secrets on the protected GitHub `production` environment:

```text
RELEASE_R2_ENDPOINT
RELEASE_R2_BUCKET
RELEASE_R2_ACCESS_KEY_ID
RELEASE_R2_SECRET_ACCESS_KEY
```

Use credentials scoped to the release bucket only. Contributors do not need Cloudflare accounts or
access to these values: GitHub injects them only after approval into the `production` job. The job
that checks out and builds repository code never receives deployment credentials.

The `production` environment must require approval from the deployment maintainers. Environment
approval controls publication; branch protection, pull-request review, and required `Lint` and
`Build and test` checks control what reaches `main`.

## Rollback

Roll back through the deployment service by selecting a previously promoted release. Direct
`wrangler deploy` or Worker version rollback is a break-glass operation only because generic package
Wrangler files do not contain an instance's complete production bindings.
