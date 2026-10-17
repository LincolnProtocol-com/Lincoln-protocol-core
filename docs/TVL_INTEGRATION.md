# Mainnet TVL and public data integration

This is the integration handoff for the deployed Robinhood Chain pools. The [README address tables](../README.md#mainnet-address-book) are the human-readable entry point; [`address-book.json`](../deployments/robinhood-mainnet/address-book.json) is a Lincoln-specific machine-readable roster. It is not a DefiLlama adapter or an official DefiLlama schema, and no submission or listing is claimed.

## Inputs and provenance

- Chain ID: **4663**, Robinhood Chain mainnet, native ETH with 18 decimals.
- Genesis: `0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c`.
- Custody roster: exactly the nine pools in `address-book.json.pools`.
- Deployment starts: each pool has its own `deploymentBlock`, creation transaction/block hash and runtime code hash.
- Public contract interface: [`abi/PrivacyPool.json`](../abi/PrivacyPool.json); [`abi/manifest.json`](../abi/manifest.json) binds all review ABIs to RC.3.
- Original evidence: the [ETH/USDG manifest](../deployments/robinhood-mainnet/rc3-eth-usdg.json), [stock manifest](../deployments/robinhood-mainnet/stocks-100-tokens.json), [stock verification](../deployments/robinhood-mainnet/verification/stocks-100-tokens-20261017.json) and [nine-pool state observation](../deployments/robinhood-mainnet/verification/nine-pool-state-20261017.json). Their file hashes are recorded in the address book.

The two original deployment manifests intentionally retain `relayer: null`: they describe deployment-time profiles. The README and address book separately identify the subsequently provisioned operational relay. Neither file should be rewritten to make a historical deployment profile look like a live service attestation.

## TVL calculation

At one requested canonical block, sum each pool's underlying custody exactly once:

| Pool kind | Raw balance query | Units |
| --- | --- | --- |
| ETH | `eth_getBalance(pool, blockTag)` | Wei, 18 decimals |
| USDG | `USDG.balanceOf(pool)` at the same block | ERC20 base units, 6 decimals |
| Each stock | That stock token's `balanceOf(pool)` at the same block | ERC20 base units, 18 decimals |

The ETH asset identifier is the zero address; it does **not** mean an ERC20 `balanceOf` call to address zero. Stock pools hold the actual listed issuer tokens, not a separate Lincoln receipt token.

Read `pool.accountedBalance()` separately as the note-backed liability diagnostic. It is already backed by the custody balance, so adding it to that balance double counts the same assets. Actual custody may exceed accounted liabilities because arbitrary donations do not consume deposit capacity. If reporting note-backed TVL rather than gross custody, identify that alternative methodology explicitly and keep the surplus separate. Never silently add both measures. A custody balance below liabilities is a solvency alert, not a reason to replace the observed balance with a larger synthetic figure.

Do not include the deployer, Safe, ASP or relay gas wallets; registry; verifiers; Poseidon libraries; encrypted notes; recovered copies of notes; or aggregate historical deposit volume. Private transfers keep funds in the same pool and must not increase TVL. Public withdrawals reduce custody. A future atomic swap moves value between source and target pools: count the assets still held at the measurement block, not both the historical input and its output. External DEX liquidity belongs to its own protocol accounting.

The current deployments hold no yield strategy, lending position or bridge escrow on behalf of these pools. DEX adapters and routes are not deployed in the published manifests. Do not add prospective contracts to the active TVL roster before a separate deployment and acceptance record exists.

## Pricing and stock units

Use verified chain-specific asset identifiers and pricing mappings. A ticker string alone is not a token identity. Do not assume that a Robinhood stock ERC20 is always equivalent to one underlying share: issuer multipliers and corporate actions can change share exposure. The 100-token stock cap is in native ERC20 units and is not a live USD valuation.

For a stock without an accepted price mapping, report its raw token balance separately or resolve a verified mapping before including it in dollar TVL. Do not substitute the historical constructor-cap reference prices as a live valuation. USDG pricing likewise requires the selected integration's asset mapping; this document does not install an assumed USD peg.

The DefiLlama SDK chain namespace and token-price support must be confirmed during the adapter contribution. Chain ID `4663` in this address book is not a claim that a particular SDK namespace or price route already exists. The read path needs only public RPC and contract calls; it requires no relay credential, ASP approval, spending key or recovery seed.

## Audit and operating status

The address book distinguishes deployed custody from selected fee policies and service activation. The selected 30-bps adapter/service policy does not create a mandatory core-pool fee or establish collected revenue. A future fees/revenue adapter needs observed execution and recipient accounting, independently of TVL.

Stock creation calldata, canonical receipts, runtime hashes, getters, issuer decimals and initial caps were checked in the linked verification record. Nine-pool state reconstruction was checked in a separate read-only observation. Those observations are historical block-specific evidence; they do not certify current service readiness, issuer behavior, practical anonymity, asset-specific trading acceptance or an independent security audit. Use current on-chain reads for mutable policy and balances.
