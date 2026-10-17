# Official relayer fee policy v2

The launch policy is **30 bps (0.30%)** for withdrawals, relayed holder exits,
and DEX swaps. Deposit, private-transfer, and ragequit service fees are zero.
For the launch private-transfer and ragequit services, the relayer also absorbs
gas: no gas charge is deducted from the note. A public wallet deposit can still
require its sender to pay the chain's transaction gas.

This module is a pure SDK/validation component. Adding it to the core repository
does not change the running testnet relayer, enable signing, deploy adapters, or
install a live fee configuration.

## Public per-pool configuration

```json
{
  "schema": "lincoln-service-fees/v2",
  "id": "mainnet-launch-30bps-v2",
  "feeAsset": "current-pool-asset",
  "gasFeeUnits": "20000000000000",
  "withdrawal": {"bps": 30, "includesGas": true},
  "holderExit": {"bps": 30, "includesGas": true},
  "ragequit": {"bps": 0, "includesGas": false},
  "privateTransfer": {"fixedUnits": "0", "includesGas": false},
  "deposit": {"bps": 0, "includesGas": false},
  "swap": {
    "bps": 30,
    "treasury": "0x9cf17a6e3c75d200f58283a165c442a8a3994555",
    "immutable": true,
    "includesGas": false
  }
}
```

The gas value above is an **ETH-pool** preset: 0.00002 ETH, expressed in wei.
`createLaunchServiceFeePolicy({asset:'ETH'})` selects it and rejects an ETH fixed
quote above 0.0002 ETH (`200000000000000` wei). The helper requires an explicit
asset name; USDG and stock pools require an explicit quote in that asset's raw
units. It does not guess token prices, decimals, or conversion rates. A generic
v2 policy contains asset units, not the asset's market price; the later backend
configuration loader must verify the per-pool asset and enforce the equivalent
budget cap using an approved pricing/configuration process.

`includesGas` means **add the prequoted fixed gas units** for that operation; it
does not mean a real-time RPC estimate is silently added later. Quotes are fixed
before proving. A later gas spike remains the operator's cost unless the user
explicitly obtains and proves a new quote. New policies must never reprice
already proved, signed, submitted, or recovering jobs.

The v2 normalizer allows separate configurable withdrawal and holder-exit rates,
and fixed private-transfer charges for possible later policies. The launch helper
sets the exact free-transfer settings above. Deposit and ragequit are required
to remain zero-fee with `includesGas:false`; the ragequit contract's existing
zero-fee restriction is unchanged. Swap gas is not added by this fee policy.

## Integer formulas

All arithmetic uses nonnegative integer token units, never floating-point token
amounts. A rate is integer basis points, bounded by the SDK's 100 bps maximum.

```text
percentageFee = floor(gross * bps / 10000)
gasFee        = includesGas ? gasFeeUnits : 0
totalFee      = percentageFee + fixedUnits + gasFee
net           = gross - totalFee
```

For normal withdrawal, `gross` is the note debit in `extData.publicOut`, which
**already includes** `extData.fee`. The contract pays the recipient
`publicOut - fee`, and pays the fee recipient `fee`. Do not add the fee to
`publicOut` a second time. For holder exit, `gross` is the revealed note value;
the same percentage-plus-fixed-gas formula applies.

For example, a gross 0.1 ETH withdrawal uses
`floor(100000000000000000 * 30 / 10000) + 20000000000000`, or
`320000000000000` wei total, leaving 0.09968 ETH. Fees must be strictly less than
gross output and all accepted amounts must fit uint128.

For a DEX swap, `gross` is the adapter's **actual measured output**, the fee is
`floor(grossOutput * swap.bps / 10000)`, and the net output is deposited into the
target privacy pool. A measured output of 10000 raw units gives fee 30 and net
9970. `minAmountOut` is the net minimum. The proof-bound `maxServiceFee` protects
the absolute output-asset fee cap. ETH-output fees are sent to the Safe as WETH;
the net is unwrapped for the ETH privacy pool.

The swap quote returned by this pure module only evaluates supplied output
units; it does not obtain a quote from a DEX or predict a fill. Its fee asset is
`swap-output-asset`, unlike withdrawal fees in the current pool's asset.

Private-transfer pricing never requires the hidden payment amount. The launch
policy's fixed charge and gas charge are both zero. Deposits and ragequit also
produce zero service-fee quotes.

## Compatibility and validation

`normalizeServiceFeePolicy` accepts both schemas. Omitting the schema retains
**v1 historical semantics**, including its 20 bps default, gas-only holder-exit
charge, and fixed-plus-gas private-transfer quote. Explicit v1 policies are not
silently upgraded to 30 bps. The fee-route SDK and new mainnet fee-plan helpers
default to 30 bps; existing adapters keep the rate with which they were deployed.

`validateCommercialFee` checks a new withdrawal/exit/transfer job's proof-bound
fee for exact equality with the quote, rejecting underpayment and accidental
overpayment. For v2 swaps it checks the immutable route rate against
`policy.swap.bps` and the route treasury against `policy.swap.treasury`.
Changing `policy.withdrawal.bps` does not change the swap policy or break a
correct 30 bps adapter.

These are the official service's commercial rules, not a mandatory core-pool
tax. The core contracts retain their proof-authenticated fee semantics and the
zero-fee ragequit restriction. The service's later fee-recipient routing and
treasury accounting must be configured explicitly.

## Remaining backend migration

1. Serve the selected per-pool v2 policy in `/v3/config`, while retaining v1
   support for the existing testnet profiles and historical jobs.
2. Configure and disclose each pool's fixed gas quote. Verify asset identity,
   decimals, quote budget, fee recipient, and the Safe route treasury; do not
   apply the ETH wei preset to ERC20 pools.
3. Make frontend/CLI quotes use these integer formulas and carry the selected
   policy ID. Bind the exact fee before proving; reject a changed new-job quote
   without mutating or repricing an existing job.
4. Activate and runtime-verify separately deployed 30 bps fee adapters. Rates
   and treasuries are immutable constructor values; a withdrawal-policy change
   must not imply changing them.
5. Run the live service's exact-fee validation, free private-transfer/ragequit
   gas-subsidy checks, fee accounting, and recovery tests before enabling it.

The isolated final-fee acceptance exercises the v2 quote in both DEX routes:
gross swap output 10000, swap fee 30, recovered private note 9970; B then proves
a withdrawal of gross 9970 with percentage fee 29 and an explicitly **synthetic**
fixed gas quote of 3 raw asset units, paying B 9938 and the independent fee
recipient 32. The accounting assertion checks that the target pool decreases by
gross 9970 once, with no private reserve remaining. The fixture quote of 3 is
not the production ETH preset and does not configure a live relayer.

No RPC URLs, AWS services, cloud signers, testnet configuration, or production
service deployment are changed by this SDK component.
