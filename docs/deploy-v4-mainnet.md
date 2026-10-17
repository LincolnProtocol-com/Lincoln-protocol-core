# Local LINCOLN / SPCX deployment runner

This separate runner creates exactly four contracts, in order:

1. LINCOLN privacy pool, using the frozen RC.3 pool artifact and existing libraries/verifiers/registry.
2. SPCX privacy pool with the same frozen bindings.
3. Fixed typed V4 adapter, LINCOLN → SPCX.
4. Fixed typed V4 adapter, SPCX → LINCOLN.

Both pools use `type(uint128).max` for maximum deposit and total liabilities.
The Safe retains emergency deposit pause and cap-lowering powers. The adapter's
30 bps output fee goes to the same Safe. Existing thirteen pool caps, twenty-four
V3 routes and all frozen files remain unchanged. This command does not activate
the new assets in backend, ASP, indexer, Access, Worker or frontend configuration.

## Public preparation and final approval

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-v4-mainnet.sh --plan
```

Plan mode reads only regular public repository files. It does not load signing
modules, use RPC, read a password/keystore, inspect the physical signer ledger,
reserve a nonce or create business state. Its public `approvalTemplate` is
`pending-human-approval`. A separately recorded human-approved scope and its
current exact command are documented in
[the dated deployment authorization](V4_APPROVED_DEPLOYMENT_20261017.md).

The plan pins the policy, public review, frozen artifacts/proof manifests,
compiler-produced V4 build/ABI/source set, runner/wrapper and public-review code and four exact
constructor intents. Any change invalidates the old plan and approval hashes.
The executable V4 adapter has a distinct ABI/domain; the older dedicated-callback
proposal is not used by this runner.

After explicit human approval of the final scope, an operator must supply a
regular public approval JSON matching `lincoln-mainnet-typed-v4-approval/v1`.
It must state `status: approved`, the exact plan/policy/review/build hashes,
the selected caps, four ordered steps, physical cumulative limits, scope budget,
price ceiling, and both accepted risks: `spcx-issuer-controls` and
`new-v4-adapter-untested-unaudited`. It must expire within 24 hours. CLI risk flags
alone do not grant approval. Public approval binds code; a source/runner change
cannot reuse an old authorization.

The scope prepared for final approval is **0.0022 ETH**, maximum **0.1 gwei**,
5,500,000 gas for each of four transactions, within the existing cumulative
0.065 ETH limit and 0.003 ETH reserve. These are fee ceilings, not a promised
charge. Unused gas limit is not charged; a legacy transaction pays its signed
gas price for gas actually used. Raising the signed unit price can raise costs.

## Actual gas observations

`deployments/robinhood-mainnet/verification/v4-deployment-gas-estimates-20261017.json`
records public `eth_estimateGas` results, creation calldata hashes, frozen/candidate
build hashes, block hash and a non-reserved public nonce observation. Both pool
constructors estimated **4,633,576 gas**; the earlier 4,000,000 proposal was
insufficient and was discarded before any signature. The corrected 5,500,000
pool limits leave headroom. Adapter estimation requires the two actual new pool
addresses and is performed by the physical signer's `prepare` before reserving
each transaction. An estimate above its approved gas cap fails without signing.
No fork, unit test, proof generation or live deployment was used for these checks.

An additional read-only state-override probe is preserved in
`verification/v4-constructor-gas-state-override-20261017.json`. It recreates the
future pool runtimes from a complete matching frozen on-chain runtime, changing
only the declared ASSET/SCOPE immutable words. Public and configured private RPC
attempts failed to return adapter gas estimates; the record does not claim a
deployment, receipt or successful gas-bound check. Actual adapter gas estimation
therefore remains mandatory after the two pools exist.

## Exact deployment command

Use values from the final reviewed plan and approved public file; placeholders
below deliberately contain no executable approval:

```sh
bash scripts/deploy-v4-mainnet.sh --deploy \
  --review deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json \
  --approval config/APPROVED_V4_SCOPE.json \
  --approval-sha256 APPROVED_FILE_SHA256 \
  --plan-id REVIEWED_PLAN_ID \
  --policy-sha256 REVIEWED_POLICY_SHA256 \
  --review-sha256 REVIEWED_REVIEW_SHA256 \
  --accept-issuer-controls spcx \
  --accept-untested-v4
```

All public bindings and approval expiry are checked before the wrapper requests
the local keystore password. It fixes account `lincoln-deployer`, address
`0x555998Ba2B2723C97d91FB20Da0ddb896749797e`. Password input remains local in a
mode-600 temporary file and is removed on exit. Never paste it into chat.

After approval validation, deployment uses the user's private mainnet RPC from
`~/.config/lincoln/mainnet-rpc-url`. The file must be canonical, owned by the
current user, mode 600, single-link, at most 4,096 bytes, and contain a single
HTTPS URL without username/password or fragment. The URL never enters the plan,
approval, logs, error output or public records. An optional absolute
`--rpc-file /absolute/private/file` selects another file; it never accepts a URL
argument. Only a missing default file permits fallback to the official public
endpoint. Invalid or explicitly selected missing files fail closed. Plan mode
does not open or validate the private file and performs no network request.

## Account-wide and per-scope safety

The runner obtains `checkRC3Deployment().sharedSignerDirectory` and refuses to
initialize a replacement physical account journal. Cumulative budget, price and
reserve settings must still exactly match the existing approved amendment.
Confirmed history remains in that journal. The new 0.0022 ETH scope is separately
counted by its four reservation IDs: confirmed receipts use actual fees; pending
entries reserve their signed ceilings. Both budgets and the reserve are checked
before creating further reservations. Gas price uses the existing guarded quote
rule, capped by the new 0.1 gwei ceiling.

A separate fixed-family journal binds this pair's first intent to its plan/build.
Changing the code, policy, plan ID or working directory cannot silently start a
fresh scope after a partial deployment. A different family binding requires
manual recovery and explicit review. Existing matching creation intents from
another plan also block deployment.

Before each new signature, the runner rechecks public approvals and file pins,
chain/genesis/head freshness, canonical review block, shared runtime anchors,
Safe singleton/owners/threshold, registry provider/guardian/window/suspension,
SPCX beacon/implementation/pause/blocklist, token identity and the complete live
V4 router/factory/strategy/curve/treasury/key/hook/vault/rates. The predicted
CREATE address must have no code. Router sender is used for rate reads; no
treasury tax exemption is assumed. Original shared CREATE inputs/receipts are
also verified before the first reservation.

Every confirmed deployment is verified against its exact CREATE input, receipt,
runtime template/immutables and public getters. Initial caps are verified from
the constructor event. Each deployed adapter's action hash/envelope is checked
against the unsigned helper. This is deployment verification, not acceptance
testing of private transfer/swap/recovery behavior.

## Unknown broadcasts and resume

An unknown, signed or external pending account entry stops the runner. It never
automatically resends or changes nonce, gas price, reservation ID or raw bytes.
For an unknown hash, use the repository's existing
`scripts/operations/recover-mainnet-broadcast.mjs` process to inspect and, only
when explicitly authorized, rebroadcast the identical signed transaction. Then
rerun the **same** approved deployment command. A crash leaving a service lock
requires operator inspection; do not delete locks or replace journals blindly.

An expired approval can be renewed for the same immutable plan/caps/review/code
and limits. The runner appends a chained authorization-history record; it does
not rewrite the initial approval, deployment journal or signed transactions.
Public outputs always reference the first authorization, so interrupted public
publication remains reproducible after renewal.

Only after all four contracts are verified does it write:

- `deployments/robinhood-mainnet/lincoln-spcx-pools-20261017.json`, the existing
  extension schema, containing only the two new profiles and empty route lists.
- `deployments/robinhood-mainnet/lincoln-spcx-v4-adapters-30bps.json`, a distinct
  `phase2-mainnet-v4-fee-adapters-deployed/v1` record with both disabled V4 routes.
- The two new public profiles in the existing operations snapshot.

Foreign or incomplete public-output conflicts are checked before spending.
No existing V3 fee manifest is merged or overwritten. Backend activation and
funded end-to-end acceptance remain separate, explicitly scoped operations.
