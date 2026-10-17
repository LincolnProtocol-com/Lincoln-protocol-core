# RC.2 plan reconciliation

This is a design and implementation handoff for the revision after `v0.1.0-rc.1` (core packaging commit `4be4de1`, extracted from upstream `99e0be62475ac95bb5f8030659c782d5275475a1`). It is not a new release inventory, proof-acceptance report, mainnet deployment record or spending authorization. RC.1 evidence remains historical evidence for RC.1; changed source and bytecode require a separately generated RC.2 inventory and fresh acceptance.

Five external planning documents were compared: `MAINNET_CAPS_AND_STOCKS_PLAN.md`, `MAINNET_FEES_PLAN.md`, `MULTI_ASSET_POOLS_PLAN.md`, `INDEXER_OFFLOAD_PLAN.md` and `ASP_DENYLIST_PLAN.md`. They were written against older baselines and contain intermediate proposals. Statements in them attributing decisions to a user are not, by themselves, authorization to operate a wallet, deploy infrastructure, introduce address screening or collect private funds lineage.

## Reconciled scope

| Topic | RC.1 position | RC.2 implementation direction / disposition |
| --- | --- | --- |
| Pool deposit and accounted-reserve caps | Absent | Add per-asset caps, separate accounted balance and deposit-only pause; Guardian reductions are immediate and increases have a 24-hour delay |
| Normal withdrawal and holder-exit official relay policy | v1 coupled fee policy | Introduce separately versioned policy fields; selected launch percentage is **30 bps** for withdrawal and holder exit, plus a prequoted fixed asset-denominated gas component |
| Fee adapter launch selection | 20 bps | Select **30 bps** and the Safe treasury for newly deployed adapters; fee rate and treasury remain immutable per adapter |
| Public deposit and private transfer service charge | Existing configurable relay policy | Launch selection is zero; a zero-fee private transfer means the operator subsidizes its relay transaction gas |
| Ragequit | On-chain fee must equal zero | Keep that condition and full original-depositor refund; an official free relay pays its own network gas |
| Accepted policy window | **16 already implemented and accepted** | Retain 16; do not repeat the obsolete 4-to-16 change or advertise it as a new RC.2 feature |
| Final circuits and verifier keys | Two inputs / two outputs; final keys | Preserve their statements and exact final key bindings; caps do not inherently require a new ceremony |
| First pool selection | ETH, USDG and NVDA example selection | Retain that staged scope, subject to explicit raw caps and asset-specific acceptance; more stocks remain candidates |
| Mainnet deployer | Old public deployer address in the historical target | Use a new, separately controlled mainnet deployer after its public address is supplied; never reuse the testnet EC2 key on mainnet |
| Mainnet monetary limits | Unset | Keep budget/funding/gas-price/principal authorization unset until explicitly supplied |
| Indexer read-load work | Separate local backend work | Some incremental verification/cache/fallback work exists as WIP; it has not been deployed by this core revision and stays a later backend release |
| ASP denylist | All current notes, no origin screening | No new denylist deployment or funds-lineage collection in this core revision; a separate confirmed policy and implementation are required |

The 25-bps example, 0.25% holder-exit proposal and fee-bearing ragequit example in `MAINNET_FEES_PLAN.md` are superseded by the selected **30-bps** withdrawal/holder-exit/swap policy and **zero-fee ragequit**. Its old 20-bps references describe earlier deployments or artifacts. The competitor price claims in that plan have not been independently refreshed for this revision and are not a release acceptance criterion.

The RC.2 working target now sets both `deployer.address` and `deployer.signingAccount` to **null**, with status `awaiting-new-public-address`. The old `0x3643…d298` testnet identity is not a fallback mainnet signer. ETH/USDG have explicit configured raw caps; NVDA/SPY/AAPL retain `status: valuation-required`, null raw caps and unresolved valuation evidence. Offline planning can describe these pending values, but the actual deployment engine must reject an unset deployer or selected unresolved pool caps **before accessing a signer or RPC**. The independent `tests/phase2-mainnet-caps.test.mjs` uses throwing I/O objects to check that ordering and covers uint128/canonical-integer boundaries; it does not authorize funding or verify market values.

## Accounted balance: do not subtract fees twice

In the existing nine-signal transaction interface, **`extData.publicOut` is the gross amount leaving the source pool and already includes `extData.fee`**. The recipient receives `publicOut - fee`, and the fee recipient receives `fee`. The circuit conservation equation and SDK target use `publicOut`, not `publicOut + fee`.

The cap plan's instruction to decrease accounted balance by `publicOut + fee` is incorrect for this interface. RC.2 must use:

| Operation | Accounted-balance change |
| --- | --- |
| Successful `depositDynamic(value, ...)` | `+ value`, after cap/asset checks with atomic rollback on failure |
| Successful `transact` | `- publicOut` once, including the fee already inside it |
| Successful `holderExit` | `- full note value` once; recipient and fee are a split of that value |
| Successful `ragequit` | `- full note value`; fee remains zero |
| Private-only transfer | Zero |
| External token/ETH donation | Zero; increases actual custody without creating a note liability |
| Successful swap | Source decreases by `amountIn`; target increases by the measured **net** amount dynamically deposited after the DEX service fee |

Example: gross `publicOut = 10,000` base units, 30-bps charge and fixed gas quote of two units gives fee `floor(10,000 * 30 / 10,000) + 2 = 32`. The recipient receives 9,968 and accounted balance decreases by **10,000**, not 10,032. The quote/SDK must separately define whether a user's requested amount is gross debit or net receipt; the contract wire format must retain its existing meaning.

Pool cap accounting is not an oracle-valued USD TVL. It counts raw asset liabilities. Donations must not consume cap headroom, and an issuer burn must not be disguised as a smaller liability. An indexer should independently reconcile log-derived reserve, on-chain accounted balance and actual custody. The solvency condition is `actualBalance >= accountedBalance`, with donations allowed as surplus; equality is not a universal invariant.

## Initial cap units

| Asset | Decimals | Maximum single dynamic deposit | Maximum accounted reserve |
| --- | --- | --- | --- |
| ETH | 18 | `1000000000000000000` (1 ETH) | `20000000000000000000` (20 ETH) |
| USDG | 6 | `2500000000` (2,500 USDG) | `50000000000` (50,000 USDG) |
| Each selected stock | Official metadata currently reports 18; deployment must verify it | Approximately USD 2,500 at the recorded selection snapshot; exact raw value unresolved until measurement | Approximately USD 25,000 at that snapshot, further bounded by liquidity; exact raw value unresolved until measurement |

Stock caps must not be guessed from a ticker, a current unpinned UI price or the number 2,500 interpreted as shares. The selection and exact-integer conversion procedure is in [Stock selection policy](STOCK_SELECTION_POLICY.md). Missing stock cap evidence must leave that stock pending rather than silently select unlimited caps. A raw-unit cap is not a perpetual USD loss limit: asset prices, USDG value and corporate-action multipliers can change.

Lowering a cap below existing accounted reserve must not block withdrawal, holder exit or ragequit. Deposit pause and cap checks apply to new dynamic deposits, including adapter reshielding. A full/paused target pool makes the complete source-withdraw/swap/target-deposit call revert atomically. Pool headroom is only a quote-time advisory; execution still enforces the cap.

## Source and integration handoff

These are concrete implementation points to recheck; this document does not assert that every item is already complete.

| Files or area | Required adaptation |
| --- | --- |
| `protocol/phase2-asp/contracts/Phase2ASPPool.sol` and derived `protocol/phase2-mainnet/contracts/Phase2ASPPool.sol` | Keep the production derivation reproducible. Add cap constructor inputs/getters/events/errors, Guardian-only administration, delayed increases and deposit-only pause. Preserve proof/nullifier semantics and zero-fee ragequit |
| `scripts/phase2-mainnet/deploy.mjs` | Update `deploymentSpecs`, pool constructor assembly in `argumentsFor`, `gettersFor`, plan identity and generated profiles. Require explicit per-asset raw caps and verify all constructor/initial-state values, including zero accounted balance and the intended pause state; do not accept the old four-argument constructor |
| `scripts/phase2-mainnet/plan.mjs`, public target and selection configuration | Expose resolved per-asset caps and unresolved stock/deployer state without inventing addresses or assigning monetary budgets. Keep planning offline |
| `scripts/phase2-mainnet/verify-final-parameters.mjs`, `verify-fee-parameters.mjs` | Supply new constructor arguments and check initial/ending accounting. Re-run actual final proofs on the changed pool. Test capped/paused target swaps revert atomically; retain explicit mock-DEX labeling |
| `protocol/phase2-mainnet/fuzz/test/{Base,Pool,Invariant,Adapter,FeeAdapter}.t.sol` | Update deployment helpers and add boundaries, donation surplus, mixed cap changes, pending increases, pause, decreases below reserve and always-available exit tests. Avoid a universal actual-custody-equals-accounted assertion after donations |
| `scripts/phase2-mainnet/build.mjs`, `scripts/phase2-fees/build-mainnet.mjs`, `src/phase2-fees/mainnet-release.mjs` | Rebuild core and rebind fee components to its changed artifact/source hash, even if fee runtime logic is unchanged. Keep immutable 30-bps deployment selection separate from mutable relay withdrawal policy |
| `abi/phase2-mainnet/Phase2ASPPool.json`, `abi/manifest.json`, build/manifests | Re-export rather than manually edit. Preserve constructor, cap events and errors. Verify the new core and fee ABI exports against their respective artifacts |
| `src/phase2-asp/state.mjs` | Recognize cap/pause governance events instead of rejecting them as unexpected pool events. At one pinned canonical block read/validate cap getters and on-chain accounted balance; require event-derived reserve to match accounted balance and actual custody to cover it. Keep legacy ABI support explicit and avoid guessing new getters on old pools |
| `src/phase2-asp/sdk.mjs` and `src/phase2-mainnet/sdk.mjs` | Preserve `publicOut` gross semantics, note format and final manifest loading. Expose additive cap/headroom data without changing note ownership. Direct old pools must not appear to enforce caps they lack |
| `src/phase2-fees/policy.mjs` and later relay quote integration | The extracted pure policy module separates withdrawal, holder-exit and immutable swap rates in v2, with 30-bps launch selection. Use exact integer rounding and asset-denominated fixed gas quotes. Continue zero-fee ragequit and private transfer selection. Shipping the pure module does not update or activate the hosted relayer; coordinate that later release explicitly |
| `scripts/core/acceptance.mjs`, `scripts/core/check.mjs` and release inventory | Bind the new release hash and refreshed acceptance dimensions after genuine runs. Retain old reports; do not make an old passed report satisfy a new pool build. Recheck all temporarily copied validation inputs |

The frontend's proposed getters are `maxDeposit`, `maxTotal`, `accountedBalance`, `pendingCaps` and `depositsPaused`. Final event, tuple and administration method details must come from the frozen ABI. Communicate any differences before frontend activation.

## Separate backend and policy releases

The indexer plan's receipt checkpoint reuse, shared short-lived read snapshots, stale-data fallback and health metadata belong to the backend release. RPC failure must not turn stale state into permission to accept a new private spend. Paid RPC/fallback endpoints are secrets and do not belong in this core package. Shortening ASP publication to 15 seconds also needs journal retention/archival and operational acceptance first; the 16-epoch contract window alone does not implement that cadence.

The denylist plan describes public-ingress address screening, not descendant-note lineage. It raises separate choices about data sources, expiry/fail-closed behavior, exclusion disclosures and whether an official relay serves public exits. Those choices are not enabled here. Keeping the current-note circuit does not justify claiming origin tracing, source screening or automatic revocation of descendants.

New mainnet EC2 capacity, paid RPC accounts, new signer custody, funding, deployed profiles and live real-DEX A/B acceptance remain later operational work. Neither the five plans nor this reconciliation changes the existing null mainnet budgets.
