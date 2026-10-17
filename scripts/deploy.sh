#!/usr/bin/env bash
# RC.2 is archived. Never resume its obsolete 24-hour mainnet pool deployment.
set -euo pipefail
echo 'RC2_MAINNET_DEPLOYMENT_PAUSED: use scripts/deploy-mainnet.sh for the reviewed RC.3 candidate. Preserve the original snapshot and account ledger.' >&2
exit 1
