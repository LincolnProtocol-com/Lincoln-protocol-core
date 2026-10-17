// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile(new URL('../../config/stock-caps-mainnet-20261017.json', import.meta.url)));
const approved = [
  ['NVDA', '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', '219.069682341137637246', '11400000000000000000', '114000000000000000000'],
  ['SPY', '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', '763.098748506704297165', '3200000000000000000', '32000000000000000000'],
  ['META', '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', '715.877409129148850326', '3400000000000000000', '34000000000000000000'],
  ['TSLA', '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', '352.530000000000000000', '7000000000000000000', '70000000000000000000'],
  ['GOOGL', '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', '339.725868366497481300', '7300000000000000000', '73000000000000000000'],
  ['QQQ', '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', '710.997912177018554463', '3500000000000000000', '35000000000000000000'],
  ['MSTR', '0xec262a75e413fAfD0dF80480274532C79D42da09', '136.600000000000000000', '18300000000000000000', '183000000000000000000'],
];

// Independent rational arithmetic: neither a decimal price nor a raw cap is a JS Number.
function decimal(value) {
  assert.match(value, /^\d+(?:\.\d+)?$/);
  const [whole, fraction = ''] = value.split('.');
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function tokenRaw(value) {
  const ratio = decimal(value);
  assert.equal((ratio.numerator * 10n ** 18n) % ratio.denominator, 0n);
  return ratio.numerator * 10n ** 18n / ratio.denominator;
}

function assertFlooredCap(raw, price, budgetUsd, incrementTokens) {
  assert.match(raw, /^(?:0|[1-9]\d*)$/);
  const cap = BigInt(raw), quote = decimal(price), increment = tokenRaw(incrementTokens);
  const budget = BigInt(budgetUsd) * 10n ** 18n * quote.denominator;
  const expected = budget / quote.numerator / increment * increment;
  assert.equal(cap, expected, 'cap is the maximum affordable integral increment');
  assert.equal(cap % increment, 0n);
  assert.ok(cap * quote.numerator <= budget, 'rounding cannot exceed the USD reference');
  assert.ok((cap + increment) * quote.numerator > budget, 'one additional increment exceeds the USD reference');
  assert.ok(cap > 0n && cap <= (1n << 128n) - 1n, 'constructor uint128 range');
}

test('stock policy preserves the user-approved seven assets and fixed USD rounding rules', () => {
  assert.equal(config.schema, 'lincoln-stock-caps-mainnet/v1');
  assert.equal(config.chainId, 4663);
  assert.equal(config.releaseCandidate, 'v0.1.0-rc.3');
  assert.equal(config.decidedBy, 'user');
  assert.deepEqual(config.assets.map(asset => asset.symbol), approved.map(asset => asset[0]));
  assert.equal(new Set(config.assets.map(asset => asset.token.toLowerCase())).size, 7);
  assert.equal(config.policy.decimals, 18);
  assert.equal(config.policy.priceField, 'tokenAsk');
  assert.equal(config.policy.priceUpdatesChangeCaps, false);
  assert.equal(config.policy.rounding, 'floor');
  assert.equal(config.policy.maxDepositUsd, '2500');
  assert.equal(config.policy.maxTotalUsd, '25000');
  assert.equal(config.policy.maxDepositIncrementTokens, '0.1');
  assert.equal(config.policy.maxTotalIncrementTokens, '1');
});

for (const [symbol, token, ask, deposit, total] of approved) {
  test(`${symbol}: exact frozen price and 18-decimal caps satisfy both floor boundaries`, () => {
    const asset = config.assets.find(item => item.symbol === symbol);
    assert.equal(asset.token, token);
    assert.equal(asset.tokenAsk, ask);
    assert.equal(asset.decimals, 18);
    assert.equal(asset.maxDepositRaw, deposit);
    assert.equal(asset.maxTotalRaw, total);
    assert.equal(tokenRaw(asset.maxDepositTokens), BigInt(deposit));
    assert.equal(tokenRaw(asset.maxTotalTokens), BigInt(total));
    assertFlooredCap(deposit, ask, config.policy.maxDepositUsd, config.policy.maxDepositIncrementTokens);
    assertFlooredCap(total, ask, config.policy.maxTotalUsd, config.policy.maxTotalIncrementTokens);
    assert.ok(BigInt(deposit) <= BigInt(total));
    assert.match(asset.quotedAt, /^2026-10-17T03:3[34]:\d{2}\.\d+Z$/);
  });
}

test('recorded official metadata and fixed-block ERC20 observations match the approved assets', () => {
  assert.equal(config.sources.tokenContracts, 'https://docs.robinhood.com/chain/contracts/');
  assert.equal(config.sources.assetRegistry, 'https://api.robinhood.com/rhj/assets');
  assert.equal(config.verification.chainId, 4663);
  assert.equal(config.verification.blockNumber, '90639127');
  assert.equal(config.verification.blockHash, '0x937e05e9b1d1b5ad2d296ec1958f555e945ab4f8fef8da1007128f8f0c3bc28f');
  assert.match(config.verification.assetRegistryResponseSha256, /^[a-f0-9]{64}$/);
  for (const asset of config.assets) {
    const observation = asset.verification;
    assert.equal(observation.canonicalAddressMatches, true);
    assert.equal(observation.registryStatus, 'ASSET_STATUS_ACTIVE');
    assert.equal(observation.registryDecimals, 18);
    assert.equal(observation.isTradingHalt, false);
    assert.equal(observation.observedTokenAsk, asset.tokenAsk);
    assert.equal(observation.frozenTokenAskMatchesObserved, true);
    assert.match(observation.priceResponseSha256, /^[a-f0-9]{64}$/);
    assert.equal(observation.onchain.codePresent, true);
    assert.ok(observation.onchain.runtimeCodeBytes > 0);
    assert.match(observation.onchain.runtimeCodeHash, /^0x[a-f0-9]{64}$/);
    assert.equal(observation.onchain.decimals, 18);
    assert.equal(observation.onchain.symbol, asset.symbol);
    assert.equal(observation.onchain.name, observation.registryName);
    assert.equal(observation.onchain.paused, false);
    assert.equal(tokenRaw(observation.currentMultiplier), BigInt(observation.onchain.uiMultiplier));
  }
});

test('cap approval does not enable stock pools or claim DEX, fork, or historical timestamp verification', () => {
  assert.equal(config.stockPoolsEnabled, false);
  assert.equal(config.selection.dexVolumeMeasured, false);
  assert.equal(config.selection.dexLiquidityMeasured, false);
  assert.match(config.selection.mintBurnUsdVolumeMeaning, /not DEX swap volume/);
  assert.equal(config.provenance.historicalQuoteTimestampIndependentlyAuthenticated, false);
  assert.equal(config.verification.issuerImplementationHashVerified, false);
  assert.equal(config.verification.mainnetForkAcceptance, 'not-run');
  assert.equal(config.verification.usdGTwoWayDexAcceptance, 'not-run');
  assert.equal(config.verification.transactionsBroadcast, 0);
  assert.ok(config.deploymentGates.length >= 3);
});
