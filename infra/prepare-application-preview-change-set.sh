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
TEMPLATE=infra/application-preview-ingress.yaml
EXPECTED_PROFILE=semantic-dev-rollout
USE_PREVIOUS=false

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <approved-preview-domain> <hosted-zone-id> <dark-worker-version> [--use-previous-secret]" >&2
  exit 2
fi
PREVIEW_DOMAIN=$1
PREVIEW_HOSTED_ZONE_ID=$2
DARK_WORKER_VERSION=$3
if [ "${4:-}" = "--use-previous-secret" ]; then
  USE_PREVIOUS=true
elif [ "$#" -eq 4 ]; then
  echo "usage: $0 <approved-preview-domain> <hosted-zone-id> <dark-worker-version> [--use-previous-secret]" >&2
  exit 2
fi
if ! [[ "$PREVIEW_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
   [ "${#PREVIEW_DOMAIN}" -gt 253 ]; then
  echo "Preview domain must be a lower-case DNS apex without a wildcard." >&2
  exit 2
fi
if [ "$PREVIEW_DOMAIN" = totango.com ] || [[ "$PREVIEW_DOMAIN" = *.totango.com ]]; then
  echo "Any totango.com domain is forbidden for user-authored previews." >&2
  exit 2
fi
if ! [[ "$PREVIEW_HOSTED_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]]; then
  echo "Invalid Route53 hosted zone ID." >&2
  exit 2
fi
if ! [[ "$DARK_WORKER_VERSION" =~ ^([0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$ ]]; then
  echo "Dark Worker version must be an exact 40-hex commit SHA or immutable UUID." >&2
  exit 2
fi
ALIAS="*.$PREVIEW_DOMAIN"
PRICE_CLASS=PriceClass_100

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
if ! command -v cfn-lint >/dev/null 2>&1 ||
   [ "$(cfn-lint --version 2>/dev/null)" != "cfn-lint 1.55.1" ]; then
  echo "cfn-lint 1.55.1 is required; install the pinned version before running" >&2
  exit 2
fi

PARAMS=
DESCRIBE_ERROR=
cleanup() {
  if [ -n "$PARAMS" ]; then rm -f "$PARAMS"; fi
  if [ -n "$DESCRIBE_ERROR" ]; then rm -f "$DESCRIBE_ERROR"; fi
}
trap cleanup EXIT HUP INT TERM
umask 077
DESCRIBE_ERROR=$(mktemp)

# These calls validate identity, region inputs, read permissions, template
# shape, current use, and ownership conflicts before accepting a secret.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT_ID" != 537124952465 ]; then
  echo "Refusing unexpected AWS account $ACCOUNT_ID." >&2
  exit 2
fi
unset ACCOUNT_ID
cfn-lint "$TEMPLATE"
aws cloudformation validate-template --region us-east-1 \
  --template-body "file://$TEMPLATE" >/dev/null
ZONE_NAME=$(aws route53 get-hosted-zone --id "$PREVIEW_HOSTED_ZONE_ID" \
  --query 'HostedZone.Name' --output text)
ZONE_PRIVATE=$(aws route53 get-hosted-zone --id "$PREVIEW_HOSTED_ZONE_ID" \
  --query 'HostedZone.Config.PrivateZone' --output text)
ZONE_NAME=${ZONE_NAME%.}
if [ "$ZONE_PRIVATE" != False ]; then
  echo "Preview hosted zone must be public." >&2
  exit 2
fi
if [ "$PREVIEW_DOMAIN" != "$ZONE_NAME" ] && [[ "$PREVIEW_DOMAIN" != *.$ZONE_NAME ]]; then
  echo "Hosted-zone name must equal or be a DNS ancestor of PreviewDomain." >&2
  exit 2
fi
aws acm list-certificates --region us-east-1 --max-items 1 \
  --query 'CertificateSummaryList[].CertificateArn' >/dev/null

# These are external evidence gates, not claims made by this repository.
printf 'Nonsecret proposal: domain=%s zoneId=%s zoneName=%s priceClass=%s darkWorkerVersion=%s\n' \
  "$PREVIEW_DOMAIN" "$PREVIEW_HOSTED_ZONE_ID" "$ZONE_NAME" "$PRICE_CLASS" "$DARK_WORKER_VERSION"
echo "Required isolation evidence: dedicated untrusted-only domain, no trusted apps/cookies, and exact apex live as a public/private suffix."
printf 'Type SECURITY-APPROVED:%s:%s:%s to bind that evidence: ' \
  "$PREVIEW_DOMAIN" "$PREVIEW_HOSTED_ZONE_ID" "$PRICE_CLASS"
read -r ISOLATION_APPROVAL
EXPECTED_ISOLATION_APPROVAL="SECURITY-APPROVED:$PREVIEW_DOMAIN:$PREVIEW_HOSTED_ZONE_ID:$PRICE_CLASS"
if [ "$ISOLATION_APPROVAL" != "$EXPECTED_ISOLATION_APPROVAL" ]; then
  echo "Preview isolation prerequisite was not bound to this proposal." >&2
  exit 2
fi
unset ISOLATION_APPROVAL EXPECTED_ISOLATION_APPROVAL
echo "Required dark-Worker evidence: exact immutable version landed first; ingress rejection/header stripping/no capability logs verified; permanent globally nonreused label and tombstone non-revival tests passed."
printf 'Type DARK-WORKER-VERIFIED:%s to bind that evidence: ' "$DARK_WORKER_VERSION"
read -r WORKER_APPROVAL
if [ "$WORKER_APPROVAL" != "DARK-WORKER-VERIFIED:$DARK_WORKER_VERSION" ]; then
  echo "Dark Worker evidence was not bound to this immutable version." >&2
  exit 2
fi
unset WORKER_APPROVAL

DISTRIBUTION_COUNT=$(aws cloudfront list-distributions \
  --query 'DistributionList.Quantity' --output text)
LIVE_FUNCTION_COUNT=$(aws cloudfront list-functions --stage LIVE \
  --query 'FunctionList.Quantity' --output text)
DEVELOPMENT_FUNCTION_COUNT=$(aws cloudfront list-functions --stage DEVELOPMENT \
  --query 'FunctionList.Quantity' --output text)
printf 'Current CloudFront use: %s distributions, %s live Functions, %s development Functions.\n' \
  "$DISTRIBUTION_COUNT" "$LIVE_FUNCTION_COUNT" "$DEVELOPMENT_FUNCTION_COUNT"
aws service-quotas list-service-quotas --service-code cloudfront \
  --query 'Quotas[?contains(QuotaName, `distribution`) || contains(QuotaName, `Distribution`) || contains(QuotaName, `function`) || contains(QuotaName, `Function`)].{Name:QuotaName,Value:Value,Adjustable:Adjustable}' \
  --output table

TYPE=UPDATE
if aws cloudformation describe-stacks --region us-east-1 \
  --stack-name "$STACK" >/dev/null 2>"$DESCRIBE_ERROR"; then
  :
elif grep -q 'ValidationError).*does not exist' "$DESCRIBE_ERROR"; then
  TYPE=CREATE
else
  echo "Could not determine stack existence; refusing to infer CREATE:" >&2
  cat "$DESCRIBE_ERROR" >&2
  exit 1
fi
rm -f "$DESCRIBE_ERROR"
DESCRIBE_ERROR=

if [ "$TYPE" = UPDATE ]; then
  CURRENT_DOMAIN=$(aws cloudformation describe-stacks --region us-east-1 \
    --stack-name "$STACK" \
    --query 'Stacks[0].Parameters[?ParameterKey==`PreviewDomain`].ParameterValue|[0]' --output text)
  CURRENT_ZONE=$(aws cloudformation describe-stacks --region us-east-1 \
    --stack-name "$STACK" \
    --query 'Stacks[0].Parameters[?ParameterKey==`PreviewHostedZoneId`].ParameterValue|[0]' --output text)
  if [ "$CURRENT_DOMAIN" != "$PREVIEW_DOMAIN" ] || [ "$CURRENT_ZONE" != "$PREVIEW_HOSTED_ZONE_ID" ]; then
    echo "Domain or hosted-zone changes are forbidden in an ordinary UPDATE; use a separately reviewed migration plan." >&2
    exit 2
  fi
fi

ALIASED_IDS=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Quantity > \`0\` && contains(Aliases.Items, \`$ALIAS\`)].Id" \
  --output text)
RRSET_TYPES=$(aws route53 list-resource-record-sets \
  --hosted-zone-id "$PREVIEW_HOSTED_ZONE_ID" \
  --query "ResourceRecordSets[?Name==\`$ALIAS.\`].Type" \
  --output text)
LIVE_FUNCTION_NAME=$(aws cloudfront list-functions --stage LIVE \
  --query 'FunctionList.Items[?Name==`odie-os-application-preview-host-router`].Name' \
  --output text)
DEVELOPMENT_FUNCTION_NAME=$(aws cloudfront list-functions --stage DEVELOPMENT \
  --query 'FunctionList.Items[?Name==`odie-os-application-preview-host-router`].Name' \
  --output text)
if [ "$TYPE" = CREATE ]; then
  if [ -n "$ALIASED_IDS" ] || [ -n "$RRSET_TYPES" ] || [ -n "$LIVE_FUNCTION_NAME" ] || [ -n "$DEVELOPMENT_FUNCTION_NAME" ]; then
    echo "Wildcard alias, Route53 RRSet, or Function name already exists; refusing CREATE." >&2
    printf 'Distribution IDs: %s; RRSet types: %s; Function: %s\n' "$ALIASED_IDS" "$RRSET_TYPES" "$LIVE_FUNCTION_NAME/$DEVELOPMENT_FUNCTION_NAME" >&2
    exit 1
  fi
else
  if [ "$LIVE_FUNCTION_NAME" != odie-os-application-preview-host-router ] ||
     [ "$DEVELOPMENT_FUNCTION_NAME" != odie-os-application-preview-host-router ]; then
    echo "Existing stack Function is missing or has drifted." >&2
    exit 1
  fi
  EXPECTED_ID=$(aws cloudformation describe-stack-resource --region us-east-1 \
    --stack-name "$STACK" --logical-resource-id PreviewDistribution \
    --query 'StackResourceDetail.PhysicalResourceId' --output text)
  for ID in $ALIASED_IDS; do
    if [ "$ID" != "$EXPECTED_ID" ]; then
      echo "Wildcard alias is also attached to unexpected distribution $ID" >&2
      exit 1
    fi
  done
  if [ "$RRSET_TYPES" != $'A\tAAAA' ] && [ "$RRSET_TYPES" != $'AAAA\tA' ]; then
    echo "Existing stack does not own both expected wildcard A/AAAA records." >&2
    exit 1
  fi
fi

PARAMS=$(mktemp)
if [ "$USE_PREVIOUS" = true ]; then
  if [ "$TYPE" = CREATE ]; then
    echo "A new stack cannot use a previous parameter value." >&2
    exit 2
  fi
  printf '%s\n' \
    "[{\"ParameterKey\":\"PreviewIngressSecret\",\"UsePreviousValue\":true},{\"ParameterKey\":\"PreviewDomain\",\"ParameterValue\":\"$PREVIEW_DOMAIN\"},{\"ParameterKey\":\"PreviewHostedZoneId\",\"ParameterValue\":\"$PREVIEW_HOSTED_ZONE_ID\"},{\"ParameterKey\":\"PriceClass\",\"ParameterValue\":\"$PRICE_CLASS\"}]" >"$PARAMS"
else
  read -rsp 'Approved 64-character lower-case hexadecimal ingress secret: ' SECRET
  echo
  if ! [[ "$SECRET" =~ ^[0-9a-f]{64}$ ]]; then
    unset SECRET
    echo "Secret must be exactly 64 lower-case hexadecimal characters." >&2
    exit 2
  fi
  printf %s "$SECRET" | python3 -c \
    'import json,sys; json.dump([{"ParameterKey":"PreviewIngressSecret","ParameterValue":sys.stdin.read()},{"ParameterKey":"PreviewDomain","ParameterValue":sys.argv[1]},{"ParameterKey":"PreviewHostedZoneId","ParameterValue":sys.argv[2]},{"ParameterKey":"PriceClass","ParameterValue":sys.argv[3]}],sys.stdout)' \
    "$PREVIEW_DOMAIN" "$PREVIEW_HOSTED_ZONE_ID" "$PRICE_CLASS" >"$PARAMS"
  unset SECRET
fi

CHANGE="preview-ingress-$(date -u +%Y%m%dT%H%M%SZ)"
aws cloudformation create-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --change-set-type "$TYPE" --template-body "file://$TEMPLATE" \
  --parameters "file://$PARAMS" \
  --tags Key=service,Value=odie-os-application-preview Key=dark-worker-version,Value="$DARK_WORKER_VERSION"
rm -f "$PARAMS"
PARAMS=

if ! aws cloudformation wait change-set-create-complete --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE"; then
  STATUS=$(aws cloudformation describe-change-set --region us-east-1 \
    --stack-name "$STACK" --change-set-name "$CHANGE" \
    --query Status --output text)
  REASON=$(aws cloudformation describe-change-set --region us-east-1 \
    --stack-name "$STACK" --change-set-name "$CHANGE" \
    --query StatusReason --output text)
  if [ "$TYPE" = UPDATE ] && [ "$STATUS" = FAILED ] && \
     printf '%s' "$REASON" | grep -Eq "didn't contain changes|No updates are to be performed"; then
    aws cloudformation delete-change-set --region us-east-1 \
      --stack-name "$STACK" --change-set-name "$CHANGE"
    echo "No infrastructure changes; deleted the failed no-op change set."
    exit 0
  fi
  echo "Change set creation failed: $STATUS: $REASON" >&2
  exit 1
fi

aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query '{Name:ChangeSetName,Type:ChangeSetType,Status:Status,ExecutionStatus:ExecutionStatus,Changes:Changes[*].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,Replacement:Replacement}}'
echo "Review the change set. In a fresh approval terminal, run:"
echo "  infra/execute-application-preview-change-set.sh $CHANGE"
