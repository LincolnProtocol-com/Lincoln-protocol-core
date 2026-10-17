#!/usr/bin/env bash
# Seven stock pools only; the already deployed core and account ledger are retained.
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root_dir"
[[ $# -eq 1 && ( "$1" == '--deploy' || "$1" == '--plan' ) ]] || { echo 'Use --plan or --deploy.' >&2; exit 1; }
if [[ "$1" == '--plan' ]]; then
  node scripts/operations/deploy-stocks-mainnet.mjs --plan
  exit 0
fi
[[ -t 0 && -t 2 ]] || { echo 'Run in your own interactive terminal to enter the keystore password.' >&2; exit 1; }
echo 'Robinhood mainnet 4663; local account lincoln-deployer (0x555998Ba2B2723C97d91FB20Da0ddb896749797e).'
echo 'Deploy seven stock pools with total capacity 100 tokens each; preserve the seven existing core contracts.'
echo 'Same cumulative gas budget: 0.065 ETH; same global gas ceiling: 2.8 gwei; reserve: 0.003 ETH.'
echo 'New stock transactions use fresh quote x100, capped at 1 gwei; no DEX adapters are included.'
umask 077
password_file="$(mktemp "${TMPDIR:-/tmp}/lincoln-stock-deployment-password.XXXXXX")"
password_file="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$password_file")"
cleanup() { unset wallet_password; rm -f -- "$password_file"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r -s -p 'Keystore password (local only): ' wallet_password
printf '\n'
printf '%s' "$wallet_password" > "$password_file"
unset wallet_password
node scripts/operations/deploy-stocks-mainnet.mjs --deploy --account lincoln-deployer --password-file "$password_file"
