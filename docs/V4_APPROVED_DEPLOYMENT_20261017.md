# Approved LINCOLN / SPCX deployment scope

The human user explicitly approved the previously prepared four-contract scope
on 2026-10-17. This supersedes the earlier deployment deferral; it does not
authorize replacing the current thirteen pools, changing their caps, repricing
unknown transactions or silently enabling a new backend route.

The current public approval is `config/v4-mainnet-deployment-approval-20261017-r2.json`.
Its SHA-256 is `8855e21f60b0c047160720cb86ddecd286542ca4ba8b21e039ba3f33e0f3ed35`.
The approval binds plan
`e027124eb2c9bb9864a49768ade5e76b4c6df45c97c365992bb5a7fe21ae285a`,
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

The dated launcher supplies the exact bindings below. Use it instead of the
earlier command, whose plan does not include the repaired review gate:

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-v4-approved-20261017-r2.sh
```

Equivalent explicit command:

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-v4-mainnet.sh --deploy \
  --review deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json \
  --approval config/v4-mainnet-deployment-approval-20261017-r2.json \
  --approval-sha256 8855e21f60b0c047160720cb86ddecd286542ca4ba8b21e039ba3f33e0f3ed35 \
  --plan-id e027124eb2c9bb9864a49768ade5e76b4c6df45c97c365992bb5a7fe21ae285a \
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

## Review-layout repair

The first attempt stopped with `REVIEW_UNEXPECTED_FILE` before signer creation.
The independently compiled `contracts/adapters/HedgeFunV4Adapter.candidate.sol`
was outside the immutable RC.3 review inventory. Revision 2 accepts only this
exact additional path with SHA-256
`edc4de2de41e3daadb9d86b0d8d2fe026afcca1d624c3e6745fee3ca84cb8490`.
All other unexpected files and symlinks remain rejected, and the frozen RC.3
manifest and ten-contract catalog are unchanged. Extensions are reported
separately. This public integrity gate now runs before password entry as well
as before deployment.

Revision 2 also pins the actual review layout and runner modules in the V4
intent. Therefore its plan and approval hashes differ from the original; the
four onchain intents, bytecode, source pins, risk acceptance, budgets, approval
time and expiration are unchanged. The original approval/plan and live
preflight remain historical records. The
[repair evidence](../deployments/robinhood-mainnet/verification/v4-review-layout-repair-20261017.json)
records the exact relation and confirms that the old plan had no physical
ledger entries or family journal. No lock, nonce, signature or ledger history
was reset. Integrity checks passed; tests and proofs were not rerun.
