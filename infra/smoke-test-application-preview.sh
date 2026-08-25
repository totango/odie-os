#!/bin/bash
set +x
set -euo pipefail
export AWS_PAGER=""

assert_cli_history_disabled() {
  local configured_history environment_history value
  environment_history=${AWS_CLI_HISTORY:-}
  configured_history=
  if command -v aws >/dev/null 2>&1; then
    configured_history=$(aws configure get cli_history 2>/dev/null || true)
  fi
  for value in "$environment_history" "$configured_history"; do
    case $(printf '%s' "$value" | tr '[:upper:]' '[:lower:]') in
      enabled|true|on|1)
        echo "AWS CLI history must be disabled before this script runs." >&2
        exit 2
        ;;
    esac
  done
}

assert_cli_history_disabled

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <approved-preview-domain> <reviewed-nonsecret-body-marker>" >&2
  exit 2
fi
PREVIEW_DOMAIN=$1
EXPECTED_BODY_MARKER=$2
if ! [[ "$PREVIEW_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "Invalid preview domain." >&2
  exit 2
fi
if ! [[ "$EXPECTED_BODY_MARKER" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  echo "Expected body marker must be a reviewed nonsecret token." >&2
  exit 2
fi
read -rsp 'Short-lived sacrificial preview label: ' PREVIEW_LABEL
echo
if ! [[ "$PREVIEW_LABEL" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  unset PREVIEW_LABEL
  echo "Invalid preview label." >&2
  exit 2
fi

# The capability label travels only on stdin, never in shell history or argv.
printf %s "$PREVIEW_LABEL" | python3 -c '
import http.client, sys
try:
    label = sys.stdin.read()
    domain = sys.argv[1]
    expected_marker = sys.argv[2].encode("ascii")
    host = f"{label}.{domain}"
    for attempt in range(2):
        connection = http.client.HTTPSConnection(host, timeout=30)
        connection.request("GET", "/")
        response = connection.getresponse()
        body = response.read(1048577)
        age = response.getheader("Age")
        x_cache = response.getheader("X-Cache") or ""
        status = response.status
        connection.close()
        if (status != 200 or len(body) > 1048576 or expected_marker not in body or
                age is not None or not x_cache.lower().startswith("miss from cloudfront")):
            raise RuntimeError("preview response contract failed")
        print({"attempt": attempt + 1, "status": status,
               "agePresent": False, "cloudFrontCacheResult": "Miss"})
except Exception:
    print("Preview HTTPS/cache smoke test failed.", file=sys.stderr)
    raise SystemExit(1)
' "$PREVIEW_DOMAIN" "$EXPECTED_BODY_MARKER"
unset PREVIEW_LABEL EXPECTED_BODY_MARKER

# This synthetic direct-origin request contains no real capability or secret.
python3 -c '
import http.client, sys
try:
    connection = http.client.HTTPSConnection("odie-os-gk-sessions.odie-os.workers.dev", timeout=30)
    connection.request("GET", "/gatekeeper/sessions/application-preview/synthetic-invalid/")
    response = connection.getresponse()
    body = response.read(4096)
    status = response.status
    connection.close()
    if status != 404 or b"synthetic-invalid" in body:
        raise RuntimeError("direct-origin contract failed")
    print({"directOriginWithoutIngressStatus": 404})
except Exception:
    print("Direct-origin rejection smoke test failed.", file=sys.stderr)
    raise SystemExit(1)
'
