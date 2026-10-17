// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

// Independent UNTESTED/UNDEPLOYED candidate. Build status is in its companion
// candidate-build record. Not part of the frozen RC.3 release.
import {ReentrancyGuard} from '../vendor/openzeppelin/utils/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '../vendor/openzeppelin/token/ERC20/utils/SafeERC20.sol';

interface ILincolnV4CandidateSource {
    struct ExtData {
        address recipient;
        address feeRecipient;
        address processor;
        uint128 publicIn;
        uint128 publicOut;
        uint128 fee;
    }
    function ASSET() external view returns (address);
    function ASP_REGISTRY() external view returns (address);
    function VERIFIER() external view returns (address);
    function HOLDER_EXIT_VERIFIER() external view returns (address);
    function SCOPE() external view returns (uint256);
    function transact(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata,
        uint256[9] calldata, ExtData calldata, bytes[2] calldata) external payable;
}

interface ILincolnV4CandidateTarget is ILincolnV4CandidateSource {
    function depositDynamic(uint128, uint256, bytes calldata) external payable returns (uint256);
}

interface IHedgeFunV4CandidateFactory {
    function strategies(uint256) external view returns (address, address, address, address, address);
    function curves(uint256) external view returns (address);
}

interface IHedgeFunV4CandidateTreasury {
    function poolKey() external view returns (address, address, uint24, int24, address);
    function implementation() external view returns (address);
    function treasuryUpgradeController() external view returns (address);
}

interface IHedgeFunV4CandidateCurve {
    function status() external view returns (uint8);
}

interface IHedgeFunV4CandidateBeacon {
    function implementation() external view returns (address);
}

interface IHedgeFunV4CandidateHook {
    struct Rates {
        uint16 taxBps;
        uint16 spikeBps;
        uint32 spikeSeconds;
        uint16 protocolBps;
        uint16 creatorBps;
        uint16 sweepTipBps;
        uint16 snipeBps;
        uint8 snipeSeconds;
    }
    function version() external view returns (uint256);
    function factory() external view returns (address);
    function poolManager() external view returns (address);
    function isRegistered(bytes32) external view returns (bool);
    function poolConfig(bytes32) external view returns (address, address, address, bool);
    function liquidityVaultOf(bytes32) external view returns (address);
    function rates(bytes32) external view returns (Rates memory);
    function sellRateBps(bytes32) external view returns (uint256);
    function buyRateBps(bytes32) external view returns (uint256);
}

interface IHedgeFunV4CandidateRouter {
    struct Hop { address pool; address tokenOut; }
    struct TradeParams {
        uint256 id;
        address asset;
        uint256 amountIn;
        uint256 minStockReceived;
        uint256 minFinalOut;
        uint256 deadline;
        uint8 expectedStage;
        bool allowPartialFill;
    }
    function factory() external view returns (address);
    function poolManager() external view returns (address);
    function buy(TradeParams calldata, Hop[] calldata) external returns (uint256, uint256);
    function sell(TradeParams calldata, Hop[] calldata) external returns (uint256, uint256);
}

/// @notice Fixed LINCOLN/SPCX V4 route using the already deployed typed router.
/// @dev No new manager callback, arbitrary calldata, native assets, hops, owner,
/// mutable route, partial fill or sweep. Deploy once per privacy-pool direction.
/// Router/source evidence: chain 4663, block 90855909. This is a review candidate,
/// not deployment authorization or an assertion of test/audit success.
contract Phase2FeeHedgeFunV4Adapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Action {
        address processor;
        uint128 amountIn;
        uint128 minAmountOut; // Minimum NET target deposit after hook, LP and output service fee.
        uint256 deadline;
        uint256 targetPrecommitment;
        bytes encryptedTemplate;
        uint128 maxServiceFee;
        uint160 sqrtPriceLimitX96; // Must equal fixedSqrtPriceLimitX96(); router offers no custom limit.
        uint16 maxHookTaxBps;
    }
    struct Proof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[9] pubSignals;
    }
    struct Balances {
        uint256 nativeBalance;
        uint256 input;
        uint256 output;
        uint256 routerNative;
        uint256 routerInput;
        uint256 routerOutput;
        uint256 target;
        uint256 treasury;
    }

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant CIPHERTEXT_BYTES = 256;
    uint256 public constant STRATEGY_ID = 2;
    uint16 public constant FEE_BPS = 30;
    uint16 public constant HOOK_TAX_BPS = 100;
    uint24 public constant LP_FEE_PIPS = 2000;
    int24 public constant TICK_SPACING = 60;
    uint8 public constant GRADUATED = 2;
    bytes32 public constant SWAP_DOMAIN = keccak256('LINCOLN_HEDGEFUN_FIXED_V4_FEE_V1');
    bytes32 public constant POOL_ID = 0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55;
    address public constant LINCOLN = 0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE;
    address public constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address public constant ROUTER = 0x5f3e9D177231527D56fB62aCc398f22cc8F2c328;
    address public constant FACTORY = 0xC78b6A83d75C5612a1A7323702B56038254a6459;
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant HOOK = 0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC;
    address public constant STRATEGY_TREASURY = 0x72aBbC490A18B5c0c61A9BeA4Ed091a74Eef991F;
    address public constant STRATEGY_IMPLEMENTATION = 0xfF608632AF7621AA0c84607385056bBA9B547616;
    address public constant STRATEGY_UPGRADE_CONTROLLER = 0xEdAb12AB7B673648d2D2c79d37565032E1a23Bbf;
    address public constant CURVE = 0x2C27b7Fb50D85567760487010A827039711D2A66;
    address public constant LIQUIDITY_VAULT = 0xA6dF493aC0FCF58aa1acFB60FA2aB96a01c17E30;
    address public constant CREATOR = 0xD7d7284FF95BAaD76167D331E803847DF0470577;
    address public constant TREASURY = 0x9CF17a6E3c75D200f58283A165C442a8A3994555;
    address public constant SPCX_BEACON = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address public constant SPCX_IMPLEMENTATION = 0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2;

    ILincolnV4CandidateSource public immutable SOURCE_POOL;
    ILincolnV4CandidateTarget public immutable TARGET_POOL;
    IERC20 public immutable TOKEN_IN;
    IERC20 public immutable TOKEN_OUT;
    bool public immutable IS_BUY; // SPCX -> LINCOLN, as defined by HedgeFun's router.
    bytes32 public immutable SOURCE_POOL_CODE_HASH;
    bytes32 public immutable TARGET_POOL_CODE_HASH;

    error UnsupportedChain();
    error InvalidPools();
    error VenueChanged();
    error UnsupportedPriceLimit();
    error HookTaxAboveLimit();
    error InvalidAction();
    error InvalidSourceAuthorization();
    error ActionMismatch();
    error UnexpectedBalanceDelta();
    error NonzeroAllowance();
    error PartialFill();
    error ServiceFeeAboveLimit();

    event ServiceFeePaid(address indexed treasury, address indexed token, uint256 grossAmountOut,
        uint256 serviceFee, uint256 netAmountOut);
    event SwapReshielded(address indexed processor, address indexed sourcePool, address indexed targetPool,
        uint256 inputNullifier0, uint256 inputNullifier1, uint256 amountIn, uint256 amountOut,
        uint256 targetCommitment, uint256 targetPrecommitment);

    constructor(address sourcePool, address targetPool) {
        if (block.chainid != 4663) revert UnsupportedChain();
        if (sourcePool == targetPool || sourcePool.code.length == 0 || targetPool.code.length == 0
            || sourcePool == TREASURY || targetPool == TREASURY) revert InvalidPools();
        SOURCE_POOL = ILincolnV4CandidateSource(sourcePool);
        TARGET_POOL = ILincolnV4CandidateTarget(targetPool);
        address input = ILincolnV4CandidateSource(sourcePool).ASSET();
        address output = ILincolnV4CandidateTarget(targetPool).ASSET();
        if (!((input == LINCOLN && output == SPCX) || (input == SPCX && output == LINCOLN))) revert InvalidPools();
        if (ILincolnV4CandidateSource(sourcePool).ASP_REGISTRY() == address(0)
            || ILincolnV4CandidateSource(sourcePool).ASP_REGISTRY() != ILincolnV4CandidateTarget(targetPool).ASP_REGISTRY()
            || ILincolnV4CandidateSource(sourcePool).VERIFIER() != ILincolnV4CandidateTarget(targetPool).VERIFIER()
            || ILincolnV4CandidateSource(sourcePool).HOLDER_EXIT_VERIFIER() != ILincolnV4CandidateTarget(targetPool).HOLDER_EXIT_VERIFIER()
            || ILincolnV4CandidateSource(sourcePool).SCOPE() == ILincolnV4CandidateTarget(targetPool).SCOPE()) revert InvalidPools();
        TOKEN_IN = IERC20(input);
        TOKEN_OUT = IERC20(output);
        IS_BUY = input == SPCX;
        SOURCE_POOL_CODE_HASH = sourcePool.codehash;
        TARGET_POOL_CODE_HASH = targetPool.codehash;
        _validateVenue();
    }

    function poolKey() external pure returns (address, address, uint24, int24, address) {
        return (LINCOLN, SPCX, LP_FEE_PIPS, TICK_SPACING, HOOK);
    }

    function fixedSqrtPriceLimitX96() public view returns (uint160) {
        return IS_BUY ? uint160(1461446703485210103287273052203988822378723970341) : uint160(4295128740);
    }

    function actionHash(Action calldata action) public view returns (bytes32) {
        bytes32 venue = keccak256(abi.encode(ROUTER, FACTORY, STRATEGY_ID, CURVE,
            STRATEGY_TREASURY, STRATEGY_IMPLEMENTATION, STRATEGY_UPGRADE_CONTROLLER,
            POOL_MANAGER, POOL_ID, IS_BUY, FEE_BPS, TREASURY));
        return keccak256(abi.encode(SWAP_DOMAIN, block.chainid, address(this), address(SOURCE_POOL),
            address(TARGET_POOL), venue, action.processor, action.amountIn, action.minAmountOut,
            action.deadline, action.targetPrecommitment, keccak256(action.encryptedTemplate),
            action.maxServiceFee, action.sqrtPriceLimitX96, action.maxHookTaxBps));
    }

    function actionEnvelope(Action calldata action) public view returns (bytes memory envelope) {
        envelope = new bytes(CIPHERTEXT_BYTES);
        bytes32 digest = actionHash(action);
        assembly ('memory-safe') { mstore(add(envelope, 0x20), digest) }
    }

    function minimumGrossOutput(uint128 minNet) public pure returns (uint256) {
        if (minNet == 0) revert InvalidAction();
        return (uint256(minNet) - 1) * 10_000 / (10_000 - FEE_BPS) + 1;
    }

    function swap(Action calldata action, Proof calldata proof, ILincolnV4CandidateSource.ExtData calldata data,
        bytes[2] calldata encryptedOutputs) external nonReentrant returns (uint256 amountOut, uint256 targetCommitment)
    {
        _validateAction(action, proof, data, encryptedOutputs);
        _validateVenue();
        Balances memory beforeBalances = _balances();
        if (TOKEN_IN.allowance(address(this), ROUTER) != 0
            || TOKEN_OUT.allowance(address(this), address(TARGET_POOL)) != 0) revert NonzeroAllowance();
        SOURCE_POOL.transact(proof.pA, proof.pB, proof.pC, proof.pubSignals, data, encryptedOutputs);
        if (TOKEN_IN.balanceOf(address(this)) != beforeBalances.input + action.amountIn
            || TOKEN_OUT.balanceOf(address(this)) != beforeBalances.output
            || address(this).balance != beforeBalances.nativeBalance) revert UnexpectedBalanceDelta();
        // Re-check after all source-pool/token calls, immediately before the typed router.
        _validateVenue();
        uint256 grossOut = _execute(action);
        TOKEN_IN.forceApprove(ROUTER, 0);
        if (TOKEN_IN.balanceOf(address(this)) != beforeBalances.input
            || TOKEN_OUT.balanceOf(address(this)) != beforeBalances.output + grossOut
            || grossOut == 0 || grossOut > type(uint128).max) revert UnexpectedBalanceDelta();
        uint256 serviceFee = grossOut * FEE_BPS / 10_000;
        if (serviceFee > action.maxServiceFee) revert ServiceFeeAboveLimit();
        amountOut = grossOut - serviceFee;
        if (amountOut < action.minAmountOut) revert InvalidAction();
        if (serviceFee != 0) TOKEN_OUT.safeTransfer(TREASURY, serviceFee);
        if (TOKEN_OUT.balanceOf(TREASURY) != beforeBalances.treasury + serviceFee
            || TOKEN_OUT.balanceOf(address(this)) != beforeBalances.output + amountOut) revert UnexpectedBalanceDelta();
        TOKEN_OUT.forceApprove(address(TARGET_POOL), amountOut);
        targetCommitment = TARGET_POOL.depositDynamic(uint128(amountOut), action.targetPrecommitment, action.encryptedTemplate);
        TOKEN_OUT.forceApprove(address(TARGET_POOL), 0);
        _checkFinalBalances(beforeBalances, amountOut, serviceFee);
        _validateVenue();
        emit ServiceFeePaid(TREASURY, address(TOKEN_OUT), grossOut, serviceFee, amountOut);
        emit SwapReshielded(action.processor, address(SOURCE_POOL), address(TARGET_POOL), proof.pubSignals[5],
            proof.pubSignals[6], action.amountIn, amountOut, targetCommitment, action.targetPrecommitment);
    }

    function _validateAction(Action calldata action, Proof calldata proof,
        ILincolnV4CandidateSource.ExtData calldata data, bytes[2] calldata encryptedOutputs) private view
    {
        if (block.chainid != 4663 || address(SOURCE_POOL).codehash != SOURCE_POOL_CODE_HASH
            || address(TARGET_POOL).codehash != TARGET_POOL_CODE_HASH) revert InvalidPools();
        if (action.processor == address(0) || action.processor != msg.sender || block.timestamp > action.deadline
            || action.amountIn == 0 || action.amountIn > uint128(type(int128).max) || action.minAmountOut == 0
            || minimumGrossOutput(action.minAmountOut) > uint256(uint128(type(int128).max))
            || action.targetPrecommitment == 0 || action.targetPrecommitment >= FIELD
            || action.encryptedTemplate.length != CIPHERTEXT_BYTES) revert InvalidAction();
        if (action.sqrtPriceLimitX96 != fixedSqrtPriceLimitX96()) revert UnsupportedPriceLimit();
        if (action.maxHookTaxBps < HOOK_TAX_BPS || action.maxHookTaxBps > 10_000) revert HookTaxAboveLimit();
        if (data.processor != address(this) || data.recipient != address(this) || data.feeRecipient != address(0)
            || data.publicIn != 0 || data.publicOut != action.amountIn || data.fee != 0
            || proof.pubSignals[1] != 0 || proof.pubSignals[2] != action.amountIn || proof.pubSignals[8] != 0) revert InvalidSourceAuthorization();
        if (encryptedOutputs[0].length != CIPHERTEXT_BYTES || encryptedOutputs[1].length != CIPHERTEXT_BYTES
            || keccak256(encryptedOutputs[1]) != keccak256(actionEnvelope(action))) revert ActionMismatch();
    }

    function _execute(Action calldata action) private returns (uint256 grossOut) {
        IHedgeFunV4CandidateRouter.TradeParams memory p = IHedgeFunV4CandidateRouter.TradeParams({
            id: STRATEGY_ID, asset: SPCX, amountIn: action.amountIn,
            minStockReceived: IS_BUY ? action.amountIn : 0,
            minFinalOut: minimumGrossOutput(action.minAmountOut), deadline: action.deadline,
            expectedStage: GRADUATED, allowPartialFill: false
        });
        IHedgeFunV4CandidateRouter.Hop[] memory empty = new IHedgeFunV4CandidateRouter.Hop[](0);
        TOKEN_IN.forceApprove(ROUTER, action.amountIn);
        uint256 refund;
        if (IS_BUY) (grossOut, refund) = IHedgeFunV4CandidateRouter(ROUTER).buy(p, empty);
        else (grossOut, refund) = IHedgeFunV4CandidateRouter(ROUTER).sell(p, empty);
        if (refund != 0) revert PartialFill();
    }

    function _validateVenue() private view {
        // Exact live runtime pins. SPCX proxy code alone would not pin its upgradeable implementation.
        if (ROUTER.codehash != 0x6d11e519938778d5081784d8ee319dcbf5489a41e19dedfe005357c67550f17c
            || FACTORY.codehash != 0x6ed5348d51a5e51a5def01a8254bf0aaa2050749f4d2493692f18d1a5966404e
            || POOL_MANAGER.codehash != 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626
            || HOOK.codehash != 0x0905d4cc5af8b1872eaf6a0a11536f2111acff07fbef7270c7f498f77cb5d8fc
            || STRATEGY_TREASURY.codehash != 0x989be5bbe3dfbd6f855916d4ed5edf1cd5ed389c0d30b9fac9cb9718d06742a4
            || STRATEGY_IMPLEMENTATION.codehash != 0x26aa03ccdba2d1d73af4bf20d71ef46e82493d101e265279d77ce49805ceebd8
            || STRATEGY_UPGRADE_CONTROLLER.codehash != 0x128cce51e35ac1c4d26e0445dc321252632925dd695f37197be9eeb7f49d04c9
            || CURVE.codehash != 0x12a949972b29415743b0dfa6a99c046f1ff4aefa1312f4db282090b8e8f3178c
            || LIQUIDITY_VAULT.codehash != 0x5e68c4ba1332801c07f06868ff8dd5fabbeeeac2f6bfe6454780de4eccc4fcbb
            || LINCOLN.codehash != 0x47ac9e2d06060f8967967485194b8107706bcab075cc3398674b1130353e7e21
            || SPCX.codehash != 0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630
            || SPCX_BEACON.codehash != 0x8b465c0b53a2ba499566e9b4ca67d8c90ed6131743df806a570d156956a7e90e
            || SPCX_IMPLEMENTATION.codehash != 0xdc07e86ee482f99641bdafb9a0d772846b167401e094d90a666b94dbdcd1eec7
            || IHedgeFunV4CandidateBeacon(SPCX_BEACON).implementation() != SPCX_IMPLEMENTATION) revert VenueChanged();
        if (IHedgeFunV4CandidateRouter(ROUTER).factory() != FACTORY
            || IHedgeFunV4CandidateRouter(ROUTER).poolManager() != POOL_MANAGER
            || IHedgeFunV4CandidateTreasury(STRATEGY_TREASURY).implementation() != STRATEGY_IMPLEMENTATION
            || IHedgeFunV4CandidateTreasury(STRATEGY_TREASURY).treasuryUpgradeController() != STRATEGY_UPGRADE_CONTROLLER
            || IHedgeFunV4CandidateFactory(FACTORY).curves(STRATEGY_ID) != CURVE
            || IHedgeFunV4CandidateCurve(CURVE).status() != GRADUATED) revert VenueChanged();
        (address token, address treasury, address hook, address stock, address creator) = IHedgeFunV4CandidateFactory(FACTORY).strategies(STRATEGY_ID);
        if (token != LINCOLN || treasury != STRATEGY_TREASURY || hook != HOOK || stock != SPCX || creator != CREATOR) revert VenueChanged();
        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = IHedgeFunV4CandidateTreasury(STRATEGY_TREASURY).poolKey();
        if (c0 != LINCOLN || c1 != SPCX || fee != LP_FEE_PIPS || spacing != TICK_SPACING || hooks != HOOK
            || keccak256(abi.encode(c0, c1, fee, spacing, hooks)) != POOL_ID || (uint160(HOOK) & 0x3fff) != 0x28cc) revert VenueChanged();
        _validateHook();
    }

    function _validateHook() private view {
        IHedgeFunV4CandidateHook hook = IHedgeFunV4CandidateHook(HOOK);
        if (hook.version() != 3 || hook.factory() != FACTORY || hook.poolManager() != POOL_MANAGER
            || !hook.isRegistered(POOL_ID) || hook.liquidityVaultOf(POOL_ID) != LIQUIDITY_VAULT) revert VenueChanged();
        (address token, address stock, address treasury, bool tokenIsCurrency0) = hook.poolConfig(POOL_ID);
        if (token != LINCOLN || stock != SPCX || treasury != STRATEGY_TREASURY || !tokenIsCurrency0
            || treasury == ROUTER || treasury == address(this)) revert VenueChanged();
        IHedgeFunV4CandidateHook.Rates memory r = hook.rates(POOL_ID);
        if (r.taxBps != HOOK_TAX_BPS || r.spikeBps != 0 || r.spikeSeconds != 0
            || r.snipeBps != 0 || r.snipeSeconds != 0 || r.protocolBps != 3000
            || r.creatorBps != 5000 || r.sweepTipBps != 0) revert VenueChanged();
        // Actual swap sender is ROUTER. It is not the exempt treasury. With
        // snipeSeconds == 0, _buyRate ignores sender, so querying from this
        // wrapper returns exactly the same 100 bps as the router's buy.
        if (hook.sellRateBps(POOL_ID) != HOOK_TAX_BPS || hook.buyRateBps(POOL_ID) != HOOK_TAX_BPS) revert VenueChanged();
    }

    function _balances() private view returns (Balances memory b) {
        b.nativeBalance = address(this).balance;
        b.input = TOKEN_IN.balanceOf(address(this));
        b.output = TOKEN_OUT.balanceOf(address(this));
        b.routerNative = ROUTER.balance;
        b.routerInput = TOKEN_IN.balanceOf(ROUTER);
        b.routerOutput = TOKEN_OUT.balanceOf(ROUTER);
        b.target = TOKEN_OUT.balanceOf(address(TARGET_POOL));
        b.treasury = TOKEN_OUT.balanceOf(TREASURY);
    }

    function _checkFinalBalances(Balances memory b, uint256 net, uint256 fee) private view {
        if (address(this).balance != b.nativeBalance || TOKEN_IN.balanceOf(address(this)) != b.input
            || TOKEN_OUT.balanceOf(address(this)) != b.output || ROUTER.balance != b.routerNative
            || TOKEN_IN.balanceOf(ROUTER) != b.routerInput || TOKEN_OUT.balanceOf(ROUTER) != b.routerOutput
            || TOKEN_OUT.balanceOf(address(TARGET_POOL)) != b.target + net
            || TOKEN_OUT.balanceOf(TREASURY) != b.treasury + fee) revert UnexpectedBalanceDelta();
        if (TOKEN_IN.allowance(address(this), ROUTER) != 0
            || TOKEN_OUT.allowance(address(this), address(TARGET_POOL)) != 0) revert NonzeroAllowance();
    }
}
