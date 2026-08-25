# Coding-session GitHub Packages transport probe

This manual probe collects bounded, non-secret transport evidence for the two exact artifacts in the
server-private coding-session authority manifest. It does not enable package access, update the
manifest, run pnpm, or change any Worker behavior.

## Safety boundary

Run only the trusted shell launcher:

```text
scripts/probe-coding-session-github-packages
```

Do not invoke the adjacent `.mjs` module directly. The launcher rejects shell xtrace and never
selects Node from inherited `PATH`. The operator must approve a managed absolute Node binary path and
its lowercase SHA-256, then pass both as launcher-only arguments before all probe arguments. The
launcher verifies the binary with a trusted absolute system digest tool, verifies Node 24 in a clean
process, and starts the probe with an empty environment containing only a minimal `PATH` and its fixed
clean-launch sentinel. This clears
`NODE_OPTIONS`, debug settings, proxy variables, TLS/key-log overrides, and dynamic-loader variables
before Node starts. The Node process checks the sentinel and hazardous settings again.

The token must arrive through stdin. Never put it in an argument, environment variable, command
substitution that is expanded into an argument, shell history, `.npmrc`, or a file. Use an approved
secret source that writes the secret only to its stdout pipe. Do not enable `set -x`.

Record the two reviewed, non-secret Node facts without deriving either from `PATH`:

```sh
REVIEWED_NODE=/absolute/managed/node-24/bin/node
REVIEWED_NODE_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Bearer mode matches the audited `_authToken` configuration:

```sh
umask 077
approved_secret_source_command |
  scripts/probe-coding-session-github-packages \
    --node "$REVIEWED_NODE" --node-sha256 "$REVIEWED_NODE_SHA256" \
    --auth bearer >probe-candidate.json
status=$?
```

Basic mode is a separate explicit experiment. The username is non-secret, but must be the exact
approved GitHub login:

```sh
umask 077
approved_secret_source_command |
  scripts/probe-coding-session-github-packages \
    --node "$REVIEWED_NODE" --node-sha256 "$REVIEWED_NODE_SHA256" \
    --auth basic --username approved-login >probe-candidate.json
status=$?
```

Never try Bearer and Basic automatically with the same token. GitHub documents PAT classic as the
supported npm-registry credential. Acceptance of a GitHub App installation token would be empirical
evidence, not a supported contract.

## Redirect discovery and approval

The first run has no cross-host allowlist. If the exact GitHub Packages URL redirects to another
host, the probe stops nonzero and reports only a fixed error code, normalized hostname, HTTP status,
and authority identity hashes. It never reports the path, query, `Location`, or any header.

Review that exact hostname and its ownership/public routing. Then rerun with one exact lowercase
hostname:

```sh
umask 077
approved_secret_source_command |
  scripts/probe-coding-session-github-packages \
    --node "$REVIEWED_NODE" --node-sha256 "$REVIEWED_NODE_SHA256" \
    --auth bearer --allow-redirect-host exact-reviewed-host.example >probe-candidate.json
status=$?
```

Repeat `--allow-redirect-host` only for individually reviewed hosts. Wildcards and IP literals are
not accepted. Authorization is stripped permanently after any cross-host redirect, including if a
later redirect returns to `npm.pkg.github.com`.

The production probe resolves A and AAAA records with its own cancellable DNS resolver. It cancels
that resolver after five seconds or when the one-minute global probe deadline expires. This hard cap
describes the production resolver only; injected resolver seams exist solely for offline tests.

## Output and review

The launcher emits one bounded JSON document. Keep `umask 077` when redirecting it to a candidate
file. The variable evidence is limited to:

- deterministic schema and exact private-authority/source/artifact SHA-256 identity hashes;
- explicit auth mode;
- artifact ordinal;
- redirect hostname and status;
- normalized content type;
- Range support, truncation, observed prefix bytes, and total bytes;
- full-body bytes and integrity-match result.

Package names, repository names, paths, queries, signed URLs, headers, bodies, tokens, lockfile
digests, exceptions, and response messages are not emitted. An artifact ordinal maps to the private
manifest order without publishing that list.

A zero exit means both exact full bodies were at most 32 MiB, ended cleanly, and matched their locked
SHA-512 values. Any redirect requiring review, authentication rejection, DNS/SSRF check, timeout,
header anomaly, byte-limit violation, Range inconsistency, cleanup failure, or integrity mismatch is
nonzero. Do not treat a partial candidate file as complete evidence.

The probe never edits the authority manifest. Review candidate output from repeated runs, then update
transport facts manually in a separate review. Do not commit signed queries or widen an exact host to
a suffix wildcard. The authority remains incomplete and unavailable until every fact and credential
contract is approved.

## Package-manager compatibility remains blocked

The audited Agentic revision uses Node 24.14.x and pnpm 10.22.0 exactly. This probe requires Node 24
but deliberately does not invoke pnpm. It therefore provides no evidence that pnpm 10.22.0's exact
packument or tarball request shape matches a future Worker proxy. That compatibility test remains a
separate blocked step.
