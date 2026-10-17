# Local mainnet deployment

The encrypted account is managed by Foundry on the operator's computer. The public target is `config/mainnet-operations.json`; no password or private key is included. Registration does not prove ownership of a keystore. Its account is checked against the recovered transaction sender when signing.

The review baseline remains `v0.1.0-rc.2`. Its configuration inside `releases/rc2/` deliberately retains an unset deployer. A new operations snapshot changes only the public deployer identity; its manifest records the original commit, frozen inventory and before/after configuration hashes. It is explicitly a derived operations snapshot, not a byte-identical frozen release.

## Check and prepare

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run plan
bash scripts/deploy.sh --prepare
```

Preparation reads no wallet, sends no transaction and leaves the review capsule unchanged. It creates `.phase1-private/mainnet-deployments/rc2-eth-usdg/` from the exact RC.2 commit. Existing directories and deployment journals are preserved. Incomplete or modified snapshots fail validation; do not remove a directory that may contain an unresolved transaction.

## Execute locally

The first deployment covers **seven CREATE transactions: two Poseidon libraries, two final verifiers, one association registry and the ETH/USDG pools**. It does not deploy stock pools or DEX routes and does not activate a frontend, relayer or ASP publisher.

All three limits are explicit. An example invocation is:

```sh
bash scripts/deploy.sh --deploy \
  --budget-wei 1100000000000000 \
  --max-fee-per-gas-wei 40000000 \
  --reserve-wei 3000000000000000
```

Running `--deploy` is the operator's instruction to sign and broadcast on Robinhood **mainnet, chain ID 4663** within those limits. The example sets a cumulative gas budget of **0.0011 ETH**, maximum gas price of **0.04 gwei**, and retains **0.003 ETH**. These are example limits to review, not a claim of current gas cost or a default permission for an agent to spend funds. The seven conservative gas caps total 26,500,000; at that price ceiling their maximum reservation is 0.00106 ETH. Insufficient balance or budget, incorrect chain/dependencies, altered source, or a changed keystore sender fails closed.

The command installs the snapshot's locked dependencies with lifecycle scripts disabled, validates all original public files except the explicitly derived config, and prompts for the keystore password in the operator's interactive terminal. It uses a temporary owner-only password file, deletes it on normal exit or handled signals, and never exports a private key. A machine crash or `SIGKILL` can leave that temporary file; it must be removed locally. No password belongs in chat, command arguments or Git.

The account-wide signer ledger and canonical receipt checks support resuming an interrupted deployment with the same limits. An unknown broadcast is not blindly resent. Changing limits or resolving an ambiguous transaction requires reviewing the existing journal.

## Remaining launch work

A completed core deployment is not the completed product launch. Fee-adapter deployment and route activation, stock raw-cap valuation, real two-way DEX acceptance, mainnet signer/ASP/relayer operations, and independent A/B acceptance remain separate steps. The current registration file keeps its persistent signing flag off; the local `--deploy` command provides explicit limits for that one operator-run process. Existing testnet services and EC2 are unchanged.
