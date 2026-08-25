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

STACK=odie-os-application-preview-ingress
EXPECTED_PROFILE=semantic-dev-rollout
if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi
if [ "${AWS_PROFILE:-}" != "$EXPECTED_PROFILE" ]; then
  echo "AWS_PROFILE must be $EXPECTED_PROFILE" >&2
  exit 2
fi
if [ "${AWS_REGION:-}" != "us-east-1" ] || [ "${AWS_DEFAULT_REGION:-}" != "us-east-1" ]; then
  echo "AWS_REGION and AWS_DEFAULT_REGION must both be us-east-1" >&2
  exit 2
fi
case $(aws --version 2>&1) in
  aws-cli/2.*) ;;
  *) echo "AWS CLI v2 is required." >&2; exit 2 ;;
esac
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT_ID" != 537124952465 ]; then
  echo "Refusing unexpected AWS account $ACCOUNT_ID." >&2
  exit 2
fi
unset ACCOUNT_ID

DISTRIBUTION_ID=$(aws cloudformation describe-stack-resource --region us-east-1 \
  --stack-name "$STACK" --logical-resource-id PreviewDistribution \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)

# GetDistributionConfig is secret-reading authority: the full response contains
# the custom origin HeaderValue. This narrow query is the only permitted output.
SUMMARY=$(aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" \
  --query 'DistributionConfig.{LoggingEnabled:Logging.Enabled,WebACLId:WebACLId,DefaultRealtimeLogArn:DefaultCacheBehavior.RealtimeLogConfigArn,OrderedCacheBehaviorCount:CacheBehaviors.Quantity,OrderedRealtimeLogAssociationCount:length(not_null(CacheBehaviors.Items, `[]`)[?RealtimeLogConfigArn]),CustomHeaderCount:Origins.Items[?Id==`sessions-worker`].OriginCustomHeaders.Quantity|[0],CustomHeaderNames:Origins.Items[?Id==`sessions-worker`].OriginCustomHeaders.Items[].HeaderName|[0]}' \
  --output json)
printf '%s\n' "$SUMMARY"

LOGGING=$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["LoggingEnabled"]).lower())')
WEB_ACL=$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["WebACLId"] or "")')
REALTIME=$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["DefaultRealtimeLogArn"] or "")')
ORDERED_REALTIME_COUNT=$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["OrderedRealtimeLogAssociationCount"])')
HEADER_OK=$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["CustomHeaderCount"] == 1 and d["CustomHeaderNames"] == "X-Odie-Preview-Ingress")')
if [ "$LOGGING" != false ] || [ -n "$WEB_ACL" ] || [ -n "$REALTIME" ] || [ "$ORDERED_REALTIME_COUNT" != 0 ] || [ "$HEADER_OK" != True ]; then
  echo "Distribution logging/security-header summary did not match the reviewed contract." >&2
  exit 1
fi
