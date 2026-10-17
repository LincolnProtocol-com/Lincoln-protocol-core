# Four-pool deployment runner

This separate runner deploys four capped pools (AAPL, USDe, PONS, CASHCAT), followed by six Uniswap V3 fee adapters. It reuses the deployed RC.3 libraries, verifiers, registry, ETH/USDG pools, unchanged contract artifacts and final proof parameters. There is no USDe exchange or V4 deployment in this scope. The ten transactions are sequential and resumable; they are not an atomic transaction. Backend, indexer, ASP roster, Cloudflare Access and frontend activation remain separate.

The user approved the four capacities, AAPL issuer risk and four-pool/six-adapter scope on 2026-10-17. The separate `config/approved-four-pools-20261017.json` records the exact intent and a 24-hour deadline. No new mainnet deployment is claimed by that approval.

## Approved local command

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-approved-four-pools-20261017.sh
```

The command fixes all approved hashes and prompts for the existing keystore password locally. It does not run test suites or regenerate proof parameters. Required artifact, network, address, nonce, budget and receipt checks remain. Never send the password in chat. Approval expires at `2026-10-18T10:06:10Z`; a later run requires a fresh same-scope authorization record.

## Offline plan

```sh
bash scripts/deploy-new-pools-mainnet.sh --plan
```

This reads only public files and never imports signing modules, contacts RPC, opens a signer journal or accesses a password. Add `--review deployments/robinhood-mainnet/verification/four-pool-review.json` once the public source, fork-transfer and route evidence has been completed. The resulting `planId` binds the exact policy, review, four pool initcodes and six adapter intents. Changing the review changes the intent and must happen before the first deployment.

## Evidence needed before approval

The review schema is documented by `new-pools-mainnet-plan.mjs`. In addition, live validation requires:

- AAPL `liveBindings`: beacon, implementation, registry, registryRuntimeCodeHash and implementationRuntimeCodeHash.
- USDe `liveBindings`: owner, pendingOwner, endpoint and rateLimiter.
- PONS/CASHCAT `liveBindings.restrictionEndBlock` as decimal strings.
- Root `safeBindings`: singleton and singletonRuntimeCodeHash. The existing Safe owner-set hash, 2-of-3 threshold, version and proxy code are also checked.

AAPL has issuer blacklist, pause, administrative burn and upgrade powers. These remain true even while transfers work; approval must explicitly acknowledge them. `--accept-issuer-controls aapl` only supplies a required parser acknowledgment. It cannot replace the human approving the scoped approval file, and cannot override missing source/fork/market evidence.

## Scoped approval

After the user explicitly approves the concrete plan, create a separate public JSON with exactly these keys:

```json
{
  "schema": "lincoln-mainnet-four-pool-approval/v1",
  "status": "approved",
  "chainId": 4663,
  "genesisHash": "<plan.identity.genesisHash>",
  "deployer": "0x555998Ba2B2723C97d91FB20Da0ddb896749797e",
  "account": "lincoln-deployer",
  "planId": "<plan.planId>",
  "policySHA256": "<plan.identity.policy.sha256>",
  "reviewSHA256": "<plan.identity.review.sha256>",
  "approvedAt": "<actual approval ISO timestamp>",
  "expiresAt": "<no later than 24 hours after approval>",
  "caps": [
    {"id":"aapl","maxDepositUnits":"7200000000000000000","maxTotalUnits":"100000000000000000000"},
    {"id":"usde","maxDepositUnits":"2500000000000000000000","maxTotalUnits":"50000000000000000000000"},
    {"id":"pons","maxDepositUnits":"7900000000000000000000","maxTotalUnits":"110000000000000000000000"},
    {"id":"cashcat","maxDepositUnits":"22000000000000000000000","maxTotalUnits":"300000000000000000000000"}
  ],
  "acceptedIssuerControls": ["aapl"],
  "limits": {"budgetWei":"65000000000000000","maxFeePerGasWei":"2800000000","reserveWei":"3000000000000000"},
  "newTransactionPriceCapWei": "100000000",
  "maximumNewGasWei": "4800000000000000",
  "scope": "four-pools-and-six-uniswap-v3-fee-adapters-only"
}
```

The example contains placeholders, is not an approved artifact and is not executable. Approval expires within 24 hours. On renewal the identical plan/policy/review/caps/limits must be re-approved and all live checks pass again. The runner appends a digest-linked authorization record to the same deployment journal, retains the initial approval hash and never resets the physical account ledger. A newer source review would be a different plan and requires separate recovery/planning for any already deployed contracts.

Published manifests always cite the immutable initial approval path/hash; later deadline renewals remain in the append-only deployment journal. This keeps publication byte-for-byte reproducible if the process stopped between writing two public output files and approval needed renewal before finishing publication. Keep the original approval artifact instead of overwriting it when creating a renewal.

## Explicit local execution, after approval and review

```sh
bash scripts/deploy-new-pools-mainnet.sh --deploy \
  --review deployments/robinhood-mainnet/verification/four-pool-review.json \
  --approval config/approved-four-pools.json \
  --plan-id <exact-plan-id> \
  --policy-sha256 <exact-policy-file-sha256> \
  --review-sha256 <exact-review-file-sha256> \
  --approval-sha256 <exact-approval-file-sha256> \
  --accept-issuer-controls aapl
```

The wrapper validates public approval before prompting in the user's local terminal. Only `cast mktx` decrypts the local `lincoln-deployer` keystore. No key export, account creation or cloud signer is used. The actual physical RC.2/RC.3 shared signer ledger must already exist with the unchanged cumulative **0.065 ETH** limit and **0.003 ETH** reserve. New extension transactions have a stricter **0.1 gwei** price cap; prices use `min(cap, max(2 × baseFee, baseFee + 0.02 gwei, nodeQuote))`. Up to 48M total gas at that cap is **0.0048 ETH**. This is additional scope inside the existing cumulative budget, not a budget reset or a claim of actual fees.

Before each signature, the runner rechecks approval/policy/review hashes, chain/genesis, fresh canonical head/review block, component hashes, Safe singleton/owners/threshold, current ASP provider, USDG-equivalent USDe caps, token/proxy/issuer/pause/blocklist controls and each V3 factory/token/fee binding. A changed dependency or active launch restriction stops deployment. Gas is estimated by the existing signer and the physical account nonce/balance/budget is enforced there.

Known signed/submitted/unknown transactions are never re-signed or automatically rebroadcast. Use the existing `scripts/operations/recover-mainnet-broadcast.mjs --hash <original-hash>` read-only recovery first; an identical-raw rebroadcast remains an explicit operator action. Resume this exact plan only after the original transaction is confirmed. The runner preserves every historical account entry, deployment step, fee and authorization record.

Conflicting pre-existing public outputs/profile files fail before new spending. Outputs can be revalidated after a crash only when all ten transactions are already verified and confirmed. CREATE addresses are derived from the actual account's persisted nonce, and all receipts, runtime code, linked libraries, constructor caps and adapter immutable getters are verified before publication.

## Public outputs

- `deployments/robinhood-mainnet/four-pools-20261017.json`: existing stock-extension schema, exactly four new profiles, preserved core addresses, four new `pool:<id>` addresses; no enabled exchange routes.
- `deployments/robinhood-mainnet/four-pools-fee-adapters-30bps.json`: six new adapter records and per-source route/target-profile entries. Backend/frontend synchronizers must explicitly ingest this extension alongside the original 18-adapter record.
- Four deployment-snapshot public profiles, published only after all ten contracts have verified.

All records keep `productionReady:false` and service exchange execution disabled until backend rollout and independent A/B acceptance finish. No existing contract is redeployed or modified.
