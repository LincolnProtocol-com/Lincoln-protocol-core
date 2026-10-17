#!/usr/bin/env bash
# RC.3 continuation entry: preserve the original account ledger and gas limits.
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
[[ "$mode" == '--prepare' || "$mode" == '--deploy' || "$mode" == '--plan' ]] || { echo 'Use --prepare, --plan or --deploy.' >&2; exit 1; }
if [[ "$mode" == '--deploy' ]]; then
  [[ "$budget" =~ ^[1-9][0-9]*$ && "$price" =~ ^[1-9][0-9]*$ && "$reserve" =~ ^(0|[1-9][0-9]*)$ ]] || { echo 'Explicit --budget-wei, --max-fee-per-gas-wei and --reserve-wei are required.' >&2; exit 1; }
  [[ -t 0 && -t 2 ]] || { echo 'Run in your own interactive terminal to enter the keystore password.' >&2; exit 1; }
else
  [[ -z "$budget$price$reserve" ]] || { echo '--prepare and --plan accept no spending limits.' >&2; exit 1; }
fi
node scripts/review/run.mjs check
if [[ "$mode" == '--plan' ]]; then
  node scripts/operations/mainnet-rc3.mjs --plan
  exit 0
fi
snapshot="$root_dir/.phase1-private/mainnet-deployments/rc3-eth-usdg"
if [[ ! -e "$snapshot" ]]; then
  node scripts/operations/mainnet-rc3.mjs --prepare
fi
if [[ "$mode" == '--prepare' ]]; then
  node scripts/operations/mainnet-rc3.mjs --check
  echo 'RC.3 ETH/USDG snapshot prepared. No password was read and no transaction was sent.'
  echo 'An unresolved original transaction blocks --deploy; recovery is a separate explicit operation.'
  exit 0
fi
# Match the original ledger limits before npm or password handling.
node scripts/operations/mainnet-rc3.mjs --check \
  --budget-wei "$budget" --max-fee-per-gas-wei "$price" --reserve-wei "$reserve"
# Refuse unknown broadcasts before requesting any wallet password. check() only
# permits an unsigned prepared reservation after matching the entire current
# ETH/USDG plan journal and frozen CREATE intent; foreign prepared intents block.
# The engine independently repeats reconciliation under the shared account lock.
node --input-type=module - <<'JS'
import {checkRC3Deployment} from './scripts/operations/mainnet-rc3.mjs';
const checked=await checkRC3Deployment();
if(checked.readiness.blocked){console.error(JSON.stringify({error:'ACCOUNT_UNKNOWN_BROADCAST',automaticResend:false}));process.exit(1);}
JS
(cd "$snapshot" && npm ci --ignore-scripts --no-audit --no-fund)
node scripts/operations/mainnet-rc3.mjs --check \
  --budget-wei "$budget" --max-fee-per-gas-wei "$price" --reserve-wei "$reserve"
account="$(node -p 'JSON.parse(require("fs").readFileSync("config/mainnet-operations-rc3.json")).deployer.signingAccount')"
echo "Robinhood mainnet 4663; local account: $account"
echo 'RC.3 ETH/USDG core only; reuse both original library reservations and the same account ledger.'
echo "Cumulative gas budget (wei): $budget; gas price ceiling (wei): $price; retained reserve (wei): $reserve"
umask 077
password_file="$(mktemp "${TMPDIR:-/tmp}/lincoln-rc3-deployment-password.XXXXXX")"
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
