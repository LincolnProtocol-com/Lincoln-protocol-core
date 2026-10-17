# New asset source and issuer review (chain 4663)

Read-only review on 2026-10-17. No signatures, broadcasts, production config or frontend changes. This is integration research, not an independent audit. Full machine-readable evidence and source-file SHA256s are in `source-review.json`; public source URLs and file hashes are retained; raw responses are in the local research cache.

| Asset | ERC20 transfer tax / raw rebase | Administrative powers | Integration result |
|---|---|---|---|
| AAPL | No transfer tax in current code; ERC-8056 multiplier changes UI shares per token, not raw balance | Registry can blacklist, pause, upgrade Stock implementation; issuer can mint/burn, including `adminBurn` bypassing paused/blocked checks | Raw accounting can work, but the requested literal “no blacklist / no freeze” condition is false. Must disclose issuer risk. |
| USDe | No ERC20 transfer tax or rebase in current USDeOFT | No local address freeze/blacklist/pause or direct third-party burn; owner controls OFT peers, endpoint delegate, bridge limits and message options/inspector | Local transfers are compatible; bridge liveness/security/admin risk remains. This is USDe, not yield-accruing sUSDe. |
| PONS | No transfer tax/rebase; fixed one-billion initial supply | No owner, proxy, post-deployment mint, blacklist or pause. Fixed 366-block launch protections; factory initial-buy exemption is launch-block only | Require pinned block > `restrictionEndBlock`, then no launch restrictions can be re-enabled. |
| CASHCAT | No transfer tax/rebase; fixed one-billion initial supply | No owner/proxy/mint/blacklist/pause. Fixed launch-block/max-wallet/tx.origin restrictions lasting 366 blocks | Require pinned block > `restrictionEndBlock`, then plain ERC20 transfers. |
| LINCOLN | No ERC20 transfer tax/rebase; holder can burn own tokens | Creator/editor can change metadata until creator locks it; no supply/balance/freeze privileges | Explorer token unverified; entire runtime including metadata matches local HedgeFunToken artifact after declared creator/launcher immutable substitutions. V4 route is a separate extension. |
| SPCX | Same raw accounting and multiplier as AAPL | Same exact Stock implementation and issuer registry as AAPL | Subject to the same freeze/pause/admin burn/upgrade risks. Needs a new capped private pool for private-to-private swaps. |

AAPL/SPCX proxy beacon and access-control registry: `0xe10b6f6B275de231345c20D14Ab812db62151b00`. Current Stock implementation from explorer: `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`. `Stock.transfer/transferFrom/approve/permit` explicitly check paused/blocklisted state. `adminBurn(address,uint256)` can remove any holder’s balance. A guardian, Ragequit or a successful simulation cannot remove those issuer powers.

The 274 indexed registry events were replayed from 6 pages to identify role-holder candidates. `source-review.json` preserves role hashes and candidates. All 13 replayed current role holders were confirmed with direct pinned `hasRole` calls at block 90833751. Registry/AAPL/SPCX pause flags were false, and the existing relay, Safe, V4 PoolManager, hook and HedgeFun treasury were not blocked. The future Lincoln pool/adapter addresses still require checks before activation. None of these current flags removes issuer powers.

## Source identity and verification limits

Source snapshots preserve `is_verified`, `is_fully_verified`, `is_partially_verified`, compiler version and source-file hashes. AAPL/SPCX proxies, USDe, PONS, CASHCAT and the five proposed V3 pools are **partially verified** according to Blockscout; the Stock implementation and AccessControlsRegistry are fully verified. Never describe all of them as full exact metadata matches. The companion root RPC probe compares actual runtime hashes and pinned contract state; source review does not replace that probe. No fresh full compiler build was run here.

USDe source includes standard OpenZeppelin ERC20 plus OFT credit/debit: received, authenticated endpoint/peer messages mint, while outgoing sends burn the caller’s own balance. Owner changes can disable/corrupt cross-chain paths without a local `transfer` blacklist. `renounceOwnership` always reverts. Official Ethena address documentation gives the common L2 address, but the fetched chain list does not explicitly name Robinhood. At block 90833751, USDe owner is `0x5B29AcbB51A1290ebda7f6A7a209Aa08cAA35901`, pendingOwner and rateLimiter are zero, and endpoint is `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B`.

PONS and CASHCAT restriction parameters come from the exact deployment constructors and code, not current launchpad marketing defaults. PONS official docs identify `0x39dB...4571` and canonical 1% WETH pool `0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA`.

## V3 route candidates

All five supplied pool addresses expose `UniswapV3Pool` verified source. Runtime identity alone does not establish a pair: validate `factory`, `token0`, `token1`, `fee`, and `factory.getPool` at the same pinned block, then quote both directions at the intended amount. Root RPC acceptance records those checks. The review does not establish current dollar prices or endorse any liquidity-depth estimate.

## LINCOLN / SPCX V4 route

`0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE` is the LINCOLN **token**, not an individual pool contract. It launched through HedgeFunV2Factory strategy ID 2. SPCX is `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`.

At block 90832363, factory `graduationConfig(2)` and hook `rates(poolId)` agree:

- PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
- currency0: LINCOLN; currency1: SPCX; static LP fee 2000 pips (0.2%); tickSpacing 60.
- Hook: `0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC`.
- Pool ID: `0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55`.
- Hook tax: **100 bps (1%) both directions**, zero spike and launch surcharge. This is a swap-hook tax, not an ERC20 transfer tax. LP fee and Lincoln’s planned 30 bps service fee are additional layers; exact amounts must come from execution-aware quotes.
- Initialization: block 90821662, transaction `0x26f9c373dece8f671319393ea2476bc2093f8322ab178bb55b2e23c86aa313e7`.
- Locked liquidity vault: `0xA6dF493aC0FCF58aa1acFB60FA2aB96a01c17E30`.

Existing V3/Router02 adapters cannot express or settle this V4 PoolKey. The typed extension plan in `source-review.json` keeps deployment disabled and leaves LINCOLN/SPCX caps unset pending human decisions. A dedicated exact-input V4 adapter must authenticate PoolManager callbacks, pin the complete key/hook, settle actual asset deltas, enforce minimum output and proof-authorized receiver, account for the hook tax, and be accepted on a local mainnet fork before deployment. Exact-input buys can fail `PartialFillRefused`; exact-output sells are refused. Start with exact-input swaps in both directions.

Current hook owner at block 90833751 is Safe `0x2910117dd2cB431173Ae9Fb6eAF30726321d1693` (the constructor initial owner was the local deployer, so current ownership must not be inferred from constructor arguments). Hook owner can redirect the protocol payout and propose a creator-payout takeover after 14 days (creator veto gives 180 days quiet). In reviewed code it cannot change an existing pool’s tax, treasury or liquidity. The separate SPCX issuer can still freeze/burn collateral. Both new private pools, relays, indexer, ASP and fee prices must be extended together before private-to-private release. No V4 adapter, liquidity creation or mainnet swap was performed here.

## Primary sources

- [Robinhood Stock token docs and multiplier](https://docs.robinhood.com/chain/stock-tokens/).
- [Robinhood canonical token entrypoint](https://docs.robinhood.com/chain/contracts/).
- [Ethena key addresses](https://docs.ethena.fi/technical-design/key-addresses.md).
- [pons official reference token and contracts](https://docs.ponsfamily.com/).
- [AAPL Stock implementation](https://robinhoodchain.blockscout.com/address/0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2?tab=contract).
- [Issuer registry / beacon](https://robinhoodchain.blockscout.com/address/0xe10b6f6b275de231345c20d14ab812db62151b00?tab=contract).
- [USDeOFT](https://robinhoodchain.blockscout.com/address/0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34?tab=contract).
- [PONS](https://robinhoodchain.blockscout.com/address/0x39dbed3a2bd333467115de45665cc57f813c4571?tab=contract).
- [CASHCAT](https://robinhoodchain.blockscout.com/address/0x020bfc650a365f8bb26819deaabf3e21291018b4?tab=contract).
- [LINCOLN launch](https://robinhoodchain.blockscout.com/tx/0x0b8410b8d3d3693455ef1dc2df19fbfb81ce80e11f11f87a54e3a3ed0a351509).
- [V4 hook](https://robinhoodchain.blockscout.com/address/0xb5babc5609de876d56662d066a0b5f63ef90a8cc?tab=contract).
