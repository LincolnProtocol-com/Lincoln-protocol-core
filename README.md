# Lincoln Protocol Core

Robinhood Chain **4663** contract and circuit release candidate, extracted for independent review and reproducible testing.

**Status: RC.2 candidate frozen and locally verified; not deployed to mainnet; independent audit deferred.** `v0.1.0-rc.1` is the previously pushed historical snapshot. RC.2 adds on-chain deposit caps and deposit-only pause, selects 30-bps launch fees and introduces the official relay fee-policy v2 component. The final circuit parameters are retained. Fresh native/fee acceptance against the changed bytecode passed **15 actual final proofs and 121 local transactions**, using explicit mock DEX liquidity; the exact source/artifact inventory and standalone reproduction checks have passed. See [mainnet status](docs/MAINNET_STATUS.md). Publishing this repository does not authorize real ETH spending.

RC.1 provenance: [`LincolnProtocol@99e0be62475ac95bb5f8030659c782d5275475a1`](https://github.com/LincolnProtocol-com/LincolnProtocol/commit/99e0be62475ac95bb5f8030659c782d5275475a1), packaged as core commit `4be4de1`. [The extraction inventory](audit/upstream-files.json) records the initial retained files and hashes. RC.2 deliberately changes a reviewed subset; the old inventory and RC.1 reports must not be used as proof of validation for changed RC.2 files. The scope is reconciled in [the RC.2 plan](docs/PLAN_RECONCILIATION_R2.md); the new inventory path is `artifacts/phase2-mainnet/release-candidate-20261016-r2.json`, and its frozen SHA256 is `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3`. Pending hosted-backend work and upstream Git history are excluded.

## Start a review

- [Audit scope and authoritative contract paths](docs/AUDIT_SCOPE.md)
- [Security model, trust assumptions and known limitations](docs/SECURITY_MODEL.md)
- [Mainnet status and remaining launch work](docs/MAINNET_STATUS.md)
- [Registered mainnet deployer and offline operations plan](docs/MAINNET_OPERATIONS.md)
- [Proving parameters, ceremony evidence and public sources](docs/PARAMETER_PROVENANCE.md)
- [License boundaries and third-party notices](THIRD_PARTY_NOTICES.md)
- [Candidate contract specification](contracts/MAINNET_RELEASE_CANDIDATE.md)
- [Backend / frontend R2 integration handoff](docs/BACKEND_R2_HANDOFF.md)
- [Official relay fee policy v2](docs/FEE_POLICY_V2.md) and [stock-cap selection policy](docs/STOCK_SELECTION_POLICY.md)
- RC.2 [native](audit/acceptance/standalone-20261016-r2/native.json), [fee](audit/acceptance/standalone-20261016-r2/fees.json) and [Foundry](audit/acceptance/standalone-20261016-r2/foundry.json) evidence
- [RC.2 validation summary](audit/standalone-validation-20261016-r2.json)
- Historical RC.1 [standalone validation summary](audit/standalone-validation-20261016.json) and [preserved original builds/reports](audit/baselines/v0.1.0-rc.1/); historical successes do not certify RC.2.

## Reproduce

Use Node.js **22 or newer** and npm. Foundry **1.8.4** (`forge` and `anvil` on `PATH`) is the tested local-chain toolchain. Solidity is pinned to **0.8.28**, via IR, Cancun, optimizer 10,000 runs. The circuit compiler is npm `circom2` **0.2.22**, containing Circom **2.2.2**; no separate Circom installation is required.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run check:circuits
npm test
npm run test:foundry
npm run test:acceptance
```

`npm run test:all` runs that validation sequence after installation. Building and testing require no production wallet, RPC credentials or funding. During the RC.2 revision, checks must bind refreshed RC.2 hashes rather than bypass a mismatch against RC.1. The contract suite has passed **68 Foundry tests**. RC.2 native acceptance passed **43 checks / 11 proofs / 48 local transactions**; fee acceptance passed **22 checks / four proofs / 73 local transactions**. These local results bind the new core/fee artifacts. The candidate binds 105 frozen file references. The Node suite passed 88 tests, followed by eight new evidence-validator tests; the public-only acceptance wrapper also completed a separate fresh run of both halves.

The included GitHub Actions workflow runs the same sequence on Node.js 22 with pinned action commits and Foundry 1.8.4. A successful local run is separate from the remote workflow status.

| Command | What it checks |
| --- | --- |
| `npm run check` | Release file inventory, original extraction provenance, dependencies referenced by the selected release and all ten core/fee ABIs |
| `npm run build` | Mathematical final-key/R1CS and beacon binding, generated verifiers, exact core bytecode and fee production component |
| `npm run check:circuits` | Recompile circuit sources to the exact frozen R1CS and WASM, with pinned compiler bytes and Circomlib source inventory |
| `npm test` | SDK, policy binding, deployment guards, Safe checks, fee math and proof-acceptance entry-point regressions |
| `npm run test:foundry` | Fuzz/invariant and adversarial contract behavior; verifiers are mocks, and some adapter tests exercise derivation baselines |
| `npm run test:acceptance` | Actual final Groth16 proofs against production candidate contracts on fresh local Anvil chains; explicit mock DEX liquidity |

The acceptance runner creates a disposable copy and fresh local chain, generates its own temporary test accounts, and removes them afterwards. It accepts no RPC URL or wallet arguments. New public reports go to ignored `audit/runs/`; the included historical reports remain unchanged. `npm run test:acceptance:native` and `npm run test:acceptance:fees` run each half independently. No public-chain transactions are sent.

The low-level acceptance entry points can overwrite their report when called directly, so use the `scripts/core/acceptance.mjs` wrapper above. Retain RC.1 reports as historical evidence and identify the exact changed build in each RC.2 run.

## Repository map

| Path | Purpose |
| --- | --- |
| `protocol/phase2-mainnet/contracts/` | Mainnet pool, ASP registry and fixed-route adapters |
| `protocol/phase2-mainnet/generated/` | Final production Groth16 verifiers |
| `protocol/phase2-fees/mainnet/` | Mainnet fee adapters, selected 30-bps launch rate and immutable per-adapter rate/treasury |
| `protocol/phase2-asp/circuits/` | Authoritative circuit sources, retained under their upstream paths |
| `protocol/phase2-mainnet/build/` | Final R1CS, WASM, zkeys, verification keys and manifests |
| `artifacts/phase2-ceremony/` | Public beacon evidence and the two pre-beacon parent keys |
| `artifacts/phase2-mainnet/`, `artifacts/phase2-fees-mainnet/` | Exact builds and historical acceptance evidence |
| `abi/phase2-mainnet/`, `abi/phase2-fees-mainnet/` | Ten ABI exports bound to those builds |
| `scripts/core/` | Standalone audit commands |
| `src/`, remaining `scripts/` | Required upstream build/SDK/test helper closure |
| `config/` | Public target, per-asset raw deposit caps and example routes; new mainnet deployer and monetary budgets remain unset |
| `vendor/solidity/` | Exact review copies of the frozen OpenZeppelin/Poseidon dependency sources and metadata; hashes and original compiler paths in `audit/dependency-sources.json` |
| `vendor/…/powersOfTau28_hez_final_15.ptau` | Public hash-pinned phase-1 parameter; not a private key |

Earlier development source files and two development manifests are retained **only** where the production derivation, anti-development-key checks or regression tests require them. Their chain guards and development keys are not the production deployment target. `abi/manifest.json` is the standalone ten-contract catalog generated by `scripts/core/sync-abi.mjs`; the original multi-version upstream catalog is preserved only under the RC.1 baseline. Use `npm run sync:abi` to regenerate and `npm run check:abi` to verify exact exported bytes.

The initial extraction adapted two tests that previously loaded development keys to final production materials because development keys are deliberately omitted; [the adaptation record](audit/test-adaptations.json) preserves that RC.1 packaging history. RC.2 additionally changes caps, planning, state validation and fee-policy tests, as recorded in `audit/source-changes-r2.json` and described in the reconciliation. A public testnet profile remains solely as a schema fixture for synthetic mainnet fee-planning tests; those tests do not contact its RPC.

Original deployment/signing helper files are present because the acceptance and planning code imports their linking and runtime verification functions. No deployment npm command is provided. Default planning is offline; funding or activating mainnet requires an explicit later operations release and budget.

兼供中文协作：rc.1 是已推送的历史快照；rc.2 增加链上存款上限和仅暂停存款、采用 30 bps 收费及 v2 报价策略，真实最终证明验收已通过，共 15 份证明、121 笔本地交易；候选清单、字节码／电路复现和公开副本端到端验收均已通过。ETH 初始上限为单笔 1 ETH／账面总额 20 ETH，USDG 为 2,500／50,000；股票必须先核定原始代币单位上限。新主网部署者尚未配置。仓库不包含前端、线上中继、索引服务、云端配置或钱包；核心发布不代表主网已上线，新增兼容 DEX 仍可单独扩展适配器。
