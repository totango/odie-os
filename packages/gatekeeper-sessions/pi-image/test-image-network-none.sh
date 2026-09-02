#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <image-ref>\n' "$0" >&2
  exit 2
fi

version_variables=(
  NODE_VERSION
  PNPM_PACKAGE_MANAGER
  REPOSITORY_PNPM_PACKAGE_MANAGER
  OPENCODE_VERSION
  PI_VERSION
  PI_MCP_ADAPTER_VERSION
  PRIME_AGENT_VERSION
  VALHALLA_VERSION
  CODE_SERVER_VERSION
)
for variable in "${version_variables[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'missing exact version contract: %s\n' "$variable" >&2
    exit 2
  fi
done

image_ref="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
smoke_script="$script_dir/smoke-image.sh"
runtime_name="coding-session-runtime-smoke-$$-$RANDOM"

cleanup() {
  docker rm --force "$runtime_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

run_bounded() {
  local seconds="$1"
  shift
  "$@" &
  local command_pid="$!"
  (
    sleep "$seconds"
    kill -TERM "$command_pid" 2>/dev/null || exit 0
    sleep 10
    kill -KILL "$command_pid" 2>/dev/null || true
  ) &
  local watchdog_pid="$!"
  local status=0
  wait "$command_pid" || status="$?"
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$status"
}

# First boot the image's normal Sandbox server under the same hard bounds as the CLI smoke. A local
# TCP response and the structured startup log prove liveness, but do not replace a deployed SDK test.
docker run --detach --rm \
  --name "$runtime_name" \
  --platform linux/amd64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
  --stop-timeout 10 \
  "$image_ref" >/dev/null

runtime_ready=false
for _ in $(seq 1 60); do
  # The single-quoted program is expanded by the container's Bash.
  # shellcheck disable=SC2016
  if run_bounded 2 docker exec "$runtime_name" /bin/bash -lc \
    'exec 3<>/dev/tcp/127.0.0.1/3000; printf "GET / HTTP/1.0\r\n\r\n" >&3; read -r response <&3; [[ "$response" == HTTP/* ]]' \
    >/dev/null 2>&1; then
    runtime_ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$runtime_name")" != "true" ]]; then
    break
  fi
  sleep 0.25
done
runtime_logs="$(docker logs "$runtime_name" 2>&1 || true)"
if [[ "$runtime_ready" != "true" ]] || ! grep --quiet '"message":"Container server started"' <<<"$runtime_logs"; then
  printf '%s\n' "$runtime_logs" >&2
  printf 'coding-session Sandbox runtime did not become ready\n' >&2
  exit 1
fi
docker stop --time 10 "$runtime_name" >/dev/null
runtime_name=""

version_args=()
for variable in "${version_variables[@]}"; do
  version_args+=(--env "$variable=${!variable}")
done

# The mounted smoke also runs local fake model/MCP endpoints plus real CLI tool loops. Keep the
# whole container bounded, but give OpenCode enough time to start its server and complete tool calls.
runtime_name="coding-session-cli-smoke-$$-$RANDOM"
run_bounded 420 docker run --rm \
  --name "$runtime_name" \
  --platform linux/amd64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --memory 2g \
  --cpus 1 \
  --stop-timeout 10 \
  --env HOME=/tmp/smoke-home \
  "${version_args[@]}" \
  --mount "type=bind,src=$smoke_script,dst=/smoke-image.sh,readonly" \
  --entrypoint /bin/bash \
  "$image_ref" /smoke-image.sh
