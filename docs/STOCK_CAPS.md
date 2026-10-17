# Mainnet stock pool caps

The user approved the following seven stock-token caps on 17 October 2026 for `v0.1.0-rc.3`. The machine-readable source is [stock-caps-mainnet-20261017.json](../config/stock-caps-mainnet-20261017.json). These are fixed ERC-20 unit limits, not live USD limits. A later price or corporate-action multiplier change does not update them automatically.

All seven tokens have 18 decimals. The approved reference is the full-precision `tokenAsk` in the frontend handoff, quoted around `2026-10-17T03:34Z`; each exact quote and timestamp is preserved in the JSON. The rounded prices below are for reading only and must not be used to recompute caps.

| Token | Reference tokenAsk (USD, rounded) | Max deposit (tokens) | Max total (tokens) | Max deposit (raw) | Max total (raw) |
| --- | ---: | ---: | ---: | ---: | ---: |
| NVDA | 219.07 | 11.4 | 114 | `11400000000000000000` | `114000000000000000000` |
| SPY | 763.10 | 3.2 | 32 | `3200000000000000000` | `32000000000000000000` |
| META | 715.88 | 3.4 | 34 | `3400000000000000000` | `34000000000000000000` |
| TSLA | 352.53 | 7 | 70 | `7000000000000000000` | `70000000000000000000` |
| GOOGL | 339.73 | 7.3 | 73 | `7300000000000000000` | `73000000000000000000` |
| QQQ | 711.00 | 3.5 | 35 | `3500000000000000000` | `35000000000000000000` |
| MSTR | 136.60 | 18.3 | 183 | `18300000000000000000` | `183000000000000000000` |

For a positive decimal price `p = n / d`, compute raw limits with integer arithmetic:

```text
maxDepositRaw = floor((2500  * d * 10^18) / (n * 10^17)) * 10^17
maxTotalRaw   = floor((25000 * d * 10^18) / (n * 10^18)) * 10^18
```

This floors the deposit to 0.1 token and total to 1 token. [The tests](../test/operations/stock-caps-mainnet.test.mjs) use only `BigInt` rational arithmetic: each cap must fit `uint128`, stay within the USD reference, and exceed it if one more rounding increment is added. Token strings and raw integers must agree exactly.

## Official source verification

[Robinhood Token Contracts](https://docs.robinhood.com/chain/contracts/) identifies its stock table as a live registry. The addresses below were checked against the official [`/rhj/assets`](https://api.robinhood.com/rhj/assets) response on 17 October 2026. All were `ASSET_STATUS_ACTIVE` with `tokenDecimals: 18`.

| Token | Canonical Robinhood Chain address |
| --- | --- |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` |

Each official [`/rhj/prices/{symbol}`](https://docs.robinhood.com/chain/stock-token-apis/) response was also fetched separately. The returned `tokenAsk` strings matched all seven frozen values; every `isTradingHalt` was `false`. The API documentation describes `ask` as the unadjusted underlying ask. The actual response additionally contains `tokenAsk`, which already incorporates the token multiplier. Use that field directly; applying the multiplier again would double-adjust the price. The JSON stores both observed fields and the multiplier to make the distinction reviewable.

The historical quote timestamps come from the user-approved handoff. Our later independent fetch verifies the observed prices and addresses, not the authenticity or publication time of that historical handoff. Response SHA-256 hashes and later API quote times are recorded separately.

Read-only RPC checks used Robinhood Chain ID `4663`, block **90,639,127**, hash `0x937e05e9b1d1b5ad2d296ec1958f555e945ab4f8fef8da1007128f8f0c3bc28f`. Each address had code, the expected `name()` and `symbol()`, `decimals() == 18`, `paused() == false`, and `uiMultiplier()` matching the registry multiplier. Recorded runtime hashes cover the token address only; issuer proxy implementation hashes were not verified. These observations can change and must be rechecked at deployment.

## Deployment status and remaining acceptance

This approval fills in the constructor limits. It does not enable or deploy stock pools: `stockPoolsEnabled` remains `false`. The ETH/USDG deployment command must not silently expand to seven stock pools.

The frontend's selection used official `mintBurnUsdVolume`, which measures issuance/redemption activity and is **not DEX swap volume**. No DEX liquidity ranking or seven-day Swap-event volume is asserted here.

Before enabling an asset, independently verify its current issuer state and implementation, obtain both USDG buy and sell quotes at one fixed mainnet fork block, assess price impact, and run the complete deposit → ASP approval → private transfer → withdrawal / holderExit / ragequit plus USDG ↔ stock acceptance. This revision's dataset and arithmetic tests do not claim that those fork or live DEX checks have passed. The prior handoff reports an NVDA test only; that is not seven-asset acceptance.

After deployment, the Guardian can lower caps immediately. An increase follows the candidate's **12-hour** proposal delay. Pausing new deposits or lowering a cap does not restrict spending and exit paths.

## Adding more stocks later

The pool implementation is asset-specific at construction. A compatible new stock token needs a new pool instance and separately verified routes; it does not require replacing existing ETH/USDG pools or changing their proof statement. Shared libraries, verifiers and registry must be explicitly reused and verified by a future extension deployment. The current RC.3 command is not that extension command.

Prefer staged USDG buy/sell routes. With the current immutable route adapters, each venue and direction needs its own configured adapter: one stock on one venue normally adds one pool and two adapters. Enabling every stock-to-stock pair directly would multiply route deployments. Multihop DEX paths can use USDG/WETH liquidity, but do not automatically make one immutable adapter serve every source/target pair.

For each added asset, verify the official token, issuer behavior, price multiplier, raw-unit caps, both trade directions, minimum output and actual liquidity. Register its pool and start block with the indexer, ASP publisher, relayer, SDK and frontend. Test recovery and every exit path independently. Existing pools and notes remain available.

Each pool has its own commitments and anonymity set. More stock pools increase indexing and ASP work and can spread activity across small sets; the number of listed stocks is not the anonymity-set size. DEX interactions still expose their route, assets, amounts and timing on the public DEX. Fixed token caps also remain quantity limits when market prices or issuer multipliers change; cap changes require a separate governance action.
