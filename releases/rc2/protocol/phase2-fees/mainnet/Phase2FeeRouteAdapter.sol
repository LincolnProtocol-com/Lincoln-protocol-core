// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {
    IPhase2RouteSourcePool, IPhase2RouteTargetPool, IPhase2ExactInputRouter,
    IPhase2RouteWrappedNative, IPhase2RouteV3Factory, IPhase2RouteUPFactory
} from '../../phase2-mainnet/contracts/Phase2RouteAdapter.sol';
import {IPhase2Router02ExactInputRouter} from '../../phase2-mainnet/contracts/Phase2Router02Adapter.sol';

/// @notice Shared accounting for immutable, typed exact-input routes with an output service fee.
/// @dev Existing pool circuits and old adapters remain unchanged. No owner, setters, sweep,
/// arbitrary calldata or fee-on-transfer token support. Public DEX activity remains visible.
abstract contract Phase2FeeRouteBase is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Action {
        address processor;
        uint128 amountIn;
        uint128 minAmountOut; // Minimum NET amount deposited into the target privacy pool.
        uint256 deadline;
        uint256 targetPrecommitment;
        bytes encryptedTemplate;
        uint128 maxServiceFee; // Absolute maximum fee, denominated in TOKEN_OUT base units.
    }

    struct Proof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[9] pubSignals;
    }

    struct Balances {
        uint256 nativeBalance;
        uint256 wrappedBalance;
        uint256 targetBalance;
        uint256 treasuryBalance;
        uint256[] routeBalances;
        uint256 routerNativeBalance;
        uint256 routerWrappedBalance;
        uint256[] routerRouteBalances;
    }

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 public constant SWAP_DOMAIN = keccak256('LINCOLN_PHASE2_FEE_ROUTES_V1');
    uint8 public constant UNISWAP_V3 = 0;
    uint8 public constant UP_SLIPSTREAM = 1;
    uint256 public constant MAX_HOPS = 4;
    uint256 public constant CIPHERTEXT_BYTES = 256;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_SERVICE_FEE_BPS = 100;

    IPhase2RouteSourcePool public immutable SOURCE_POOL;
    IPhase2RouteTargetPool public immutable TARGET_POOL;
    address public immutable ROUTER;
    IPhase2RouteWrappedNative public immutable WRAPPED_NATIVE;
    address public immutable FACTORY;
    address public immutable SOURCE_ASSET;
    address public immutable TARGET_ASSET;
    bool public immutable SOURCE_NATIVE;
    bool public immutable TARGET_NATIVE;
    IERC20 public immutable TOKEN_IN;
    IERC20 public immutable TOKEN_OUT;
    uint8 public immutable PROTOCOL;
    uint256 public immutable HOPS;
    bytes32 public immutable PATH_HASH;
    uint16 public immutable FEE_BPS;
    address public immutable TREASURY;
    bytes public PATH;
    address[] private _routeTokens;
    address[] private _hopPools;

    error InvalidRoute();
    error UnsupportedChainId();
    error InvalidProcessor();
    error InvalidSwapAmount();
    error InvalidPrecommitment();
    error InvalidTemplate();
    error InvalidSourceAuthorization();
    error ActionMismatch();
    error ExpiredSwap();
    error UnexpectedBalanceDelta();
    error NonzeroAllowance();
    error UnexpectedNativeSender();
    error InvalidServiceFee();
    error ServiceFeeAboveLimit();

    // amountOut is NET, matching the new target note's value.
    event SwapReshielded(address indexed processor, address indexed sourcePool, address indexed targetPool,
        uint256 inputNullifier0, uint256 inputNullifier1, uint256 amountIn, uint256 amountOut,
        uint256 targetCommitment, uint256 targetPrecommitment);
    event ServiceFeePaid(address indexed treasury, address indexed token, uint256 grossAmountOut,
        uint256 serviceFee, uint256 netAmountOut);

    constructor(address sourcePool, address targetPool, address router, address wrappedNative,
        uint8 protocol, bytes memory path, uint16 feeBps, address treasury)
    {
        if (block.chainid != 4663) revert UnsupportedChainId();
        if (sourcePool == targetPool || sourcePool.code.length == 0 || targetPool.code.length == 0
            || router.code.length == 0 || wrappedNative.code.length == 0 || protocol > UP_SLIPSTREAM) revert InvalidRoute();
        if (feeBps == 0 || feeBps > MAX_SERVICE_FEE_BPS || treasury == address(0)
            || treasury == address(this) || treasury == sourcePool || treasury == targetPool
            || treasury == router || treasury == wrappedNative) revert InvalidServiceFee();
        SOURCE_POOL = IPhase2RouteSourcePool(sourcePool);
        TARGET_POOL = IPhase2RouteTargetPool(targetPool);
        SOURCE_ASSET = SOURCE_POOL.ASSET();
        TARGET_ASSET = TARGET_POOL.ASSET();
        SOURCE_NATIVE = SOURCE_ASSET == address(0);
        TARGET_NATIVE = TARGET_ASSET == address(0);
        TOKEN_IN = IERC20(SOURCE_NATIVE ? wrappedNative : SOURCE_ASSET);
        TOKEN_OUT = IERC20(TARGET_NATIVE ? wrappedNative : TARGET_ASSET);
        ROUTER = router;
        WRAPPED_NATIVE = IPhase2RouteWrappedNative(wrappedNative);
        PROTOCOL = protocol;
        FEE_BPS = feeBps;
        TREASURY = treasury;
        // factory()/WETH9() are shared by both supported router ABIs.
        FACTORY = IPhase2ExactInputRouter(router).factory();
        if (address(TOKEN_IN) == address(TOKEN_OUT) || FACTORY.code.length == 0
            || IPhase2ExactInputRouter(router).WETH9() != wrappedNative) revert InvalidRoute();
        HOPS = _validatePath(path);
        if (treasury == FACTORY) revert InvalidServiceFee();
        for (uint256 i; i < _routeTokens.length; ++i) {
            if (treasury == _routeTokens[i]) revert InvalidServiceFee();
        }
        for (uint256 i; i < _hopPools.length; ++i) {
            if (treasury == _hopPools[i]) revert InvalidServiceFee();
        }
        PATH = path;
        PATH_HASH = keccak256(path);
    }

    receive() external payable {
        if (msg.sender != address(SOURCE_POOL) && msg.sender != address(WRAPPED_NATIVE)) revert UnexpectedNativeSender();
    }

    function routeTokens() external view returns (address[] memory) { return _routeTokens; }
    function hopPools() external view returns (address[] memory) { return _hopPools; }

    function actionHash(Action calldata action) public view returns (bytes32) {
        return keccak256(abi.encode(SWAP_DOMAIN, block.chainid, address(this), address(SOURCE_POOL),
            address(TARGET_POOL), ROUTER, address(WRAPPED_NATIVE), FACTORY, PROTOCOL, PATH_HASH,
            FEE_BPS, TREASURY, action.processor, action.amountIn, action.minAmountOut,
            action.deadline, action.targetPrecommitment, keccak256(action.encryptedTemplate), action.maxServiceFee));
    }

    /// @dev Existing source proof binds this envelope in its second zero-value output slot.
    function actionEnvelope(Action calldata action) public view returns (bytes memory envelope) {
        envelope = new bytes(CIPHERTEXT_BYTES);
        bytes32 digest = actionHash(action);
        assembly ('memory-safe') { mstore(add(envelope, 0x20), digest) }
    }

    /// @notice Minimum gross output that satisfies minNet after a FLOOR-rounded fee.
    /// @dev net = gross - floor(gross * bps / 10000). All arguments are uint128 bounded.
    function minimumGrossOutput(uint128 minNet) public view returns (uint256) {
        if (minNet == 0) revert InvalidSwapAmount();
        return (uint256(minNet) - 1) * BPS_DENOMINATOR / (BPS_DENOMINATOR - FEE_BPS) + 1;
    }

    function swap(Action calldata action, Proof calldata proof, IPhase2RouteSourcePool.ExtData calldata data,
        bytes[2] calldata encryptedOutputs)
        external nonReentrant returns (uint256 amountOut, uint256 targetCommitment)
    {
        _validateAction(action, proof, data, encryptedOutputs);
        Balances memory beforeBalances = _balances();
        _withdrawAndWrap(action, proof, data, encryptedOutputs, beforeBalances);
        TOKEN_IN.forceApprove(ROUTER, action.amountIn);
        _executeRouter(action, minimumGrossOutput(action.minAmountOut));
        TOKEN_IN.forceApprove(ROUTER, 0);
        if (TOKEN_IN.balanceOf(address(this)) != beforeBalances.routeBalances[0]) revert UnexpectedBalanceDelta();
        uint256 outputBefore = beforeBalances.routeBalances[HOPS];
        uint256 outputAfter = TOKEN_OUT.balanceOf(address(this));
        if (outputAfter < outputBefore) revert UnexpectedBalanceDelta();
        uint256 grossOut = outputAfter - outputBefore;
        if (grossOut > type(uint128).max) revert InvalidSwapAmount();
        uint256 serviceFee = grossOut * FEE_BPS / BPS_DENOMINATOR;
        if (serviceFee > action.maxServiceFee) revert ServiceFeeAboveLimit();
        amountOut = grossOut - serviceFee;
        if (amountOut < action.minAmountOut) revert InvalidSwapAmount();
        // Native-output fees are paid in wrapped native. No native treasury callback.
        if (serviceFee != 0) TOKEN_OUT.safeTransfer(TREASURY, serviceFee);
        if (TOKEN_OUT.balanceOf(address(this)) != outputBefore + amountOut
            || TOKEN_OUT.balanceOf(TREASURY) != beforeBalances.treasuryBalance + serviceFee) revert UnexpectedBalanceDelta();
        targetCommitment = _reshield(action, uint128(amountOut), beforeBalances);
        _checkFinalBalances(beforeBalances, amountOut, serviceFee);
        emit ServiceFeePaid(TREASURY, address(TOKEN_OUT), grossOut, serviceFee, amountOut);
        emit SwapReshielded(action.processor, address(SOURCE_POOL), address(TARGET_POOL),
            proof.pubSignals[5], proof.pubSignals[6], action.amountIn, amountOut,
            targetCommitment, action.targetPrecommitment);
    }

    function _executeRouter(Action calldata action, uint256 minGrossOut) internal virtual;

    function _validateAction(Action calldata action, Proof calldata proof,
        IPhase2RouteSourcePool.ExtData calldata data, bytes[2] calldata encryptedOutputs) internal view
    {
        if (action.processor == address(0) || msg.sender != action.processor) revert InvalidProcessor();
        if (block.timestamp > action.deadline) revert ExpiredSwap();
        if (action.amountIn == 0 || action.minAmountOut == 0) revert InvalidSwapAmount();
        if (action.targetPrecommitment == 0 || action.targetPrecommitment >= FIELD) revert InvalidPrecommitment();
        if (action.encryptedTemplate.length != CIPHERTEXT_BYTES) revert InvalidTemplate();
        if (data.processor != address(this) || data.recipient != address(this) || data.feeRecipient != address(0)
            || data.publicIn != 0 || data.publicOut != action.amountIn || data.fee != 0
            || proof.pubSignals[1] != 0 || proof.pubSignals[2] != action.amountIn || proof.pubSignals[8] != 0) {
            revert InvalidSourceAuthorization();
        }
        if (encryptedOutputs[0].length != CIPHERTEXT_BYTES || encryptedOutputs[1].length != CIPHERTEXT_BYTES
            || keccak256(encryptedOutputs[1]) != keccak256(actionEnvelope(action))) revert ActionMismatch();
    }

    function _withdrawAndWrap(Action calldata action, Proof calldata proof,
        IPhase2RouteSourcePool.ExtData calldata data, bytes[2] calldata encryptedOutputs, Balances memory beforeBalances) internal
    {
        SOURCE_POOL.transact(proof.pA, proof.pB, proof.pC, proof.pubSignals, data, encryptedOutputs);
        if (SOURCE_NATIVE) {
            if (address(this).balance != beforeBalances.nativeBalance + action.amountIn
                || TOKEN_IN.balanceOf(address(this)) != beforeBalances.routeBalances[0]) revert UnexpectedBalanceDelta();
            WRAPPED_NATIVE.deposit{value: action.amountIn}();
        }
        if (address(this).balance != beforeBalances.nativeBalance
            || TOKEN_IN.balanceOf(address(this)) != beforeBalances.routeBalances[0] + action.amountIn) revert UnexpectedBalanceDelta();
    }

    function _reshield(Action calldata action, uint128 amountOut, Balances memory beforeBalances)
        internal returns (uint256 commitment)
    {
        if (TARGET_NATIVE) {
            WRAPPED_NATIVE.withdraw(amountOut);
            if (TOKEN_OUT.balanceOf(address(this)) != beforeBalances.routeBalances[HOPS]
                || address(this).balance != beforeBalances.nativeBalance + amountOut) revert UnexpectedBalanceDelta();
            commitment = TARGET_POOL.depositDynamic{value: amountOut}(
                amountOut, action.targetPrecommitment, action.encryptedTemplate);
        } else {
            TOKEN_OUT.forceApprove(address(TARGET_POOL), amountOut);
            commitment = TARGET_POOL.depositDynamic(amountOut, action.targetPrecommitment, action.encryptedTemplate);
            TOKEN_OUT.forceApprove(address(TARGET_POOL), 0);
        }
    }

    function _balances() internal view returns (Balances memory snapshot) {
        snapshot.nativeBalance = address(this).balance;
        snapshot.wrappedBalance = WRAPPED_NATIVE.balanceOf(address(this));
        snapshot.targetBalance = _targetBalance();
        snapshot.treasuryBalance = TOKEN_OUT.balanceOf(TREASURY);
        snapshot.routerNativeBalance = ROUTER.balance;
        snapshot.routerWrappedBalance = WRAPPED_NATIVE.balanceOf(ROUTER);
        snapshot.routeBalances = new uint256[](_routeTokens.length);
        snapshot.routerRouteBalances = new uint256[](_routeTokens.length);
        for (uint256 i; i < _routeTokens.length; ++i) {
            snapshot.routeBalances[i] = IERC20(_routeTokens[i]).balanceOf(address(this));
            snapshot.routerRouteBalances[i] = IERC20(_routeTokens[i]).balanceOf(ROUTER);
        }
    }

    function _checkFinalBalances(Balances memory beforeBalances, uint256 amountOut, uint256 serviceFee) internal view {
        if (address(this).balance != beforeBalances.nativeBalance
            || WRAPPED_NATIVE.balanceOf(address(this)) != beforeBalances.wrappedBalance
            || ROUTER.balance != beforeBalances.routerNativeBalance
            || WRAPPED_NATIVE.balanceOf(ROUTER) != beforeBalances.routerWrappedBalance
            || TOKEN_OUT.balanceOf(TREASURY) != beforeBalances.treasuryBalance + serviceFee
            || _targetBalance() != beforeBalances.targetBalance + amountOut) revert UnexpectedBalanceDelta();
        for (uint256 i; i < _routeTokens.length; ++i) {
            if (IERC20(_routeTokens[i]).balanceOf(address(this)) != beforeBalances.routeBalances[i]
                || IERC20(_routeTokens[i]).balanceOf(ROUTER) != beforeBalances.routerRouteBalances[i]) {
                revert UnexpectedBalanceDelta();
            }
        }
        if (TOKEN_IN.allowance(address(this), ROUTER) != 0
            || TOKEN_OUT.allowance(address(this), address(TARGET_POOL)) != 0) revert NonzeroAllowance();
    }

    function _targetBalance() internal view returns (uint256) {
        return TARGET_NATIVE ? address(TARGET_POOL).balance : TOKEN_OUT.balanceOf(address(TARGET_POOL));
    }

    function _validatePath(bytes memory path) internal returns (uint256 hops) {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert InvalidRoute();
        hops = (path.length - 20) / 23;
        if (hops > MAX_HOPS || _tokenAt(path, 0) != address(TOKEN_IN)
            || _tokenAt(path, hops * 23) != address(TOKEN_OUT)) revert InvalidRoute();
        for (uint256 i; i <= hops; ++i) {
            address token = _tokenAt(path, i * 23);
            if (token.code.length == 0) revert InvalidRoute();
            for (uint256 j; j < i; ++j) if (_routeTokens[j] == token) revert InvalidRoute();
            _routeTokens.push(token);
            if (i == 0) continue;
            uint24 parameter = _parameterAt(path, (i - 1) * 23 + 20);
            address pool;
            if (PROTOCOL == UNISWAP_V3) {
                if (parameter == 0 || parameter >= 1_000_000) revert InvalidRoute();
                pool = IPhase2RouteV3Factory(FACTORY).getPool(_routeTokens[i - 1], token, parameter);
            } else {
                if (parameter == 0 || parameter >= 1 << 23) revert InvalidRoute();
                pool = IPhase2RouteUPFactory(FACTORY).getPool(_routeTokens[i - 1], token, int24(parameter));
            }
            if (pool.code.length == 0) revert InvalidRoute();
            _hopPools.push(pool);
        }
    }

    function _tokenAt(bytes memory path, uint256 offset) internal pure returns (address token) {
        assembly ('memory-safe') { token := shr(96, mload(add(add(path, 0x20), offset))) }
    }

    function _parameterAt(bytes memory path, uint256 offset) internal pure returns (uint24 parameter) {
        assembly ('memory-safe') { parameter := shr(232, mload(add(add(path, 0x20), offset))) }
    }
}

/// @notice UP Slipstream and Uniswap V3 periphery ABI with a deadline tuple.
contract Phase2FeeRouteAdapter is Phase2FeeRouteBase {
    constructor(address sourcePool, address targetPool, address router, address wrappedNative,
        uint8 protocol, bytes memory path, uint16 feeBps, address treasury)
        Phase2FeeRouteBase(sourcePool, targetPool, router, wrappedNative, protocol, path, feeBps, treasury) {}

    function _executeRouter(Action calldata action, uint256 minGrossOut) internal override {
        IPhase2ExactInputRouter(ROUTER).exactInput(IPhase2ExactInputRouter.ExactInputParams({
            path: PATH, recipient: address(this), deadline: action.deadline,
            amountIn: action.amountIn, amountOutMinimum: minGrossOut
        }));
    }
}

/// @notice Uniswap SwapRouter02 ABI without a deadline tuple; adapter checks expiry.
contract Phase2FeeRouter02Adapter is Phase2FeeRouteBase {
    constructor(address sourcePool, address targetPool, address router, address wrappedNative,
        uint8 protocol, bytes memory path, uint16 feeBps, address treasury)
        Phase2FeeRouteBase(sourcePool, targetPool, router, wrappedNative, protocol, path, feeBps, treasury)
    { if (protocol != UNISWAP_V3) revert InvalidRoute(); }

    function _executeRouter(Action calldata action, uint256 minGrossOut) internal override {
        IPhase2Router02ExactInputRouter(ROUTER).exactInput(IPhase2Router02ExactInputRouter.ExactInputParams({
            path: PATH, recipient: address(this), amountIn: action.amountIn, amountOutMinimum: minGrossOut
        }));
    }
}
