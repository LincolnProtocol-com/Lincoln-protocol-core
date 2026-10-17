// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

interface IPhase2Router02RouteSourcePool {
    struct ExtData {
        address recipient;
        address feeRecipient;
        address processor;
        uint128 publicIn;
        uint128 publicOut;
        uint128 fee;
    }
    function ASSET() external view returns (address);
    function transact(uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC,
        uint256[9] calldata signals, ExtData calldata data, bytes[2] calldata encryptedOutputs) external payable;
}

interface IPhase2Router02RouteTargetPool {
    function ASSET() external view returns (address);
    function depositDynamic(uint128 amount, uint256 precommitment, bytes calldata encryptedTemplate)
        external payable returns (uint256 commitment);
}

/// @dev Uniswap SwapRouter02 v3 exactInput tuple has no deadline field.
/// The immutable adapter validates its proof-bound action deadline before calling it.
interface IPhase2Router02ExactInputRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IPhase2Router02RouteWrappedNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IPhase2Router02RouteV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice Immutable Uniswap SwapRouter02 v3 path from a Phase2 note into a new note.
/// @dev Separate artifact; the original deadline-bearing adapter remains unchanged.
/// @dev No administrator, arbitrary router calldata, deferred claim, or sweep.
/// Public DEX amounts/path/timing are not confidential. Development deployment.
contract Phase2Router02Adapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Action {
        address processor;
        uint128 amountIn;
        uint128 minAmountOut;
        uint256 deadline;
        uint256 targetPrecommitment;
        bytes encryptedTemplate;
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
        uint256[] routeBalances;
        uint256 routerNativeBalance;
        uint256 routerWrappedBalance;
        uint256[] routerRouteBalances;
    }

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 public constant SWAP_DOMAIN = keccak256('CHENG_PHASE2_ROUTES_V1');
    uint8 public constant UNISWAP_V3 = 0;
    uint256 public constant MAX_HOPS = 4;
    uint256 public constant CIPHERTEXT_BYTES = 256;

    IPhase2Router02RouteSourcePool public immutable SOURCE_POOL;
    IPhase2Router02RouteTargetPool public immutable TARGET_POOL;
    IPhase2Router02ExactInputRouter public immutable ROUTER;
    IPhase2Router02RouteWrappedNative public immutable WRAPPED_NATIVE;
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
    // Constructor-only storage: there are deliberately no route setters.
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

    event SwapReshielded(address indexed processor, address indexed sourcePool, address indexed targetPool,
        uint256 inputNullifier0, uint256 inputNullifier1, uint256 amountIn, uint256 amountOut,
        uint256 targetCommitment, uint256 targetPrecommitment);

    constructor(address sourcePool, address targetPool, address router, address wrappedNative,
        uint8 protocol, bytes memory path)
    {
        if (block.chainid != 31341 && block.chainid != 46630) revert UnsupportedChainId();
        if (sourcePool == targetPool || sourcePool.code.length == 0 || targetPool.code.length == 0
            || router.code.length == 0 || wrappedNative.code.length == 0 || protocol != UNISWAP_V3) revert InvalidRoute();
        SOURCE_POOL = IPhase2Router02RouteSourcePool(sourcePool);
        TARGET_POOL = IPhase2Router02RouteTargetPool(targetPool);
        SOURCE_ASSET = SOURCE_POOL.ASSET();
        TARGET_ASSET = TARGET_POOL.ASSET();
        SOURCE_NATIVE = SOURCE_ASSET == address(0);
        TARGET_NATIVE = TARGET_ASSET == address(0);
        TOKEN_IN = IERC20(SOURCE_NATIVE ? wrappedNative : SOURCE_ASSET);
        TOKEN_OUT = IERC20(TARGET_NATIVE ? wrappedNative : TARGET_ASSET);
        ROUTER = IPhase2Router02ExactInputRouter(router);
        WRAPPED_NATIVE = IPhase2Router02RouteWrappedNative(wrappedNative);
        PROTOCOL = protocol;
        FACTORY = ROUTER.factory();
        if (address(TOKEN_IN) == address(TOKEN_OUT) || FACTORY.code.length == 0
            || ROUTER.WETH9() != wrappedNative) revert InvalidRoute();
        HOPS = _validatePath(path);
        PATH = path;
        PATH_HASH = keccak256(path);
    }

    /// @dev Immutable comparisons fit WETH9's 2300-gas transfer stipend. Forced
    /// native donations are preserved by the same snapshots as token donations.
    receive() external payable {
        if (msg.sender != address(SOURCE_POOL) && msg.sender != address(WRAPPED_NATIVE)) revert UnexpectedNativeSender();
    }

    function routeTokens() external view returns (address[] memory) { return _routeTokens; }
    function hopPools() external view returns (address[] memory) { return _hopPools; }

    function actionHash(Action calldata action) public view returns (bytes32) {
        return keccak256(abi.encode(SWAP_DOMAIN, block.chainid, address(this), address(SOURCE_POOL),
            address(TARGET_POOL), address(ROUTER), address(WRAPPED_NATIVE), FACTORY, PROTOCOL, PATH_HASH,
            action.processor, action.amountIn, action.minAmountOut, action.deadline,
            action.targetPrecommitment, keccak256(action.encryptedTemplate)));
    }

    /// @notice Put this envelope in the source proof's second, zero-value slot.
    /// Its hash is already authenticated by the source pool's proof context.
    function actionEnvelope(Action calldata action) public view returns (bytes memory envelope) {
        envelope = new bytes(CIPHERTEXT_BYTES);
        bytes32 digest = actionHash(action);
        assembly ('memory-safe') { mstore(add(envelope, 0x20), digest) }
    }

    function swap(Action calldata action, Proof calldata proof, IPhase2Router02RouteSourcePool.ExtData calldata data,
        bytes[2] calldata encryptedOutputs)
        external nonReentrant returns (uint256 amountOut, uint256 targetCommitment)
    {
        _validateAction(action, proof, data, encryptedOutputs);
        Balances memory beforeBalances = _balances();
        _withdrawAndWrap(action, proof, data, encryptedOutputs, beforeBalances);

        TOKEN_IN.forceApprove(address(ROUTER), action.amountIn);
        ROUTER.exactInput(IPhase2Router02ExactInputRouter.ExactInputParams({
            path: PATH, recipient: address(this),
            amountIn: action.amountIn, amountOutMinimum: action.minAmountOut
        }));
        TOKEN_IN.forceApprove(address(ROUTER), 0);
        // Never turn a donated balance or an unconsumed input refund into output.
        if (TOKEN_IN.balanceOf(address(this)) != beforeBalances.routeBalances[0]) revert UnexpectedBalanceDelta();
        uint256 outputBefore = beforeBalances.routeBalances[HOPS];
        uint256 outputAfter = TOKEN_OUT.balanceOf(address(this));
        if (outputAfter < outputBefore) revert UnexpectedBalanceDelta();
        amountOut = outputAfter - outputBefore;
        if (amountOut < action.minAmountOut || amountOut > type(uint128).max) revert InvalidSwapAmount();
        targetCommitment = _reshield(action, uint128(amountOut), beforeBalances);
        _checkFinalBalances(beforeBalances, amountOut);
        emit SwapReshielded(action.processor, address(SOURCE_POOL), address(TARGET_POOL),
            proof.pubSignals[5], proof.pubSignals[6], action.amountIn, amountOut,
            targetCommitment, action.targetPrecommitment);
    }

    function _validateAction(Action calldata action, Proof calldata proof,
        IPhase2Router02RouteSourcePool.ExtData calldata data, bytes[2] calldata encryptedOutputs) internal view
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
        IPhase2Router02RouteSourcePool.ExtData calldata data, bytes[2] calldata encryptedOutputs, Balances memory beforeBalances) internal
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
        snapshot.routerNativeBalance = address(ROUTER).balance;
        snapshot.routerWrappedBalance = WRAPPED_NATIVE.balanceOf(address(ROUTER));
        snapshot.routeBalances = new uint256[](_routeTokens.length);
        snapshot.routerRouteBalances = new uint256[](_routeTokens.length);
        for (uint256 i; i < _routeTokens.length; ++i) {
            snapshot.routeBalances[i] = IERC20(_routeTokens[i]).balanceOf(address(this));
            snapshot.routerRouteBalances[i] = IERC20(_routeTokens[i]).balanceOf(address(ROUTER));
        }
    }

    function _checkFinalBalances(Balances memory beforeBalances, uint256 amountOut) internal view {
        if (address(this).balance != beforeBalances.nativeBalance
            || WRAPPED_NATIVE.balanceOf(address(this)) != beforeBalances.wrappedBalance
            || address(ROUTER).balance != beforeBalances.routerNativeBalance
            || WRAPPED_NATIVE.balanceOf(address(ROUTER)) != beforeBalances.routerWrappedBalance
            || _targetBalance() != beforeBalances.targetBalance + amountOut) revert UnexpectedBalanceDelta();
        for (uint256 i; i < _routeTokens.length; ++i) {
            // Multihop routers custody intermediate output before the next hop.
            // Exhausting the first input does not prove that a later hop spent
            // its full input. Any new router residual must roll back the swap;
            // pre-existing donations must also remain untouched, never swept.
            if (IERC20(_routeTokens[i]).balanceOf(address(this)) != beforeBalances.routeBalances[i]
                || IERC20(_routeTokens[i]).balanceOf(address(ROUTER)) != beforeBalances.routerRouteBalances[i]) {
                revert UnexpectedBalanceDelta();
            }
        }
        if (TOKEN_IN.allowance(address(this), address(ROUTER)) != 0
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
            if (parameter == 0 || parameter >= 1_000_000) revert InvalidRoute();
            pool = IPhase2Router02RouteV3Factory(FACTORY).getPool(_routeTokens[i - 1], token, parameter);
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
