# Stock pools: initial capacity of 100 tokens each

The user's 17 October 2026 decision replaces the future stock pools' total-capacity rule with **100 Robinhood stock tokens per pool**. The public operational policy is [stock-capacity-mainnet-100-tokens-20261017.json](../config/stock-capacity-mainnet-100-tokens-20261017.json). It preserves the approved seven token addresses and the earlier fixed deposit limits. Stock pools remain **undeployed and disabled**. The existing ETH/USDG deployment, frozen RC.3 sources, ABI, circuits and proof parameters are unchanged.

The capacity is the pool's outstanding note-backed `accountedBalance`, not a limit per wallet or a limit on lifetime volume. Withdrawals free capacity. Unsolicited ERC-20 donations do not consume it. Quantities use native ERC-20 units: an issuer multiplier or corporate action can change the underlying share exposure represented by one token. This is therefore a fixed cap of 100 tokens, rather than a promise of exactly 100 underlying shares after every issuer action.

| Stock token | Max single deposit (tokens) | Max single deposit (raw) | Max pool total (tokens) | Max pool total (raw) |
| --- | ---: | ---: | ---: | ---: |
| NVDA | 11.4 | `11400000000000000000` | 100 | `100000000000000000000` |
| SPY | 3.2 | `3200000000000000000` | 100 | `100000000000000000000` |
| META | 3.4 | `3400000000000000000` | 100 | `100000000000000000000` |
| TSLA | 7 | `7000000000000000000` | 100 | `100000000000000000000` |
| GOOGL | 7.3 | `7300000000000000000` | 100 | `100000000000000000000` |
| QQQ | 3.5 | `3500000000000000000` | 100 | `100000000000000000000` |
| MSTR | 18.3 | `18300000000000000000` | 100 | `100000000000000000000` |

For precision `d`, compute `maxTotalRaw = 100 * 10**d` with integer arithmetic. The single-deposit cap is `min(previousMaxDepositRaw, maxTotalRaw)`. All seven prior deposit limits already fit below 100 tokens. They retain the original approximately USD 2,500 quote reference; there is no live USD cap or price oracle. Prices and issuer multipliers do not automatically alter either limit. The prior approximately USD 25,000 total-cap rule is superseded for these future pools, while its historical dataset remains intact for RC.3 review.

## Precision observation

A read-only check against the official Robinhood mainnet RPC confirmed chain ID `4663`, its pinned genesis, and code plus `decimals() == 18` at all seven addresses at block **90,698,458**, hash `0x5a4b9d6d65a39891a32444afd199e2d0ceda75a8718f4cd1884077990d4bbfa6`. The policy records the block and observation. This check did not verify issuer implementation hashes, current issuer eligibility or DEX liquidity, and did not sign or broadcast transactions.

## Offline plan and deployment boundary

```sh
node scripts/operations/stock-capacity-plan.mjs --plan
```

This command reads two public policy files and prints the exact caps and symbolic constructor dependencies. It has no RPC connection, signer, private-file access or broadcast mode. Its `readyForBroadcast` result remains `false`, because live deployment checks are performed by the separate explicit command below.

## Explicit seven-pool deployment

In the local checkout that already contains the completed ETH/USDG deployment and original signing ledger:

```sh
cd /Users/leo/Lincoln-protocol-core
bash scripts/deploy-stocks-mainnet.sh --plan
bash scripts/deploy-stocks-mainnet.sh --deploy
```

Enter the `lincoln-deployer` password only at the local terminal prompt. The shell keeps it in a temporary mode-600 file and deletes it on exit. It runs no test suite and no `npm ci`; the frozen source hashes, finalized proof parameters and reproducible compiler/bytecode checks still run before signing.

The command deploys exactly seven new stock pools. It verifies the seven already deployed core contracts against the pinned [public deployment manifest](../deployments/robinhood-mainnet/rc3-eth-usdg.json), canonical creation transactions, constructor data, linked runtimes, immutable getters and initial-cap events. No library, verifier, registry or ETH/USDG pool is redeployed. The stock constructor uses the existing registry and final verifiers.

The same original account ledger retains the cumulative **0.065 ETH** gas budget, **2.8 gwei** global gas ceiling and **0.003 ETH** reserve. New stock transactions have an additional stricter **1 gwei** ceiling, quoted at `min(freshNodeQuote * 100, 1 gwei)`; a fresh node quote above 1 gwei is rejected. Their gas limits are 6,000,000 each. The initial seven-pool upper bound is **0.042 ETH**, so the initial balance must cover **0.045 ETH** including reserve and cumulative history must fit the existing budget. These are ceilings, not amounts paid in advance. No token transfer or DEX adapter transaction is included.

The stock journal has its own deterministic plan ID under the existing RC.3 snapshot, while reservations use `deploy:<stockPlanId>:pool:<symbol>` in the original physical signer ledger. Re-running the same command verifies confirmed pools and resumes an exact unsigned prepared intent. Any unresolved signed or broadcast transaction blocks further signing. An interrupted process may leave a store lock: do not delete it or reset the ledger without inspecting the owner/process first.

For an unknown hash, use the existing recovery tool. The first command only checks the recorded signed transaction. The second explicitly rebroadcasts the identical signed bytes if appropriate; it cannot raise gas, change the nonce or sign another transaction:

```sh
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash>
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash> --rebroadcast
node scripts/operations/recover-mainnet-broadcast.mjs --hash <transaction-hash>
```

After canonical confirmation, resume `bash scripts/deploy-stocks-mainnet.sh --deploy`. Do not resume the ETH/USDG or RC.2 command for stock deployment.

Successful completion writes public stock profiles under the RC.3 snapshot's `config/phase2-mainnet-profiles/` and the aggregate manifest `deployments/robinhood-mainnet/stocks-100-tokens.json` in the root checkout. That manifest is the completion marker. It keeps `stockTradingEnabled: false`: deploying the seven pools does not deploy their DEX routes or complete asset-specific acceptance. The backend can then register the new profiles with indexing, ASP publication and relaying before enabling use.

The current `scripts/deploy-mainnet.sh` command is deliberately restricted to the seven existing core deployments: two Poseidon libraries, two verifiers, the ASP registry, and ETH/USDG pools. Do not change its scope or modify its completed deployment journal to add stocks. Frozen `normalizeAdoptedDeployments()` only supports the two Poseidon libraries; passing five shared contracts to that function will fail. Selecting a route in the older generic engine also selects its stock pool and includes ETH/USDG and registry/verifiers, so that entry is not a safe stock-extension command.

The separate root operational deployment entry uses a distinct public extension manifest and follows these boundaries:

1. Bind the completed ETH/USDG core manifest and frozen RC.3 artifact hashes. Recheck canonical receipts, creation calldata, linked runtime and immutable getters of the **five shared components**, then preserve the two existing pool addresses. The stock pools reuse the two Poseidon libraries, two final verifiers and the ASP registry; ETH/USDG pools are existing route endpoints, not components to redeploy.
2. Create only the selected stock pool instances from the existing `Phase2ASPPool` artifact. Constructor arguments are the existing join-split verifier, holder-exit verifier, registry, the official stock-token address, and that stock's `maxDepositRaw` / `maxTotalRaw` from this policy. Do not build new circuits or replace existing pools.
3. Use the same physical deployer account ledger with fresh stock-extension reservation IDs and a separately bound extension plan. Preserve every earlier entry, receipt, fee and signed transaction. Do not reuse the completed ETH/USDG journal as the stock journal or treat a changed config as the old release manifest.
4. Add only independently verified, selected USDG buy/sell routes, with explicit router/factory/pool/code-hash bindings and minimum-output validation. One stock on one venue normally adds one pool and two direction-specific adapters. Compatible multihop paths and ETH wrapping continue to use the existing adapter capabilities.
5. Publish additional stock profiles and deployment blocks to the indexer, ASP publisher, relayer, SDK and frontend. Keep the existing ETH/USDG profiles intact. Verify the asset's deposit, approval, private spend, withdrawal, recovery and public exits, plus both DEX directions before enabling it for users.

A new operational extension manifest is required because constructor caps differ from the frozen dataset; editing the frozen candidate or merely setting `stockPoolsEnabled: true` would break its binding. The stock-only command implements pool deployment; verified DEX routes and backend activation remain separate follow-up work. The core contract implementation and proof statement are reused without changing the already deployed ETH/USDG instances.

## Later cap changes

A new stock pool starts with the constructor's 100-token total and does not wait 12 hours for its initial constructor value. For an already deployed pool, the Safe Guardian can lower caps immediately; increasing a cap still requires `proposeCapIncrease(...)`, **12 hours**, and `acceptCapIncrease()`. This cannot be disabled through frontend or backend configuration. Raising one pool's capacity does not change any other pool, and pausing deposits does not block spending or public exits.
