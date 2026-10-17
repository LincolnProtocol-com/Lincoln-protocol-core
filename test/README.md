# Tests and recorded evidence

| Directory | Review scope |
| --- | --- |
| [contracts/](contracts/) | Foundry contract, fuzz and invariant sources |
| [evidence/rc3/](evidence/rc3/) | Current native, fee, default Foundry and deep Foundry results |
| [evidence/rc2/](evidence/rc2/) | Recorded native-pool, fee-adapter and Foundry results |
| [evidence/layout/](evidence/layout/validation.json) | Fresh public-layout validation, logs and new proof-run IDs |

The review sources and reports are regular files mapped by [review-manifest.json](../review-manifest.json) to the current RC.3 capsule, with older evidence retained separately. `npm run check` verifies exact identity. Test sources retain their original imports and compiler identity; use the root wrappers rather than assuming that the readable directory is a standalone Foundry project.

```sh
npm run check
npm run test:contracts
npm run test:contracts:deep
npm run test:proofs
```

The wrappers validate the root review files before running preserved tooling with the original logical paths. They do not require a production wallet, public RPC or funding. Actual-proof acceptance starts fresh local Anvil instances, generates temporary test accounts and sends no public-chain transactions. DEX routers, tokens, factories and liquidity in proof acceptance are explicit fixtures.

## Current RC.3 results

| Evidence | Result | Scope |
| --- | --- | --- |
| [validation.json](../audit/acceptance/rc3/validation.json) | 178 Node tests passed | 108 capsule tests plus the final 70 root operations/review tests; exact logs and hashes |
| [foundry.json](evidence/rc3/foundry.json) | 69 passed, zero failed | Complete default contract suite; mocks verify accounting and authorization |
| [foundry-deep.json](evidence/rc3/foundry-deep.json) | 19 passed; 20,000 fuzz runs per case; 40,960 invariant calls, zero reverts | CapsTest and PoolInvariantTest only |
| [native.json](evidence/rc3/native.json) | 48 checks, 11 final proofs, 51 local transactions | Fresh RC.3 pool, recovery/respend/exits, exact twelve-hour boundary and replacement restart |
| [fees.json](evidence/rc3/fees.json) | 22 checks, four final proofs, 73 local transactions | Both fee adapters, multihop wrap/unwrap and net recovery using synthetic DEX liquidity |

This is **15 newly generated final proofs and 124 local transactions**, not public-mainnet execution. Parameter bytes and all ten ABIs match RC.2; only the pool bytecode changes. Mainnet stock liquidity and per-stock fork acceptance remain pending.

## Recorded RC.2 results

| Evidence | Result | Scope |
| --- | --- | --- |
| [evidence/rc2/foundry.json](evidence/rc2/foundry.json) | **68 passing test results**; 1,000 runs per fuzz case; invariant campaign 128 × 40 = 5,120 calls, zero reverts | Mock-verifier contract accounting, authorization, policy, cap/pause and adversarial-router checks |
| [evidence/rc2/native.json](evidence/rc2/native.json) | **43 checks, 11 actual final proofs, 48 local transactions** | Production pool/verifiers; A/B recovery, respend, withdrawal and public exits, including spending while deposits are paused and caps are below reserve |
| [evidence/rc2/fees.json](evidence/rc2/fees.json) | **22 checks, four actual final proofs, 73 local transactions** | Production pool/verifiers/fee adapters; both router ABIs, two-hop wrap/unwrap, 30-bps net recovery and withdrawal with mock DEX liquidity |

Together the actual-proof reports record **15 proofs and 121 local transactions**. They do not establish public-mainnet execution, live market liquidity, independent audit or a measured anonymity set. Foundry verifier mocks accept proofs; a passing contract test does not establish Groth16 soundness. Some adapter fuzz cases exercise retained derivation baselines; the actual-proof fee acceptance separately exercises the production fee artifact.

The invariant runner reports its properties together as one test result; do not add them again to the 68-test count. Foundry scenario gas includes setup and multiple calls and must not be represented as a single relay transaction estimate.

The fee fixture measures gross output 10,000 raw units, charges 30 and recovers B's 9,970-unit note. B then withdraws gross 9,970 once with fee 32: percentage fee 29 plus three **synthetic fixed-gas fixture units**, leaving 9,938. The three-unit quote is not a mainnet ETH gas-price or fee configuration.

Recorded reports describe their exact build and run, not a fresh execution of a later layout commit. The historical RC.2 tag and inventory remain unchanged; newly generated validation output must identify its own run and must not overwrite historical evidence. See [releases](../releases/README.md) for the reproduction boundary.

## RC.3 validation scope

RC.3 evidence above covers fresh default and deep-profile Foundry runs for the 12-hour delay and actual-proof acceptance against the revised pool. Boundary cases include `eta - 1`, exact `eta`, replacement proposals and cancellation; cap tests read the getter. Registry/invariant epoch validity durations are unrelated and remain unchanged.

[Stock-cap tests](operations/stock-caps-mainnet.test.mjs) independently verify all seven approved integer caps and floor boundaries. The RC.3 target binds the same dataset by SHA-256, retains ETH/USDG as default deployment, and keeps a synthetic unresolved-stock negative case. These checks do not establish live stock liquidity or fork acceptance. Mainnet deployment remains paused while the old unknown library broadcast is reconciled.
