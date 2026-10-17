#!/usr/bin/env bash
# Only the user terminal enters a local keystore password. All approval checks run first.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$task_root"
[[ $# -ge 1 && ( "$1" == '--plan' || "$1" == '--deploy' ) ]] || { echo 'Use --plan, or --deploy with exact public review and approval bindings.' >&2; exit 1; }
if [[ "$1" == '--plan' ]]; then
  node scripts/operations/deploy-new-pools-mainnet.mjs "$@"
  exit 0
fi
shift
for task_arg in "$@"; do
  [[ "$task_arg" != '--account' && "$task_arg" != '--password-file' ]] || { echo 'The wrapper fixes the local account and manages its password file.' >&2; exit 1; }
done
# Parse all binding flags before even invoking the offline plan or inspecting TTYs.
# A pending plan is useful, but it must never cause a premature password prompt.
node --input-type=module - "$@" <<'JS'
import {parseNewPoolDeploymentArguments,validateDeploymentBindingFlags} from './scripts/operations/deploy-new-pools-mainnet.mjs';
try { validateDeploymentBindingFlags(parseNewPoolDeploymentArguments(['--deploy',...process.argv.slice(2)]).options); }
catch (error) { console.error(JSON.stringify({error:error.code??'EXTENSION_DEPLOY_PREFLIGHT_FAILED',automaticResend:false})); process.exitCode=1; }
JS
node scripts/operations/deploy-new-pools-mainnet.mjs --plan "$@" >/dev/null
[[ -t 0 && -t 2 ]] || { echo 'Run in your own interactive terminal to enter the keystore password.' >&2; exit 1; }
echo 'Robinhood mainnet 4663; lincoln-deployer 0x555998Ba2B2723C97d91FB20Da0ddb896749797e.' >&2
echo 'Only four pools and six V3 fee adapters; 30 bps treasury is the existing Safe.' >&2
echo 'Preserve cumulative 0.065 ETH ledger and 0.003 ETH reserve; new transactions capped at 0.1 gwei.' >&2
echo 'No frontend/backend activation. Unknown broadcasts require the existing hash recovery procedure.' >&2
umask 077
task_password_file="$(mktemp "${TMPDIR:-/tmp}/lincoln-new-pools-password.XXXXXX")"
task_password_file="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$task_password_file")"
cleanup() { unset task_wallet_password; rm -f -- "$task_password_file"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r -s -p 'Keystore password (local only): ' task_wallet_password
printf '\n' >&2
printf '%s' "$task_wallet_password" > "$task_password_file"
unset task_wallet_password
node scripts/operations/deploy-new-pools-mainnet.mjs --deploy "$@" --account lincoln-deployer --password-file "$task_password_file"
