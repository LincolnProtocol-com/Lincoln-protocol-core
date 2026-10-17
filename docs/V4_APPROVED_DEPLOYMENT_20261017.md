# Approved LINCOLN / SPCX deployment scope

The human user explicitly approved the previously prepared four-contract scope
on 2026-10-17. This supersedes the earlier deployment deferral; it does not
authorize replacing the current thirteen pools, changing their caps, repricing
unknown transactions or silently enabling a new backend route.

The public approval is `config/v4-mainnet-deployment-approval-20261017.json`.
Its SHA-256 is `fafd8a8527baacab4e680c8fc5a0bf1c819309a451cbe39cde44351b4b3efb5a`.
The approval binds plan
`f2625560ed140ccb953f93947dfa42393b059ed2b7189267c8628d6da0c73f3a`,
the existing reviewed source/build/ABI, and these ordered CREATEs:

1. LINCOLN RC.3 privacy pool.
2. SPCX RC.3 privacy pool.
3. LINCOLN → SPCX fixed typed HedgeFun V4 adapter.
4. SPCX → LINCOLN fixed typed HedgeFun V4 adapter.

Both cap fields are `340282366920938463463374607431768211455` raw units,
the frozen contract's uint128 maximum. The Safe remains
`0x9CF17a6E3c75D200f58283A165C442a8A3994555`, adapter output fee 30 bps.
The accepted risks are SPCX issuer freeze/burn/upgrade controls and the new
adapter remaining untested and unaudited. No tests/proofs were rerun to record
this authorization.

Maximum additional scope gas is 0.0022 ETH, new transaction gas-price cap
0.1 gwei, within the existing cumulative 0.065 ETH ledger and 0.003 ETH reserve.
The physical ledger retains its existing 2.8 gwei global cap; the lower V4 scope
cap applies to these new signatures. The approval expires at the UTC timestamp
inside the file; the operator must not use an expired approval.

The hashed policy and older plan/review intentionally retain their original
candidate status wording. The separate approval records human authorization
without changing the approved intent or rewriting historical observations.
Authorization does not establish successful deployment or end-to-end readiness.

## Exact local command

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-v4-mainnet.sh --deploy \
  --review deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json \
  --approval config/v4-mainnet-deployment-approval-20261017.json \
  --approval-sha256 fafd8a8527baacab4e680c8fc5a0bf1c819309a451cbe39cde44351b4b3efb5a \
  --plan-id f2625560ed140ccb953f93947dfa42393b059ed2b7189267c8628d6da0c73f3a \
  --policy-sha256 b09a8692a6a0ddde7b262e846bba968a048c1672f2373d3d6e0d2b1db345f271 \
  --review-sha256 d126b5b47b5ba591b5f3f376e40416ac4949011679f54b77d3c19734e511fb30 \
  --accept-issuer-controls spcx \
  --accept-untested-v4
```

This uses the local Foundry account `lincoln-deployer`, expected public address
`0x555998Ba2B2723C97d91FB20Da0ddb896749797e`, and its existing physical signer
journal in this checkout. The wrapper asks for the keystore password only in
the operator's own interactive terminal. Do not send the password to chat.

The runner independently checks the current chain and venue, actual funding,
remaining cumulative/scope budgets and each constructor's gas estimate before
signing. Adapter estimates require the two new pool addresses. A failed estimate
can stop after the pools are deployed; do not raise limits or change the plan to
work around that. Unknown broadcasts stop and require explicit recovery of the
same signed bytes. No automatic resend occurs.

After all four are verified it writes the two LINCOLN/SPCX deployment manifests.
Backend V4 dispatch, fifteen-pool indexing/ASP/Access and both-direction funded
execution/recovery remain distinct integration work. See the backend research
record for those requirements.
