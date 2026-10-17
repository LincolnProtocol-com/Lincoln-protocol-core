# LINCOLN / SPCX: fixed-pool V4 route candidate

This is a design and unsigned intent, not an implemented or deployed adapter. No existing V3/UP adapter can execute this route. The candidate interface is deliberately outside `abi/manifest.json`, because it has no deployed source, bytecode or runtime hash.

The four-pool AAPL/USDe/PONS/CASHCAT proposal is separate. LINCOLN and SPCX still need approved token capacities, token review, privacy-pool deployments and profiles. Their precision and caps remain `null` in this candidate instead of inheriting the unrelated AAPL/meme values.

## Exact route identity

| Parameter | Candidate value |
| --- | --- |
| Chain | Robinhood mainnet, 4663 |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| currency0 | LINCOLN `0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE` |
| currency1 | SPCX `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` |
| fee | 2000 pips, 0.2% LP fee |
| tickSpacing | 60 |
| hooks | `0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC` |
| PoolId | `0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55` |

`PoolId = keccak256(abi.encode(currency0, currency1, uint24(fee), int24(tickSpacing), hooks))`. This uses five 32-byte ABI words, not V3 packed path encoding or SHA3-256. The planner recomputes the stated id. A PoolId is not a V3 pool contract address.

LINCOLN → SPCX sets `zeroForOne: true`; SPCX → LINCOLN sets it false. Both use negative `amountSpecified` for exact input. This first candidate accepts neither native currency nor arbitrary hook data, dynamic pool keys, user-supplied router calldata, partial fills or multi-hop V4 paths.

## Execution choice

The preferred candidate is a new immutable single-pool `Phase2FeeV4SinglePoolAdapter`, deployed once per privacy-pool direction. It binds the source pool, target pool, PoolManager, complete PoolKey, computed PoolId, hook, 30 bps output fee and Safe treasury. It has no owner, setters, delegatecall, arbitrary target, sweep, curve launch or mutable route.

A smaller integration can wrap the existing typed `HedgeFunV2TradeRouter.buy/sell` methods. The inspected source has strong settlement checks, uses a request hash for its V4 callback, and rejects partial fills by default. That option would nevertheless require independently pinned router/factory/strategy/treasury/curve identities, a fixed strategy id, `expectedStage = GRADUATED`, an empty V3 hop array, `allowPartialFill = false`, and repeated verification that `treasury.poolKey()` equals this exact key. Its dynamic factory lookups and stage branches expand the behavior this one-pair Lincoln adapter must trust. No canonical deployed router address or runtime match is asserted by these files, so the wrapper remains an alternative, not an enabled route.

The dedicated adapter removes those stage/path dependencies but introduces a new unlock callback. Its implementation and tests must reproduce the settlement protections described below before it can be approved. The local router is a reference for those protections, not an audited implementation of the new adapter.

## Atomic route flow

1. Validate the immutable source/target assets against the key, chain 4663, exact-input bounds, deadline, recipient template and proof-bound action. Reject `amountIn > int128.max`, since the V4 caller deltas are signed int128 even though the frozen privacy pool uses uint128.
2. Reuse the frozen source pool proof and its 256-byte action-envelope output. Source `ExtData` binds processor and recipient to the adapter, `publicIn = 0`, `publicOut = amountIn`, `fee = 0`. Preserve the frozen tuple order: recipient, feeRecipient, processor, publicIn, publicOut, fee. The action binds the external relay processor, target precommitment/template, minimum **net** output, absolute maximum Lincoln service fee, expiry, price limit and maximum hook tax rate.
3. Snapshot adapter LINCOLN/SPCX balances, target pool balance, Safe output-token balance and relevant allowances. Withdraw the proved `amountIn` from the source pool and require the exact input balance increase. No user note secret goes to the adapter or relay.
4. Bind a single pending unlock context to the action and immutable route. Call the pinned manager's `unlock(data)`. No caller controls an external function selector or arbitrary target.
5. In `unlockCallback`, require `msg.sender == POOL_MANAGER`, an active one-shot context and the exact context hash. Disarm it before external token transfers. Use the immutable key, exact-input negative amount, proof-bound sqrt-price limit and empty hookData.
6. Read the correct hook effective rate for this trade and reject a rate above `action.maxHookTaxBps`. Validate manager, hook version/runtime and registered key/vault semantics before relying on those rate methods. The callback's actual `swap` must use the same sender that was quoted; it cannot impersonate the hook-exempt treasury.
7. Decode the manager delta: input must be negative and output positive. Safely widen signed values before negation. Require `spent == amountIn`; a partial fill, including dust, reverts the whole transaction. Settle using `sync(inputCurrency) → exact ERC20 transfer to manager → settle() == spent`, then `take(outputCurrency, adapter, outputAmount)`.
8. Require actual adapter balance changes to equal settled input and received output after all hook effects. Do not infer spend/output from the requested amount or a router return value alone. V4 must end with every adapter currency delta settled; manager-held pool reserves are not expected to return to their old balance.
9. Compute Lincoln fee as `floor(measuredOutputAfterHook * 30 / 10000)`. Enforce the proof-bound absolute fee maximum and `netOutput >= minAmountOut`. Send the fee to the Safe, approve exactly net output to the target privacy pool, call `depositDynamic(net, precommitment, encryptedTemplate)`, then clear allowance.
10. Verify adapter balances are back to the pre-call baseline, target pool balance increased exactly by net output, Safe increased by the output service fee, allowances are zero and no active callback context remains. Target-cap exhaustion, stale ASP membership, hook reverts, tax over-limit, slippage or issuer rejection must revert the entire swap, fee payment and note spend atomically.

The new domain must distinguish V4 actions from the existing V3/UP fee envelope and bind chain id, adapter, both privacy pools, PoolManager, full PoolId/key, hook, direction, fee and treasury. Changing the key or limits changes the source proof's envelope. This mechanism uses the existing circuit; it does not pretend the V4 adapter is already part of the frozen release.

## Hook tax, LP fee and Lincoln fee

The reviewed local source references are recorded with SHA256 in the proposal, with `onchainSourceMatchVerified: false`. Root's independent chain evidence still has to bind that source to the live hook. Local file availability alone proves no on-chain equivalence.

In the V2/v3 hook reference, a graduated vault pool charges stock on both directions:

- SPCX → LINCOLN: `beforeSwap` takes `floor(SPCX_input * hookRate / 10000)` in SPCX. The remaining input reaches the AMM and pays its LP fee. The output is LINCOLN; Lincoln's 30 bps fee is taken from measured LINCOLN output.
- LINCOLN → SPCX: AMM output is SPCX; `afterSwap` takes the applicable stock tax from that output. Lincoln's 30 bps fee is then taken from the SPCX actually received.

The observed/intended flat hook rate is 100 bps, separate from the 2000-pip LP fee and Lincoln's 30 bps. These are not one flat 0.3% exchange cost. At a hypothetical constant one-to-one price and ignoring integer rounding, price impact and gas, 0.2% LP + 1% hook + 0.3% Lincoln service fees compose to approximately 1.4946%, rather than simply 0.3%.

There is no expected initial snipe tax for this graduated pool; verify `snipeBps` and `snipeSeconds` on-chain. **Sell tax can still rise after a treasury `noteEvent`** because `_sellRate` considers spike parameters and elapsed time. The adapter must bind and enforce a maximum hook rate; quotes must query current registered rates/state with the correct sender. Do not permanently display “exactly 1%” without checking the spike configuration.

Hook tax occurs inside the V4 swap. It does not mean ordinary LINCOLN/SPCX ERC20 transfers are taxed. The token exact-balance checks remain mandatory. An issuer blocking SPCX transfers can stop settlement, exits or the hook's later stock sweep.

A live quote must include the correct hook behavior, sender, full key, exact input, price limit, liquidity state and rate. Do not use the V3 quoter. Do not subtract hook or LP fees a second time from an output quote that already includes them. The planner's fee helpers are integer accounting examples only; they are not a price-impact or tick-crossing simulator.

## Candidate interface and intents

- Proposal: `config/v4-lincoln-spcx-mainnet-proposal.json`
- Candidate interface: `config/v4-lincoln-spcx-candidate-abi.json`
- Offline typed intent: `node scripts/operations/v4-lincoln-spcx-plan.mjs --plan`
- Tests: `node --test test/operations/v4-lincoln-spcx-plan.test.mjs`

The V4 planner uses declared `viem` dependency for Ethereum Keccak. Install the repository's pinned dependencies with its usual workflow if needed. Its output has two constructor intents, unresolved source/target privacy-pool references, an unset swap action/proof, no executable destination and signing/execution false. The candidate ABI has null source/runtime metadata and is not added to the verified ABI manifest.

`Action` extends the existing fee adapter shape with `sqrtPriceLimitX96` and `maxHookTaxBps`; its `minAmountOut` is the amount deposited after every venue and Lincoln fee. `Proof` and `ExtData` preserve the frozen pool's tuple shapes. The new adapter source must validate the proposed ABI and proof-domain design rather than assuming an interface file is sufficient implementation.

## Acceptance and gas gates

No gas amount or budget is approved or guessed here. Build a fork deployment first, then measure complete source proof → swap/hook → fee → target insertion for both directions, cold and warm balances, different active liquidity/tick crossings, fee-rounding boundaries and the worst supported limits. A quote-only `eth_call` to the existing trade router does not estimate the future privacy adapter's proof, two pool operations or settlement overhead. Pin an approved maximum gas after those measurements; preserve cumulative signer accounting and relay reserves.

Required implementation tests before any live route:

- Full PoolKey hash, sorted currencies, hook flag mask, manager and hook code pins; reject a substituted hook, dynamic fee, native currency or pool id.
- Source/target privacy-pool asset, chain, registry, verifier and scope binding; independently approved caps and token behavior.
- Both buy/sell paths with real registered hook/vault/rates, source proof, output fee and target note recovery/spending; quote against the actual adapter sender.
- Correct 1% flat stock-tax accounting on each side, fee rounding, zero-tax dust, sell spikes, changed effective rates, treasury-exemption mismatch and above-limit tax rejection.
- Full-fill requirement under restrictive price limits, empty/inadequate liquidity and tick crossing. A partial sell must revert without an external token refund; never prorate `minAmountOut`.
- Forged/replayed/unexpected manager callbacks, nested unlock, duplicate callback payments, hook/token reentrancy and mismatched callback payloads.
- Signed int128 boundary handling, incorrect debt signs, false `settle()` return, incomplete currency settlement, unexpected balance deltas and leftover allowances.
- Source proof/envelope/action substitution, recipient/template tampering, wrong processor, expired deadline, service fee above absolute maximum and target cap exhaustion.
- Complete transaction rollback on failed hook, frozen/blacklisted SPCX or token implementation changes; no successful withdrawal paired with a failed target deposit.
- Donated adapter/manager balances cannot be mistaken for swap proceeds or swept; Safe receives only this operation's measured output fee.
- Typed-router alternative, if chosen: frozen strategy id/stage/treasury/key, no V3 path, no curve branch, no native wrapper, no partial-fill refund, unchanged router balances and revoked approvals.

Only after the new adapter implementation, token reviews, privacy pools, gas approval and mainnet deployment records pass should backend route normalization accept this distinct V4 adapter type. Then extend indexer/ASP rosters, fee quotes, protected relay origins and frontend quote/prove support. Existing V3/UP routes and the four-pool proposal remain unchanged throughout.
