#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Exact public bindings for the already approved four-contract scope.
set -euo pipefail
[[ $# -eq 0 ]] || { echo 'This dated approved launcher accepts no arguments.' >&2; exit 1; }
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$task_root/scripts/deploy-v4-mainnet.sh" --deploy \
  --review deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json \
  --approval config/v4-mainnet-deployment-approval-20261017-r2.json \
  --approval-sha256 8855e21f60b0c047160720cb86ddecd286542ca4ba8b21e039ba3f33e0f3ed35 \
  --plan-id e027124eb2c9bb9864a49768ade5e76b4c6df45c97c365992bb5a7fe21ae285a \
  --policy-sha256 b09a8692a6a0ddde7b262e846bba968a048c1672f2373d3d6e0d2b1db345f271 \
  --review-sha256 d126b5b47b5ba591b5f3f376e40416ac4949011679f54b77d3c19734e511fb30 \
  --accept-issuer-controls spcx \
  --accept-untested-v4
