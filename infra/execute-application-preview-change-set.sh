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

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^preview-ingress-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "usage: $0 preview-ingress-YYYYMMDDTHHMMSSZ" >&2
  exit 2
fi
CHANGE=$1
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
TYPE=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query ChangeSetType --output text)
STATUS=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query Status --output text)
EXECUTION_STATUS=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query ExecutionStatus --output text)
PREVIEW_DOMAIN=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query 'Parameters[?ParameterKey==`PreviewDomain`].ParameterValue|[0]' --output text)
PREVIEW_HOSTED_ZONE_ID=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query 'Parameters[?ParameterKey==`PreviewHostedZoneId`].ParameterValue|[0]' --output text)
PRICE_CLASS=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query 'Parameters[?ParameterKey==`PriceClass`].ParameterValue|[0]' --output text)
DARK_WORKER_VERSION=$(aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query 'Tags[?Key==`dark-worker-version`].Value|[0]' --output text)
if { [ "$TYPE" != CREATE ] && [ "$TYPE" != UPDATE ]; } || \
   [ "$STATUS" != CREATE_COMPLETE ] || [ "$EXECUTION_STATUS" != AVAILABLE ]; then
  echo "Change set is not executable: type=$TYPE status=$STATUS execution=$EXECUTION_STATUS" >&2
  exit 1
fi

aws cloudformation describe-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE" \
  --query '{Name:ChangeSetName,Type:ChangeSetType,Changes:Changes[*].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,Replacement:Replacement}}'
printf 'Nonsecret execution: changeSet=%s domain=%s zoneId=%s priceClass=%s darkWorkerVersion=%s\n' \
  "$CHANGE" "$PREVIEW_DOMAIN" "$PREVIEW_HOSTED_ZONE_ID" "$PRICE_CLASS" "$DARK_WORKER_VERSION"
printf 'Type EXECUTE:%s:%s:%s:%s:%s to approve: ' \
  "$CHANGE" "$PREVIEW_DOMAIN" "$PREVIEW_HOSTED_ZONE_ID" "$PRICE_CLASS" "$DARK_WORKER_VERSION"
read -r APPROVAL
EXPECTED_APPROVAL="EXECUTE:$CHANGE:$PREVIEW_DOMAIN:$PREVIEW_HOSTED_ZONE_ID:$PRICE_CLASS:$DARK_WORKER_VERSION"
if [ "$APPROVAL" != "$EXPECTED_APPROVAL" ]; then
  echo "Approval did not match the nonsecret proposal; nothing executed." >&2
  exit 2
fi
unset APPROVAL EXPECTED_APPROVAL

aws cloudformation execute-change-set --region us-east-1 \
  --stack-name "$STACK" --change-set-name "$CHANGE"
if [ "$TYPE" = CREATE ]; then
  aws cloudformation wait stack-create-complete --region us-east-1 \
    --stack-name "$STACK"
  aws cloudformation update-termination-protection --region us-east-1 \
    --stack-name "$STACK" --enable-termination-protection
else
  aws cloudformation wait stack-update-complete --region us-east-1 \
    --stack-name "$STACK"
fi

DISTRIBUTION_ID=$(aws cloudformation describe-stack-resource --region us-east-1 \
  --stack-name "$STACK" --logical-resource-id PreviewDistribution \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
aws cloudfront wait distribution-deployed --id "$DISTRIBUTION_ID"
echo "Stack operation and CloudFront propagation completed."
