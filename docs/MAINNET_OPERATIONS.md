# Local mainnet deployment

**Mainnet core deployment is incomplete.** Both original Poseidon library transactions are now confirmed in the shared signer ledger, including the explicitly recovered RC.2 PoseidonT4 transaction. The first RC.3 JoinSplit verifier is also confirmed. The exit verifier, registry and ETH/USDG pools remain to be deployed. Do not resume the old `scripts/deploy.sh --deploy`: that snapshot would deploy pools with the superseded 24-hour cap-increase delay. A new directory must never bypass an outstanding nonce or gas reservation.

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

A successful preparation does not bypass unresolved transactions. Any unknown prior broadcast must be canonically reconciled before new signing. Both confirmed Poseidon libraries are reusable only after their receipts and exact expected runtimes are freshly verified by the deployment engine. Never recompile a linked pool using an unverified library address.

Preparation checks the local ledger and sends no RPC request. If a transaction has since confirmed on chain, first run the read-only recovery command below to reconcile the saved status. The deployment engine independently checks canonical receipts and runtimes before reuse. A current RC.3 reservation left `prepared` by a password error or interruption can resume only if it has no signed hash/bytes and its entire frozen plan and journal match. Foreign reservations and signed or ambiguous broadcasts remain blocked; never delete them to continue.

## Execute RC.3 locally after reconciliation

The base deployment comprises two Poseidon libraries, two final verifiers, one association registry and **ETH/USDG pools only**. Verified libraries from RC.2 may be reused, reducing new CREATE transactions. It deploys no stock pools or DEX routes and starts no frontend, relayer or ASP publisher.

The user approved [seven stock-token caps](STOCK_CAPS.md), and `releases/rc3/config/phase2-mainnet.json` binds the same dataset by path and SHA-256. Values are configured; per-asset mainnet fork and two-way DEX checks remain pending. `stockPoolsEnabled` stays false and `stocksRouteActivationPending` stays true. Approved caps must not silently expand the default deployment.

Apply the approved local limit amendment once before using the new limits (it signs and broadcasts nothing):

```sh
node scripts/operations/mainnet-limits.mjs --status
node scripts/operations/mainnet-limits.mjs --apply
```

The original RC.2 journal, prepared public snapshot and all prior transaction entries remain intact. A private write-ahead amendment record retains the original limits and store digests; interruptions fail closed until explicit recovery with the same command. Applying the same completed amendment again is idempotent.

The new explicit command is `bash scripts/deploy-mainnet.sh --deploy`, with all spending limits supplied by the local operator. For example, when the local operator resumes after reconciliation/preparation pass:

```sh
bash scripts/deploy-mainnet.sh --deploy \
  --budget-wei 65000000000000000 \
  --max-fee-per-gas-wei 4000000000 \
  --reserve-wei 3000000000000000
```

This example uses the separately approved **cumulative** gas budget of 0.065 ETH, gas-price ceiling of 4 gwei and reserve of 0.003 ETH; previous confirmed costs and unresolved reservations remain counted. The amended limits do not reset the budget ledger or assert a current market price. The prepared snapshot must be checked with the current receipt and ledger state before the operator chooses final limits. Incorrect chain/dependencies, changed source or recovered sender, insufficient budget/balance and unknown prior broadcasts must fail closed.

The current root runner loads the verified tagged snapshot and retains the same frozen deployment engine and shared signer ledger. For a **new reservation**, the separately approved gas policy multiplies the fresh RPC gas-price quote by **100**, capped at **4 gwei**. The approved cumulative deployment budget is **0.065 ETH**, including all historical costs, and the retained reserve remains **0.003 ETH**. The policy and explicit CLI limits must match an applied, auditable limit amendment in the original shared ledger. If the quote itself exceeds that cap, it refuses to sign. The cumulative budget and retained reserve are checked as before. Previously prepared or signed reservations are not repriced, and unknown transactions remain blocked.

The HTTP transport sends a signed transaction once with retries disabled. Its error boundary extracts and sanitizes the node's literal reason before the frozen signer records it. In viem, `-32000` alone maps to the generic text `Missing or invalid parameters`; that text does not establish a malformed local command or the actual rejection reason. No transaction is automatically replaced or resent.

The command prompts for the keystore password only in the operator's interactive terminal. An owner-only temporary password file is removed on normal exit or handled signals; a crash or `SIGKILL` can leave it for local cleanup. No password belongs in chat, command arguments or Git. Existing testnet EC2 services are not changed by local core deployment.

## Legacy RC.2 unknown-broadcast reconciliation

`MAINNET_BROADCAST_UNKNOWN` means that the transaction was signed and its hash was saved, but the broadcaster did not receive an acceptable response. It does not prove success or failure. RC.2 discarded the underlying RPC reason, so a later not-found response cannot distinguish an original timeout from a rejection. RC.3 preserves a bounded, sanitized `rpcDiagnostic` in the ledger and CLI error while retaining the unknown reservation. Keep the original snapshot, signer ledger and deployment journal; do not switch directories, reset nonces, remove locks or delete records.

Inspect the saved transaction without sending it:

```sh
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash>
```

This command verifies the frozen inputs, original signature, chain, intent, limits and canonical receipts. Receipt reconciliation may update local accounting. If already confirmed, retain the reconciled journal and ledger. Do not resume the old RC.2 deployment: its pools have the superseded 24-hour delay. RC.3 must import confirmed components only after validating their receipts, runtime and identity.

The legacy recovery tool also has an explicit `--rebroadcast` mode for the **identical signed bytes once**. This is a mainnet write, not inspection. Do not run it automatically or while deployment is paused; query the pending transaction and decide the recovery action first:

```sh
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash> --rebroadcast
```

Recovery requires the saved sender nonce, original reserve and original budget to remain valid. It acquires the original deployment and signer locks, signs nothing, cannot change gas price or nonce, and disables HTTP retries. A known pending transaction is not rebroadcast. A returned `submitted` status is not confirmation: run the same command again without `--rebroadcast` until the canonical receipt is recorded as `confirmed`, then check RC.3 readiness before deploying. Any ambiguous response keeps the original hash in `unknown` and reports a sanitized RPC reason; it never creates a replacement transaction. If a gas-price or network constraint rejects those signed bytes, review the evidence before choosing a separate recovery action.

## Remaining launch work

A core deployment is not a completed launch. Fees and typed DEX route deployment/activation, each stock's fork and real two-way DEX acceptance, mainnet signer/ASP/relayer operations, funding and independent A/B acceptance remain separate steps. Independent audit remains deferred under the user's decision; it is not claimed complete. Only an explicit local operator deployment resumes mainnet broadcasts.

## Clean-checkout dependencies

The root wrappers prepare regular ignored dependency copies for the current RC.3 capsule and, when required, the historical RC.2 recovery/verification tooling. They use the already installed root dependencies without network access, private files or changes to either frozen capsule. RC.3 requires an identical lock file. RC.2 permits only the precisely checked root package-version labels to differ; the complete remaining lock and dependency metadata must match. A fresh checkout must pass the same legacy checks as an existing workstation.

The [clean-checkout validation](../audit/acceptance/rc3-clean-checkout/validation.json) records the CI regression and fresh root-tooling tests. This follow-up changes only root tooling and documentation; an already prepared RC.3 snapshot continues to bind the same tagged capsule and shared signer ledger.
