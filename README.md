# Lincoln Protocol Core

Robinhood Chain **4663** contract and circuit release candidate, extracted for independent review and reproducible testing.

**Status: frozen candidate; not deployed to mainnet; independent audit pending.** Final proving parameters and local acceptance are complete. Real DEX liquidity, fee-route deployment/activation and mainnet operations still require acceptance. This repository does not authorize real ETH spending. See [mainnet status](docs/MAINNET_STATUS.md).

Source snapshot: [`LincolnProtocol@99e0be62475ac95bb5f8030659c782d5275475a1`](https://github.com/LincolnProtocol-com/LincolnProtocol/commit/99e0be62475ac95bb5f8030659c782d5275475a1). Extracted files retain their original paths and bytes. [The upstream inventory](audit/upstream-files.json) records each retained file and hash; pending backend work and upstream Git history are excluded.

## Start a review

- [Audit scope and authoritative contract paths](docs/AUDIT_SCOPE.md)
- [Security model, trust assumptions and known limitations](docs/SECURITY_MODEL.md)
- [Mainnet status and remaining launch work](docs/MAINNET_STATUS.md)
- [Proving parameters, ceremony evidence and public sources](docs/PARAMETER_PROVENANCE.md)
- [License boundaries and third-party notices](THIRD_PARTY_NOTICES.md)
- [Original frozen candidate specification](contracts/MAINNET_RELEASE_CANDIDATE.md)
- [Standalone validation summary](audit/standalone-validation-20261016.json), with [native](audit/acceptance/standalone-20261016/native.json) and [fee](audit/acceptance/standalone-20261016/fees.json) real-proof reports from this extracted repository

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

`npm run test:all` runs that validation sequence after installation. Building and testing require no production wallet, RPC credentials or funding.

The included GitHub Actions workflow runs the same sequence on Node.js 22 with pinned action commits and Foundry 1.8.4. A successful local run is separate from the remote workflow status.

| Command | What it checks |
| --- | --- |
| `npm run check` | Every extracted upstream file, the exact frozen release, dependencies referenced by that release and all ten core/fee ABIs |
| `npm run build` | Mathematical final-key/R1CS and beacon binding, generated verifiers, exact core bytecode and fee production component |
| `npm run check:circuits` | Recompile circuit sources to the exact frozen R1CS and WASM, with pinned compiler bytes and Circomlib source inventory |
| `npm test` | SDK, policy binding, deployment guards, Safe checks, fee math and proof-acceptance entry-point regressions |
| `npm run test:foundry` | Fuzz/invariant and adversarial contract behavior; verifiers are mocks, and some adapter tests exercise derivation baselines |
| `npm run test:acceptance` | Actual final Groth16 proofs against production candidate contracts on fresh local Anvil chains; explicit mock DEX liquidity |

The acceptance runner creates a disposable copy and fresh local chain, generates its own temporary test accounts, and removes them afterwards. It accepts no RPC URL or wallet arguments. New public reports go to ignored `audit/runs/`; the included historical reports remain unchanged. `npm run test:acceptance:native` and `npm run test:acceptance:fees` run each half independently. No public-chain transactions are sent.

The original low-level acceptance entry points are retained unchanged for provenance. They overwrite their historical report when called directly, so use the `scripts/core/acceptance.mjs` wrapper above.

## Repository map

| Path | Purpose |
| --- | --- |
| `protocol/phase2-mainnet/contracts/` | Mainnet pool, ASP registry and fixed-route adapters |
| `protocol/phase2-mainnet/generated/` | Final production Groth16 verifiers |
| `protocol/phase2-fees/mainnet/` | Mainnet fee adapters, fixed 20 bps launch selection and immutable treasury |
| `protocol/phase2-asp/circuits/` | Authoritative circuit sources, retained under their upstream paths |
| `protocol/phase2-mainnet/build/` | Final R1CS, WASM, zkeys, verification keys and manifests |
| `artifacts/phase2-ceremony/` | Public beacon evidence and the two pre-beacon parent keys |
| `artifacts/phase2-mainnet/`, `artifacts/phase2-fees-mainnet/` | Exact builds and historical acceptance evidence |
| `abi/phase2-mainnet/`, `abi/phase2-fees-mainnet/` | Ten ABI exports bound to those builds |
| `scripts/core/` | Standalone audit commands |
| `src/`, remaining `scripts/` | Required upstream build/SDK/test helper closure |
| `config/` | Frozen public target and example routes; mainnet monetary budgets remain unset |
| `vendor/solidity/` | Exact review copies of the frozen OpenZeppelin/Poseidon dependency sources and metadata; hashes and original compiler paths in `audit/dependency-sources.json` |
| `vendor/…/powersOfTau28_hez_final_15.ptau` | Public hash-pinned phase-1 parameter; not a private key |

Earlier development source files and two development manifests are retained **only** where the production derivation, anti-development-key checks or regression tests require them. Their chain guards and development keys are not the production deployment target. `abi/manifest.json` is the unchanged upstream catalog and also lists historical groups that are not shipped here; the standalone check intentionally verifies only `phase2-mainnet` and `phase2-fees-mainnet`.

Two test cases that previously loaded development keys are adapted to final production materials because development keys are deliberately omitted. [The adaptation record](audit/test-adaptations.json) identifies each original test and exact change; all other extracted upstream files remain byte-for-byte unchanged. A public testnet profile is retained solely as a schema fixture for synthetic mainnet fee-planning tests; those tests do not contact its RPC.

Original deployment/signing helper files are present because the acceptance and planning code imports their linking and runtime verification functions. No deployment npm command is provided. Default planning is offline; funding or activating mainnet requires an explicit later operations release and budget.

兼供中文协作：本仓库是审计用的主网核心候选快照，不包含前端、线上中继、索引服务、云端配置、钱包或未提交的后端修改。新增兼容 DEX 可单独扩展适配器；当前仓库发布不表示主网已上线。
