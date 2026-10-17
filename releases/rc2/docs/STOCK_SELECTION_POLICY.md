# Stock selection and raw-unit cap policy

This is the RC.2 selection procedure, not an asset-listing announcement or completed market study. The initial implementation scope is **ETH, USDG and NVDA**, subject to their release acceptance. Selecting five to eight stock assets is a later target, conditional on data and per-asset acceptance; the candidate list below is not an approved or deployed roster.

The current RC.2 target deliberately leaves the new mainnet deployer address/account **null** and all monetary budgets unset. ETH/USDG caps are configured in raw units. NVDA, SPY and AAPL use `status: valuation-required` with null raw caps, fixed block and raw-token reference price; multiplier and live-liquidity checks are still pending. No stock dollar target in this document fills those values or makes a stock deployable. The selected Lincoln swap charge is **30 bps**, separate from venue fees and any official-relay withdrawal gas quote.

## Canonical asset identity

Use Robinhood's official [Token Contracts](https://docs.robinhood.com/chain/contracts/) page and its on-chain asset-registry identity. Matching a ticker or token logo is insufficient. The official [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/) document a public asset metadata endpoint, including deployments by chain. That API is a useful cross-check, not a substitute for pinned-block on-chain checks.

A single read-only request to the [official asset endpoint](https://api.robinhood.com/rhj/assets) on **2026-10-16, America/New_York** returned the following chain-4663 identities. These are discovery observations; no addresses were screened, no ranking was computed and no market quote or chain transaction was requested for this table.

| Symbol | Official API chain-4663 address | Reported token decimals | Stage |
| --- | --- | --- | --- |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 | Initial stock candidate, still needs RC.2 cap evidence and acceptance |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 18 | Later candidate |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 18 | Later candidate |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 | Later candidate |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 18 | Later candidate |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 18 | Later candidate |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | 18 | Later candidate |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | 18 | Later candidate |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 18 | Later candidate |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | 18 | Later candidate |
| NFLX | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | 18 | Separate multi-asset plan candidate, not an extra launch commitment |

All returned records above had `ASSET_STATUS_ACTIVE`. That metadata does not establish that a token or participant is unblocked, that a route exists, or that an AMM can fill the required trade. The API response was not a fixed-block evidence bundle; deployment must re-resolve canonical identity, decimals and actual implementation at the selected block.

The official token-contract page separately identifies WETH as `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` and USDG as `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. The release targets USDG's six raw decimals, to be verified on-chain; native ETH has 18 decimals. No whole-share assumption changes any ERC20 raw unit.

## Corporate actions and price units

Robinhood's [integration guide](https://docs.robinhood.com/chain/building-with-stock-tokens/) states that stock tokens use 18 ERC20 decimals and expose the ERC-8056 UI multiplier. Raw balances do not rebase when the multiplier changes. A token unit can represent a changing number of underlying shares.

The same guide says that the on-chain Chainlink price already incorporates the multiplier. The [API guide](https://docs.robinhood.com/chain/stock-token-apis/) says REST `/prices` reports underlying-equity bid/ask without that adjustment. Therefore:

- Price caps against a **raw token unit**, rather than assuming one token always equals one share.
- Do not multiply an already adjusted Chainlink token price by the UI multiplier again.
- If REST underlying prices are used as an auxiliary reference, convert them using the matching multiplier and timestamp; do not substitute an unpinned API observation for block-bound evidence.
- Record `uiMultiplier`, pending multiplier/effective time, price-feed units and freshness. Do not treat the REST underlying `dailyTradingVolume` as seven-day on-chain token volume.

These unit differences matter even when the token satisfies the exact-transfer checks. Issuer pause/block/burn/upgrade powers remain independent constraints and cannot be bypassed by holder exit or ragequit.

## Fixed-block evidence to collect before selecting a stock

Choose a canonical mainnet block number **B** and hash **H**. Record chain ID and genesis identity, and ensure all supported contract reads and quoter simulations use B. Recheck H after the read set; if canonical identity changes or a provider does not support the pinned reads, discard that bundle rather than mixing blocks. A fork acceptance run must identify the same block or a clearly documented later block and repeat relevant identity checks.

For each candidate, retain a public, hash-addressed evidence record containing:

1. Symbol, canonical token address, registry identity, raw `decimals()`, runtime hash, proxy implementation identity/hash, issuer control/status observations and corporate-action multiplier data. Explicitly mark any unsupported status getter as unknown rather than infer unpaused from missing data.
2. Each usable USDG route: DEX/factory/router/quoter addresses and code identities, pool address and fee/tick settings, route direction, pool price state and active liquidity. Active liquidity is not itself an USD-denominated trading-depth measurement.
3. Real quoter simulations at B for **1,000 and 5,000 USDG** buys, and comparable-value stock sells in both directions. With six-decimal USDG those inputs are `1000000000` and `5000000000`. Save raw amounts, outputs, revert reasons and quote gas, and distinguish gross DEX output from the 30-bps Lincoln fee and net reshielded output.
4. An explicitly defined normalized reference price and calculated price impact. State whether the metric includes venue fees; compute slippage relative to a consistent decimal-normalized reference instead of comparing unscaled raw amounts. Discovering a pool or obtaining a tiny quote does not establish large-trade liquidity.
5. Seven days of canonical on-chain `Swap` events ending at B, with start/end blocks and their timestamps, volume units and USD conversion method. If holder count is used, cite a dated source or a complete transfer reconstruction; a few recent logs are not a holder count. These are future data-collection tasks, not work performed by this policy document.
6. Exact proposed cap integers and their derivation, including budget units, price normalization, direction/route used, rounding quantum, liquidity constraint and observed timestamp.

The stock cap target is approximately **USD 2,500 per dynamic deposit** and **USD 25,000 of accounted reserve** at the selection snapshot. The reserve target must also be checked against executable market depth: a nominal cap is unsuitable if the corresponding exit route would have excessive impact. A suggested 2% price-impact limit is a selection criterion requiring explicit measurement and chosen trade size, not a contract guarantee or a proven relationship between TVL and pool liquidity.

## Converting a dollar target to an exact cap

Caps are on-chain **raw token integers**, not live dollar or share quantities. Use arbitrary-precision integer arithmetic throughout.

For example, let `budgetMicro` be a chosen USDG-denominated budget in six-decimal units, `d` the stock's verified decimals, and `priceMicro` a documented conservative reference expressed as micro-USDG per one whole raw token (`10^d` units). Then the dimensionally correct reference conversion is:

```text
rawReferenceCap = floor(budgetMicro * 10^d / priceMicro)
rawRoundedCap   = floor(rawReferenceCap / chosenRawQuantum) * chosenRawQuantum
```

This formula assumes the chosen reference values one USDG consistently with that budget; it does not prove that USDG is always worth one US dollar. Record any USD/USDG conversion used. Use a positive, conservative token price with known units and no duplicate multiplier. A default price of zero, a JavaScript floating-point estimate or a ticker-derived price is invalid.

A real pinned-block USDG-to-stock exact-input quote gives an additional directly observable raw-output bound for the same budget. Retain and reconcile that quote, reference conversion and the selected liquidity bound. Document which conservative bound is selected and why; do not invent a raw cap when those inputs are unavailable. Repeat the reverse-direction quote to measure exit quality. No perpetual dollar ceiling can be inferred from a cap computed once at B.

The initial non-stock conversions are already exact:

| Asset | Single deposit raw units | Accounted-reserve raw units |
| --- | --- | --- |
| ETH | `1000000000000000000` | `20000000000000000000` |
| USDG | `2500000000` | `50000000000` |
| NVDA and later stocks | **Pending fixed-block reference/real-quoter evidence** | **Pending fixed-block reference/real-quoter/depth evidence** |

Missing or ambiguous stock cap evidence leaves a stock unresolved. It must not turn into zero-as-unlimited, a copied cap from another asset or a guessed whole-share number. Lower caps can be chosen explicitly; higher caps follow the Guardian's on-chain delay after deployment. A later market-price or corporate-action change does not automatically reprice these raw-unit caps.

The cap parser checks explicit raw-integer shape, range, ordering and configured status; it is not an oracle or an attestation of a valuation record. Changing a configuration label to `configured` does not demonstrate that its underlying market study occurred. The release process must retain the actual fixed-block evidence and approved conversion when replacing a pending stock cap.

## Per-asset release gate

Before enabling a new pool, verify exact-transfer behavior with nonzero balances and run a pinned-fork lifecycle: deposit, ASP admission, private payment, recipient recovery and respend, withdrawal, holder exit, original-deposit ragequit, and USDG-to-stock/stock-to-USDG routes. Include issuer-related failure simulations and capped/paused target-pool atomic reverts where the test harness permits them. Zero-value transfer simulation is not a substitute for nonzero flow acceptance.

Plans state that an older NVDA integration was exercised on a mainnet fork. This document does not independently authenticate that report or carry it forward as RC.2 acceptance. Final-proof local tests in RC.1 used mock DEX fixtures. Neither establishes live mainnet stock execution for the new capped pool. After fork acceptance, an explicitly budgeted small real-mainnet A/B and DEX run is still required before marking live routes accepted.

Adding a later stock with the same finalized circuits deploys a new instance of the frozen pool code, not a mutation of existing immutable pools. It still needs its own caps, runtime/profile verification, route adapters, publisher roster capacity, indexer coverage, relay endpoint and acceptance record. Five to eight stocks must not be enabled by a frontend ticker list alone.
