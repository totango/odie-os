# GitHub Actions Deployment

The `Deploy production` workflow deploys this repository's Odie instance directly to its Cloudflare
account after the tested commit reaches `main`. Contributors need GitHub access only; Cloudflare
authority is held by the protected `production` GitHub environment.

## Flow

1. Pull requests and `main` run `.github/workflows/ci.yml` without deployment credentials.
2. A successful push-triggered `CI` run on `main`, or a manual dispatch from `main`, starts the
   production workflow for that exact commit.
3. A credential-free job builds deploy-ready Worker bundles and Access-mode frontend assets, strips
   custom build commands from their upload configs, and stores the result as an immutable workflow
   artifact. The artifact builder performs its own frontend build with Cloudflare Access mode enabled
   immediately before packaging, so it cannot reuse a default-mode `dist` directory.
4. Before entering the production approval queue, the workflow verifies that the commit is still the
   current `main` tip. Manual dispatches must also find a successful push-triggered CI run for that
   exact commit.
5. The protected job downloads only the prebuilt artifact, without checking out repository code or
   installing repository dependencies, and deploys the gatekeepers, backend, and router sequentially.
   The Cloudflare token is available only to the credential check and Wrangler upload steps.
6. The workflow verifies that an unauthenticated request still redirects to Cloudflare Access and
   stores Wrangler's deployment receipts as a GitHub Actions artifact.

## Configuration

Each deployed package has a checked-in `wrangler.odie-os-production.jsonc`. These files contain the
instance's Worker names, public settings, bindings, and resource identifiers, but no secret values.
Review configuration changes like code changes: deploying an incomplete config can remove a binding.
The artifact builder rejects unknown top-level config keys and requires public preview URLs to be
disabled.

Worker application secrets remain encrypted in Cloudflare and are preserved when a deploy omits a
secrets file. Do not add OAuth secrets, private keys, HMAC values, access tokens, or bearer tokens to
the tracked Wrangler files. Before uploading, the protected job verifies that the required production
secret names still exist without reading their values.

Configure the protected `production` environment with:

- Variable `CLOUDFLARE_ACCOUNT_ID`: the Odie instance's Cloudflare account ID.
- Secret `CLOUDFLARE_API_TOKEN`: an account-owned API token scoped to this account with the minimum
  permissions needed to deploy the configured Workers, Containers, and assets.

The environment requires a deployment-maintainer approval and prevents self-approval. Branch
protection, pull-request review, and required `Lint` and `Build and test` checks control what reaches
`main`.

## Rollback

Use Cloudflare Worker version rollback for the affected worker, or revert the source commit and run
the workflow again. Keep deployment receipts for 30 days to identify the versions produced by each
workflow run.
