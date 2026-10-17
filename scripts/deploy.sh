#!/usr/bin/env bash
# Local operator entry point. No default gas budget and no private-key export.
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root_dir"
mode="${1:---prepare}"
if [[ $# -gt 0 ]]; then shift; fi
budget=""; price=""; reserve=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'A value is required for every budget option.' >&2; exit 1; }
  case "$1" in
    --budget-wei) [[ -z "$budget" ]] || exit 1; budget="$2" ;;
    --max-fee-per-gas-wei) [[ -z "$price" ]] || exit 1; price="$2" ;;
    --reserve-wei) [[ -z "$reserve" ]] || exit 1; reserve="$2" ;;
    *) echo 'Unknown deployment option.' >&2; exit 1 ;;
  esac
  shift 2
done
[[ "$mode" == '--prepare' || "$mode" == '--deploy' ]] || { echo 'Use --prepare or --deploy.' >&2; exit 1; }
if [[ "$mode" == '--deploy' ]]; then
  [[ "$budget" =~ ^[1-9][0-9]*$ && "$price" =~ ^[1-9][0-9]*$ && "$reserve" =~ ^(0|[1-9][0-9]*)$ ]] || { echo 'Explicit --budget-wei, --max-fee-per-gas-wei and --reserve-wei are required.' >&2; exit 1; }
  [[ -t 0 && -t 2 ]] || { echo 'Run in your own interactive terminal to enter the keystore password.' >&2; exit 1; }
else
  [[ -z "$budget$price$reserve" ]] || { echo '--prepare accepts no spending limits.' >&2; exit 1; }
fi
node scripts/review/run.mjs check
snapshot="$root_dir/.phase1-private/mainnet-deployments/rc2-eth-usdg"
if [[ ! -e "$snapshot" ]]; then
  node scripts/core/prepare-mainnet-deployment.mjs --prepare
fi
node scripts/operations/check-deployment.mjs
if [[ "$mode" == '--prepare' ]]; then
  echo 'Prepared ETH/USDG core deployment. No key was accessed and no transaction was sent.'
  exit 0
fi
# Install only locked dependencies, with package lifecycle scripts disabled.
(cd "$snapshot" && npm ci --ignore-scripts --no-audit --no-fund)
node scripts/operations/check-deployment.mjs
account="$(node -p 'JSON.parse(require("fs").readFileSync("config/mainnet-operations.json")).deployer.signingAccount')"
echo "Robinhood mainnet 4663; local account: $account"
echo "ETH/USDG core only. No stock pools, DEX routes or cloud activation."
echo "Maximum cumulative deployment gas (wei): $budget; maximum gas price (wei): $price; retained balance (wei): $reserve"
umask 077
password_file="$(mktemp "${TMPDIR:-/tmp}/lincoln-deployment-password.XXXXXX")"
password_file="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$password_file")"
cleanup() { unset wallet_password; rm -f -- "$password_file"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r -s -p 'Keystore password (local only): ' wallet_password
printf '\n'
printf '%s' "$wallet_password" > "$password_file"
unset wallet_password
node "$snapshot/scripts/phase2-mainnet/deploy.mjs" --deploy \
  --account "$account" --password-file "$password_file" \
  --budget-wei "$budget" --max-fee-per-gas-wei "$price" --reserve-wei "$reserve"
