#!/usr/bin/env bash
# Approved four-pool scope only; the local keystore password is entered interactively.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$task_root"
[[ $# -eq 0 ]] || { echo 'This command has no overrides; use the separately reviewed general runner.' >&2; exit 1; }
exec bash scripts/deploy-new-pools-mainnet.sh --deploy \
  --review deployments/robinhood-mainnet/verification/four-pool-review.json \
  --approval config/approved-four-pools-20261017.json \
  --plan-id d05c95c8343b1071185c1fa3b898601da2f4beb03686420bd3cff2c857eecc11 \
  --policy-sha256 014066331584e59d42bab7d2ae3f6693a13d3425192b967bc56b690631dfcc02 \
  --review-sha256 e5837d81cb30dd652a9ca8e45ffff874da033e4a835fc3d2141cd148a147c9d3 \
  --approval-sha256 8619cee330ec221dafbfccf405f42493a2e34379455ea0452c9a70f12c49d23e \
  --accept-issuer-controls aapl
