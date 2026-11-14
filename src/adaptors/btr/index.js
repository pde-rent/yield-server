const sdk = require('@defillama/sdk');
const utils = require('../utils');

const PROJECT = 'btr';
const CHAIN = 'monad';
const DISPLAY_CHAIN = 'Monad';
// Pools are read from the PoolFactory contracts, so a new pool needs no change here. The first
// generation stays listed while its LPs keep liquidity there.
const FACTORIES = [
  '0xbbbbbbb16b9B5Fa94AD8CD35e696bEA55DB9C8B0', // current generation
  '0xbbbbbbbbbd5e955E20F323cA1F95f8191fD0E0BF', // first generation
];
const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_PER_YEAR = 365;

// BTR: oracle-priced multi-asset AMM. Each pool leg has its own ERC-20 receipt (`Pool.lpToken(token)`).
// A leg's TVL is its economic reserves `Pool.getBuffer(token).reserves`, which include the part its
// yield hook has invested externally (that liquidity still belongs to the leg's LPs). LP fees accrue
// on the output side of every fill: `Swapped` packs `protoFee | lpFee << 128` in tokenOut units, and
// the route fee of a liability conversion (`LiabilitySwapped.fees`) is packed the same way. Coverage
// tolls stay in the pool as a buffer and are not paid out as fees, so they are not counted.
const LIABILITY_SWAPPED =
  'event LiabilitySwapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 lpAmountIn, uint256 lpAmountOut, uint256 haircut, uint256 fees, uint256 tolls)';
const SWAPPED =
  'event Swapped(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amounts, uint256 fees, uint256 prices, uint256 outBook, uint256 outState)';

const abi = {
  getOfficialPoolsCount:
    'function getOfficialPoolsCount() view returns (uint256)',
  officialPools: 'function officialPools(uint256) view returns (address)',
  getPoolTokens: 'function getPoolTokens(address pool) view returns (address[])',
  getBuffer:
    'function getBuffer(address token) view returns (uint256 reserves, uint256 invested, uint256 minLiquidity)',
  lpToken: 'function lpToken(address token) view returns (address)',
};

const U128 = (1n << 128n) - 1n;

const toBigInt = (value) => BigInt(value.toString());

const normalizeTimestamp = (timestamp) =>
  timestamp === null || timestamp === undefined
    ? Math.floor(Date.now() / 1000)
    : Number(timestamp);

const getBlocks = async (timestamp) => {
  const [weekStartBlock, dayStartBlock, endBlock] =
    await utils.getBlocksByTime(
      [
        timestamp - 7 * SECONDS_PER_DAY,
        timestamp - SECONDS_PER_DAY,
        timestamp,
      ],
      CHAIN
    );
  return { weekStartBlock, dayStartBlock, endBlock };
};

const getLegs = async () => {
  const legs = [];
  for (const factory of FACTORIES) {
    const { output: count } = await sdk.api.abi.call({
      target: factory,
      abi: abi.getOfficialPoolsCount,
      chain: CHAIN,
    });
    if (!Number(count)) continue;
    const { output: pools } = await sdk.api.abi.multiCall({
      target: factory,
      abi: abi.officialPools,
      calls: Array.from({ length: Number(count) }, (_, i) => ({ params: [i] })),
      chain: CHAIN,
    });
    const poolAddresses = pools.map((p) => p.output);
    const { output: tokenLists } = await sdk.api.abi.multiCall({
      target: factory,
      abi: abi.getPoolTokens,
      calls: poolAddresses.map((pool) => ({ params: [pool] })),
      chain: CHAIN,
    });
    tokenLists.forEach((list, i) => {
      list.output.forEach((token) =>
        legs.push({ pool: poolAddresses[i], token })
      );
    });
  }

  const { output: buffers } = await sdk.api.abi.multiCall({
    abi: abi.getBuffer,
    calls: legs.map(({ pool, token }) => ({ target: pool, params: [token] })),
    chain: CHAIN,
  });
  const { output: lpTokens } = await sdk.api.abi.multiCall({
    abi: abi.lpToken,
    calls: legs.map(({ pool, token }) => ({ target: pool, params: [token] })),
    chain: CHAIN,
  });
  legs.forEach((leg, i) => {
    const buf = buffers[i].output;
    leg.reserves = toBigInt(buf.reserves ?? buf[0]);
    leg.lpToken = lpTokens[i].output;
  });
  return legs;
};

const getFeeRevenue = async (legs, fromBlock, toBlock) => {
  const pools = [...new Set(legs.map((leg) => leg.pool))];
  if (!pools.length || fromBlock >= toBlock) return new Map();
  const [logs, conversions] = await Promise.all(
    [SWAPPED, LIABILITY_SWAPPED].map((eventAbi) =>
      sdk.getEventLogs({ targets: pools, eventAbi, fromBlock, toBlock, chain: CHAIN })
    )
  );
  // Key by emitting pool + output token: two official pools can share a base asset, and
  // keying by token alone would attribute both pools' fees to every leg and overstate APY.
  //
  // Every fill counts, including the protocol's own coop-arbitrage fills: a coop fill books no
  // protocol fee but pays a non-zero LP fee, so it is real LP revenue.
  const accrued = new Map(); // `${pool}:${tokenOut}` (lowercase) -> BigInt lpFee in token units
  for (const log of [...logs, ...conversions]) {
    const args = log.args ?? log;
    const pool = String(log.address).toLowerCase();
    const tokenOut = String(args.tokenOut).toLowerCase();
    const lpFee = toBigInt(args.fees) >> 128n;
    const key = `${pool}:${tokenOut}`;
    accrued.set(key, (accrued.get(key) ?? 0n) + lpFee);
  }
  return accrued;
};

const apy = async (timestampArg = null) => {
  const timestamp = normalizeTimestamp(timestampArg);
  const [legs, blocks] = await Promise.all([getLegs(), getBlocks(timestamp)]);
  if (!legs.length) return [];

  const tokens = [...new Set(legs.map((leg) => leg.token))];
  const { pricesByAddress } = await utils.getPrices(tokens, CHAIN);
  const { output: meta } = await sdk.api.abi.multiCall({
    abi: 'erc20:symbol',
    calls: tokens.map((token) => ({ target: token })),
    chain: CHAIN,
  });
  const { output: supplies } = await sdk.api.abi.multiCall({
    abi: 'erc20:totalSupply',
    calls: legs.map((leg) => ({ target: leg.lpToken })),
    chain: CHAIN,
  });
  const { output: decimals } = await sdk.api.abi.multiCall({
    abi: 'erc20:decimals',
    calls: tokens.map((token) => ({ target: token })),
    chain: CHAIN,
  });
  const symbolByToken = {};
  tokens.forEach((token, i) => {
    symbolByToken[token.toLowerCase()] = meta[i].output;
  });
  const decimalsByToken = {};
  tokens.forEach((token, i) => {
    decimalsByToken[token.toLowerCase()] = Number(decimals[i].output);
  });

  const [dayFees, weekFees] = await Promise.all([
    getFeeRevenue(legs, blocks.dayStartBlock, blocks.endBlock),
    getFeeRevenue(legs, blocks.weekStartBlock, blocks.endBlock),
  ]);

  const pools = [];
  legs.forEach((leg, i) => {
    const token = leg.token.toLowerCase();
    const price = pricesByAddress[token];
    if (!Number.isFinite(price)) return; // skip unpriced legs rather than emit a wrong TVL
    const decimalsForLeg = decimalsByToken[token];
    const scale = 10 ** decimalsForLeg;
    const reserveAmount = Number(leg.reserves) / scale;
    const tvlUsd = reserveAmount * price;
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return;
    const feeKey = `${leg.pool.toLowerCase()}:${token}`;
    const dayFeeUsd =
      (Number(dayFees.get(feeKey) ?? 0n) / scale) * price;
    const weekFeeUsd =
      (Number(weekFees.get(feeKey) ?? 0n) / scale) * price;

    pools.push({
      pool: `${leg.lpToken.toLowerCase()}-${CHAIN}`,
      chain: DISPLAY_CHAIN,
      project: PROJECT,
      symbol: symbolByToken[token],
      tvlUsd,
      apyBase: (dayFeeUsd / tvlUsd) * DAYS_PER_YEAR * 100,
      apyBase7d: (weekFeeUsd / tvlUsd) * (DAYS_PER_YEAR / 7) * 100,
      underlyingTokens: [leg.token],
      token: leg.lpToken,
      url: 'https://btr.markets',
    });
  });

  return pools.filter((pool) => utils.keepFinite(pool));
};

module.exports = {
  timetravel: false,
  protocolId: '9073', // DefiLlama protocol id for slug `btr`
  apy,
  url: 'https://btr.markets',
};
