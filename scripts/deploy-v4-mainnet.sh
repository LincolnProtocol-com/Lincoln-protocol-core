#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Public approval checks finish before a local keystore password is requested.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$task_root"
[[ $# -ge 1 && ( "$1" == '--plan' || "$1" == '--deploy' ) ]] || { echo 'Use --plan or --deploy with exact approved public bindings.' >&2; exit 1; }
if [[ "$1" == '--plan' ]]; then
  node scripts/operations/deploy-v4-mainnet.mjs "$@"
  exit 0
fi
shift
for task_arg in "$@"; do
  [[ "$task_arg" != '--account' && "$task_arg" != '--password-file' ]] || { echo 'The wrapper fixes the local account and manages its password file.' >&2; exit 1; }
done
node --input-type=module - "$@" <<'JS'
import {parseV4Arguments,validateV4BindingFlags} from './scripts/operations/deploy-v4-mainnet.mjs';
try { validateV4BindingFlags(parseV4Arguments(['--deploy',...process.argv.slice(2)]).options); }
catch(error) { console.error(JSON.stringify({error:error.code??'V4_DEPLOY_PREFLIGHT_FAILED',automaticResend:false})); process.exitCode=1; }
JS
node scripts/operations/deploy-v4-mainnet.mjs --plan "$@" >/dev/null
[[ -t 0 && -t 2 ]] || { echo 'Run in your own interactive terminal to enter the local keystore password.' >&2; exit 1; }
echo 'Robinhood mainnet 4663; lincoln-deployer 0x555998Ba2B2723C97d91FB20Da0ddb896749797e.' >&2
echo 'Only LINCOLN/SPCX pools and two fixed typed V4 adapters; caps use uint128 maximum; Safe output fee 30 bps.' >&2
echo 'SPCX issuer powers and untested/unaudited new adapter require explicit approval.' >&2
echo 'New scope at most 0.0022 ETH / 0.1 gwei, within cumulative 0.065 ETH and 0.003 ETH reserve.' >&2
echo 'Unknown hashes stop; no automatic resend, signer reset, backend activation or V3 route changes.' >&2
umask 077
task_password_file="$(mktemp "${TMPDIR:-/tmp}/lincoln-v4-password.XXXXXX")"
task_password_file="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$task_password_file")"
cleanup() { unset task_wallet_password; rm -f -- "$task_password_file"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r -s -p 'Keystore password (local only): ' task_wallet_password
printf '\n' >&2
printf '%s' "$task_wallet_password" > "$task_password_file"
unset task_wallet_password
node scripts/operations/deploy-v4-mainnet.mjs --deploy "$@" --account lincoln-deployer --password-file "$task_password_file"
