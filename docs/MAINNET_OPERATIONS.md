# Local mainnet deployment

**Mainnet deployment is paused.** The existing PoseidonT3 transaction is confirmed, but the later RC.2 PoseidonT4 broadcast has not yet been reconciled. Do not resume the old `scripts/deploy.sh --deploy`: that snapshot would deploy pools with the superseded 24-hour cap-increase delay. Unknown does not mean failed, and a new directory must not bypass an outstanding nonce or gas reservation.

The current candidate is **`v0.1.0-rc.3`**. It changes `CAP_INCREASE_DELAY` to **12 hours**, leaving immediate reductions and exit availability unchanged. The original tag and `releases/rc2/` remain untouched. The final circuits, proving keys and verifier identities are retained; the pool bytecode is newly compiled and needs its own acceptance evidence.

The encrypted account stays in Foundry on the operator's computer. `config/mainnet-operations-rc3.json` contains public deployment metadata, never a password or private key. The release configuration retains an unset deployer and null spending budgets. The account is validated against the recovered transaction sender when the operator signs locally.

## Check and prepare RC.3

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run plan
bash scripts/deploy-mainnet.sh --prepare
```

The new entry point prepares a separately identified RC.3 operations snapshot. It must validate the new candidate and source bindings, preserve the RC.2 journal, verify any reused component, and use the **original shared account-wide signer ledger**. It must not reset spent gas, release unknown reservations, reset nonces or create a separate budget allowance. Preparation sends no transaction and reads no wallet password. Existing snapshots and journals must never be deleted or overwritten to work around a failure.

A successful preparation is not permission to broadcast while the PoseidonT4 result remains unresolved. The final RC.3 run must fail closed until that old transaction is canonically reconciled. PoseidonT3 is reusable only after its receipt and exact expected runtime are verified; an eventual confirmed PoseidonT4 must be handled the same way. Never recompile a linked pool using an unverified library address.

Preparation checks the local ledger and sends no RPC request. If a transaction has since confirmed on chain, first run the read-only recovery command below to reconcile the saved status. The deployment engine independently checks canonical receipts and runtimes before reuse. A current RC.3 reservation left `prepared` by a password error or interruption can resume only if it has no signed hash/bytes and its entire frozen plan and journal match. Foreign reservations and signed or ambiguous broadcasts remain blocked; never delete them to continue.

## Execute RC.3 locally after reconciliation

The base deployment comprises two Poseidon libraries, two final verifiers, one association registry and **ETH/USDG pools only**. Verified libraries from RC.2 may be reused, reducing new CREATE transactions. It deploys no stock pools or DEX routes and starts no frontend, relayer or ASP publisher.

The user approved [seven stock-token caps](STOCK_CAPS.md), and `releases/rc3/config/phase2-mainnet.json` binds the same dataset by path and SHA-256. Values are configured; per-asset mainnet fork and two-way DEX checks remain pending. `stockPoolsEnabled` stays false and `stocksRouteActivationPending` stays true. Approved caps must not silently expand the default deployment.

The new explicit command is `bash scripts/deploy-mainnet.sh --deploy`, with all spending limits supplied by the local operator. For example, after the pause is lifted and reconciliation/preparation pass:

```sh
bash scripts/deploy-mainnet.sh --deploy \
  --budget-wei 1100000000000000 \
  --max-fee-per-gas-wei 40000000 \
  --reserve-wei 3000000000000000
```

This example is a **cumulative** gas budget of 0.0011 ETH, gas-price ceiling of 0.04 gwei and reserve of 0.003 ETH; previous confirmed costs and unresolved reservations remain counted. It is not a new allowance, current-price assertion or agent spending authorization. The prepared snapshot must be checked with the current receipt and ledger state before the operator chooses final limits. Incorrect chain/dependencies, changed source or recovered sender, insufficient budget/balance and unknown prior broadcasts must fail closed.

The command prompts for the keystore password only in the operator's interactive terminal. An owner-only temporary password file is removed on normal exit or handled signals; a crash or `SIGKILL` can leave it for local cleanup. No password belongs in chat, command arguments or Git. Existing testnet EC2 services are not changed by local core deployment.

## Legacy RC.2 unknown-broadcast reconciliation

`MAINNET_BROADCAST_UNKNOWN` means that the transaction was signed and its hash was saved, but the broadcaster did not receive an acceptable response. It does not prove success or failure. RC.2 discarded the underlying RPC reason, so a later not-found response cannot distinguish an original timeout from a rejection. RC.3 preserves a bounded, sanitized `rpcDiagnostic` in the ledger and CLI error while retaining the unknown reservation. Keep the original snapshot, signer ledger and deployment journal; do not switch directories, reset nonces, remove locks or delete records.

Inspect the saved transaction without sending it:

```sh
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash>
```

This command verifies the frozen inputs, original signature, chain, intent, limits and canonical receipts. Receipt reconciliation may update local accounting. If already confirmed, retain the reconciled journal and ledger. Do not resume the old RC.2 deployment: its pools have the superseded 24-hour delay. RC.3 must import confirmed components only after validating their receipts, runtime and identity.

The legacy recovery tool also has an explicit `--rebroadcast` mode for the **identical signed bytes once**. This is a mainnet write, not inspection. Do not run it automatically or during the current deployment pause; reconcile the pending transaction and decide the recovery action first:

```sh
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash> --rebroadcast
```

Recovery requires the saved sender nonce, original reserve and original budget to remain valid. It acquires the original deployment and signer locks, signs nothing, cannot change gas price or nonce, and disables HTTP retries. A known pending transaction is not rebroadcast. Any ambiguous response keeps the original hash in `unknown` and reports a sanitized RPC reason; it never creates a replacement transaction. If a gas-price or network constraint rejects those signed bytes, review the evidence before choosing a separate recovery action.

## Remaining launch work

A core deployment is not a completed launch. Fees and typed DEX route deployment/activation, each stock's fork and real two-way DEX acceptance, mainnet signer/ASP/relayer operations, funding and independent A/B acceptance remain separate steps. Independent audit remains deferred under the user's decision; it is not claimed complete. This release work does not itself resume mainnet broadcasts.
