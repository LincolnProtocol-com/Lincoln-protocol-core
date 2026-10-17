# Mainnet status

> RC.3 forward revision: the pool cap-increase delay is now **12 hours (43,200 seconds)**. Lowering caps remains immediate, every replacement proposal starts its own full delay, and caps/pause never block spending or exits. Any RC.2 reports and run identifiers retained below are historical evidence, not proof that RC.3 has passed; fresh RC.3 evidence must be generated against its rebuilt artifacts. The immutable RC.2 source archive keeps the original 24-hour rule.

Status date: **2026-10-16, America/New_York**. RC.1 was extracted from upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1` and pushed as `v0.1.0-rc.1` (core packaging commit `4be4de1`).

**RC.2 is frozen as a locally verified contract candidate. Lincoln contracts have not been deployed to Robinhood mainnet.** RC.1 remains a historical snapshot; its artifacts and passed reports must not certify changed RC.2 bytecode. Publishing this audit repository does not authorize a mainnet transaction or funding transfer.

## RC.2 contract and SDK changes

- Each pool has positive raw-unit `maxDeposit` and `maxTotal` caps and an `accountedBalance`. Deposits add their measured value; `transact` subtracts `publicOut` once because its fee is already included; holder exit and ragequit subtract the full note value. Donations do not create note liabilities or consume cap headroom.
- The registry's immutable Guardian can immediately reduce either cap, including below current accounted balance. Increases require a new proposal and a full **12-hour delay**. Replacing a proposal resets the delay; changing caps clears the old proposal. Mixed increases/reductions must be separated into a reduction and a fresh delayed increase.
- Guardian deposit pause affects only `depositDynamic`. Normal withdrawal, private transfer, holder exit and ragequit remain outside deposit-cap/pause checks. DEX reshielding is a new deposit: a full or paused target pool atomically reverts the complete swap and restores the source note and fee movements.
- The selected new-adapter DEX fee is **30 bps (0.30%)**, with immutable rate and Safe treasury per deployment. The pure official relay fee-policy v2 component selects 30 bps for withdrawal/relayed holder exit plus a fixed, prequoted gas amount in the pool asset. Deposit, private-transfer and ragequit service charges are zero; the launch relay subsidizes transfer/ragequit gas. This is not a mandatory core-pool percentage tax and is not a live relay rollout. See [fee policy v2](FEE_POLICY_V2.md).
- The **16-epoch** ASP window is retained from RC.1. Note format, circuit statements, final proving keys and verifier bindings are unchanged; caps do not require another contribution ceremony. Core and fee-component builds have fresh hashes because the pool bytecode changed; the final inventory must bind those builds and their acceptance evidence.

## Verification status

The updated Foundry suite has passed **68 tests**, with **1,000 runs per fuzz test** and an invariant campaign of **128 runs × 40 calls = 5,120 calls, zero reverts**. It covers cap boundaries, forced ETH and ERC20 donations, fee accounting, Guardian delay/cancellation, pause, exits below a lowered total cap and atomic DEX rollback. Verifiers and DEX liquidity in these suites are mocks; this is not a proof-soundness or real-market test.

RC.2 final-parameter acceptance has passed against the rebuilt production candidate contracts:

| Run | Actual result | Preserved evidence |
| --- | --- | --- |
| Native pool | **43 checks, 11 actual final Groth16 proofs, 48 local transactions** | `audit/acceptance/standalone-20261016-r2/native.json`, run `d2172cda-01bc-4b26-8d43-95b1d0e241c3` |
| Fee adapters | **22 checks, four actual final proofs, 73 local transactions** | `audit/acceptance/standalone-20261016-r2/fees.json`, run `e7cf5b6d-36ec-41cc-9e68-2dcde9f48d3d` |

Combined: **15 actual proofs and 121 local transactions**, all on isolated local Anvil chains with zero public-chain transactions. Native acceptance executes the following real-proof spends and exits while deposits are paused and caps are below the existing reserve. Fee acceptance uses actual finalized verifiers/pools/adapters with explicit mock routers, tokens, factories and liquidity; it does not test market prices or actual mainnet fills.

Both fee routes measure gross output 10,000 raw units, charge 30 and restore B's private note of 9,970. B's subsequent normal withdrawal debits gross 9,970 once: percentage fee 29 plus **synthetic fixture gas quote of three raw units**, fee recipient 32 and B net 9,938. This three-unit fixture is not the production ETH gas quote.

| RC.2 build | SHA256 |
| --- | --- |
| `artifacts/phase2-mainnet/contracts.json` | `6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e` |
| `artifacts/phase2-fees-mainnet/contracts.json` | `52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a` |

The final inventory path is `artifacts/phase2-mainnet/release-candidate-20261016-r2.json`; its SHA256 is `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3`. Historical RC.1 reports/builds are retained under `audit/baselines/v0.1.0-rc.1/` and in the original tag. They remain evidence for RC.1 only.

The final proving-material provenance and separately recorded observation of the selected Safe as Safe 1.5.0, 2-of-3, remain available for review. They do not establish independent audit, destruction of contribution randomness, future Safe ownership or a live Lincoln deployment.

## Selected deployment policy

| Item | RC.2 selection or unresolved status |
| --- | --- |
| Chain | Robinhood mainnet, **4663** |
| Guardian and DEX treasury | Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555` |
| Mainnet deployer | **Unconfigured**: address and signing account are null; use a new dedicated key outside the testnet machine |
| Dedicated ASP provider | `0xce6770154D793dF78FbfA0D3615B2946366E6612`; not funded by this revision |
| ASP bootstrap | Self-hosted, all current notes; **no source screening or new denylist** |
| Accepted policy window | Latest plus up to 15 predecessors, also subject to expiry and one-hour superseded grace |
| Provider rotation | Guardian proposal and new-provider acceptance after three days |
| ETH initial deposit/accounted-reserve caps | **1 ETH / 20 ETH** |
| USDG initial deposit/accounted-reserve caps | **2,500 USDG / 50,000 USDG**, using six decimals |
| Each selected stock | Target approximately USD 2,500 / USD 25,000 at a pinned valuation snapshot; **exact raw-token caps unresolved** |
| Selected DEX fee | **30 bps**, immutable treasury and rate per new adapter |
| Official relay launch fee policy | v2 component prepared; **mainnet runtime not configured** |
| Mainnet relay single-transaction gas ceiling | 5,000,000, separate from an explicit cumulative spending budget |
| Staged pool/route examples | ETH, USDG and NVDA; six fixed UP/Uniswap routes, subject to asset-specific acceptance |

Stock symbols in configuration are candidates. A dollar target is not a Solidity cap: resolve actual raw-token price, decimals, corporate-action/UI multipliers and liquidity at a fixed block before supplying non-null constructor values. No missing cap may default to unlimited, and none of these stock pools is already deployed. See [stock selection policy](STOCK_SELECTION_POLICY.md). Fixed raw caps do not maintain a constant USD exposure as prices change.

## Required before mainnet launch

1. **Pin this candidate for operations.** The R2 inventory, ABI checks, core/fee/circuit reproduction and public-only native/fee acceptance have passed. Preserve the exact tag and inventory when preparing deployment; changing a bound configuration requires a new explicit snapshot.
2. **Resolve deployment inputs.** Supply the new public mainnet deployer address and isolate its key from testnet. Resolve every selected stock's raw caps from pinned evidence; omit unresolved stocks from a deployment selection. Recheck Safe configuration, token identities, issuer state and actual DEX pools.
3. **Finish fee deployment and activation.** The core deployer currently deploys free adapters. The fee component has an offline plan with no enabled deployment executor or activation. Complete shared-ledger signing, canonical receipt/runtime/immutable checks and new-address route activation before claiming paid routes are live.
4. **Approve and configure actual mainnet funds.** Deployment gas, total funding, acceptance principal and maximum gas price remain unapproved/unset. Fund and budget deployer, relay and ASP explicitly. Earlier testnet gas authorization does not apply to real ETH; the pool's deposit caps do not constitute an operations budget.
5. **Start mainnet services deliberately.** Deploy verified production profiles, the independent signer and ASP publisher on separately prepared mainnet infrastructure. Configure per-pool v2 quotes, gas-quote limits, fee routing and persistent recovery state before enabling signing. This core revision does not update EC2, live testnet pricing, public endpoints, indexer performance or ASP cadence.
6. **Run real mainnet A/B acceptance.** With an explicitly approved small amount, test deposits, merged payment, recovery, respend, actual two-way DEX trading, net service fees, withdrawal and public exits. Local mock liquidity and testnet reports cannot replace this step.

Audit is intentionally deferred under the current launch decision. No independent audit has been completed; this document does not add an unrequested approval gate or imply that postponing audit removes contract risk.

## Repository and deployment boundary

This repository supports contract/circuit review and reproducible validation. It excludes production keys, password files, signer ledgers, hosted secrets, wallet data and pending hosted-backend work. Indexer read-load improvements and an ASP denylist require separate backend/policy releases. Mainnet signing is not enabled by compiling or publishing this core candidate.

A later operations release must identify its exact frozen core/fee artifacts, final proving manifests and configuration snapshot. Changing budgets/configuration needs an explicit new snapshot where the inventory binds that file; it does not require another proving ceremony when circuit/key bindings are unchanged. Compatible DEX adapters can be deployed separately; changing note structure, proof statements or core accounting requires a separately reviewed version.
