// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Base, MockJoinSplitVerifier, MockExitVerifier, MockToken} from './Base.sol';
import {MockWETH, MockFactory} from './Adapter.t.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';
import {Phase2FeeRouteBase, Phase2FeeRouteAdapter} from '../../../phase2-fees/contracts/Phase2FeeRouteAdapter.sol';
import {IPhase2RouteSourcePool} from '../../../phase2-routes/contracts/Phase2RouteAdapter.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

/// @dev Pays mock tokens by minting and WETH out of its own ETH.
contract FeeHop {
    MockWETH internal immutable weth;
    constructor(MockWETH weth_) { weth = weth_; }
    receive() external payable {}
    function pay(address token, address to, uint256 amount) external {
        if (token == address(weth)) { weth.deposit{value: amount}(); weth.transfer(to, amount); }
        else MockToken(token).mint(to, amount);
    }
}

/// @dev Single-hop exact-input router with injectable misbehaviour. It never
/// enforces amountOutMinimum, so the adapter's own checks are what is tested.
contract FeeMockRouter {
    address public immutable factory;
    address public immutable WETH9;
    FeeHop public immutable hop;
    uint8 public mode; // 0 honest, 1 partial pull, 2 router keeps residual
    uint256 public rate = 1e18;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    constructor(address factory_, address weth, FeeHop hop_) { factory = factory_; WETH9 = weth; hop = hop_; }

    function configure(uint8 nextMode, uint256 nextRate) external { mode = nextMode; rate = nextRate; }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        require(p.deadline >= block.timestamp, 'deadline');
        address tokenIn = address(bytes20(p.path[0:20]));
        address tokenOut = address(bytes20(p.path[23:43]));
        uint256 pulled = mode == 1 ? p.amountIn / 2 : p.amountIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pulled);
        uint256 forwarded = mode == 2 ? pulled - pulled / 3 : pulled;
        IERC20(tokenIn).transfer(address(hop), forwarded);
        out = forwarded * rate / 1e18;
        hop.pay(tokenOut, p.recipient, out);
    }
}

contract FeeAdapterTest is Base {
    address internal constant TREASURY = address(0x7EA5);
    uint16 internal constant BPS = 30;

    Phase2ASPRegistry internal registry;
    MockJoinSplitVerifier internal verifier;
    MockExitVerifier internal exitVerifier;
    MockToken internal tokenOut;
    MockWETH internal weth;
    FeeHop internal hop;
    MockFactory internal factory;
    FeeMockRouter internal router;
    Phase2ASPPool internal source;
    Phase2ASPPool internal target;
    Phase2FeeRouteAdapter internal adapter;
    uint256 internal nonce;

    receive() external payable {}

    function setUp() public {
        registry = deployRegistry();
        verifier = new MockJoinSplitVerifier();
        exitVerifier = new MockExitVerifier();
        tokenOut = new MockToken('OUT');
        weth = new MockWETH();
        hop = new FeeHop(weth);
        factory = new MockFactory(address(hop));
        router = new FeeMockRouter(address(factory), address(weth), hop);
        source = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(0), type(uint128).max, type(uint128).max);
        target = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(tokenOut), type(uint128).max, type(uint128).max);
        adapter = deployAdapter(source, target, abi.encodePacked(address(weth), uint24(3000), address(tokenOut)), BPS, TREASURY);
        publish(registry, 1, 7 days);
        vm.deal(address(this), 1_000_000 ether);
        vm.deal(address(hop), 1_000_000 ether);
    }

    function deployAdapter(Phase2ASPPool from, Phase2ASPPool to, bytes memory path, uint16 bps, address treasury)
        internal returns (Phase2FeeRouteAdapter)
    {
        return new Phase2FeeRouteAdapter(address(from), address(to), address(router), address(weth), 0, path, bps, treasury);
    }

    struct Prepared {
        Phase2FeeRouteBase.Action action;
        Phase2FeeRouteBase.Proof proof;
        IPhase2RouteSourcePool.ExtData data;
        bytes[2] out;
    }

    function fund(Phase2ASPPool pool, uint128 value) internal {
        if (pool.ASSET() == address(0)) {
            pool.depositDynamic{value: value}(value, ++nonce, cipher(nonce));
        } else {
            MockToken(pool.ASSET()).mint(address(this), value);
            IERC20(pool.ASSET()).approve(address(pool), value);
            pool.depositDynamic(value, ++nonce, cipher(nonce));
        }
    }

    function prepare(Phase2FeeRouteAdapter a, Phase2ASPPool pool, uint128 noteValue, uint128 amountIn, uint128 minNet,
        uint128 maxFee) internal returns (Prepared memory p)
    {
        fund(pool, noteValue);
        p.action = Phase2FeeRouteBase.Action({processor: address(this), amountIn: amountIn, minAmountOut: minNet,
            deadline: now_() + 1 hours, targetPrecommitment: ++nonce, encryptedTemplate: cipher(nonce), maxServiceFee: maxFee});
        p.out[0] = cipher(++nonce);
        p.out[1] = a.actionEnvelope(p.action);
        p.data = IPhase2RouteSourcePool.ExtData({recipient: address(a), feeRecipient: address(0),
            processor: address(a), publicIn: 0, publicOut: amountIn, fee: 0});
        Phase2ASPPool.ExtData memory poolData = Phase2ASPPool.ExtData({recipient: address(a), feeRecipient: address(0),
            processor: address(a), publicIn: 0, publicOut: amountIn, fee: 0});
        uint128 change = noteValue - amountIn;
        p.proof.pubSignals = [pool.currentRoot(), 0, uint256(amountIn), pool.hashContext(poolData, p.out), pool.SCOPE(),
            ++nonce, ++nonce, change == 0 ? 0 : ++nonce, 0];
    }

    function feeOf(uint256 gross, uint256 bps) internal pure returns (uint256) { return gross * bps / 10_000; }

    /// minimumGrossOutput is the exact least gross whose floor-fee net reaches minNet.
    function testFuzz_minimumGrossOutputIsTight(uint16 bps, uint128 minNet) public {
        bps = uint16(bound(bps, 1, 100));
        minNet = uint128(bound(minNet, 1, type(uint128).max));
        Phase2FeeRouteAdapter a = deployAdapter(source, target,
            abi.encodePacked(address(weth), uint24(3000), address(tokenOut)), bps, TREASURY);
        uint256 g = a.minimumGrossOutput(minNet);
        check(g - feeOf(g, bps) >= minNet, 'minimum gross too small');
        check(g == 1 || (g - 1) - feeOf(g - 1, bps) < minNet, 'minimum gross not tight');
    }

    /// Against a misbehaving router: either everything balances to the wei,
    /// or the whole transaction (including the source spend) reverts.
    function testFuzz_feeSwapExactOrReverts(uint128 noteValue, uint128 amountIn, uint256 rate, uint128 minNet,
        uint128 maxFee, uint8 mode) public
    {
        noteValue = uint128(bound(noteValue, 2, 100 ether));
        amountIn = uint128(bound(amountIn, 1, noteValue));
        rate = bound(rate, 0, 5e18);
        minNet = uint128(bound(minNet, 1, uint256(amountIn) * 5));
        maxFee = uint128(bound(maxFee, 0, uint256(amountIn) * 5 / 100));
        mode = uint8(bound(mode, 0, 2));
        router.configure(mode, rate);
        Prepared memory p = prepare(adapter, source, noteValue, amountIn, minNet, maxFee);
        uint256 pulled = mode == 1 ? amountIn / 2 : amountIn;
        uint256 forwarded = mode == 2 ? pulled - pulled / 3 : pulled;
        uint256 gross = forwarded * rate / 1e18;
        uint256 fee = feeOf(gross, BPS);
        bool shouldSucceed = forwarded == amountIn && gross - fee >= minNet && fee <= maxFee;
        uint256 targetBefore = tokenOut.balanceOf(address(target));
        uint256 sourceBefore = address(source).balance;

        try adapter.swap(p.action, p.proof, p.data, p.out) returns (uint256 net, uint256 commitment) {
            check(shouldSucceed, 'adapter accepted a residual, short, under-minimum or over-fee swap');
            eq(net, gross - fee, 'net is measured gross minus floor fee');
            eq(tokenOut.balanceOf(TREASURY), fee, 'treasury receives exactly the fee');
            eq(tokenOut.balanceOf(address(target)), targetBefore + net, 'target custody');
            eq(commitment, PoseidonT3.hash([net, p.action.targetPrecommitment]), 'target note value is net');
            check(target.commitments(commitment), 'target note inserted');
            eq(address(source).balance, sourceBefore - amountIn, 'source custody');
            check(source.spentNullifiers(p.proof.pubSignals[5]), 'source spent');
        } catch {
            check(!shouldSucceed, 'valid swap reverted');
            eq(tokenOut.balanceOf(TREASURY), 0, 'no fee on failure');
            eq(tokenOut.balanceOf(address(target)), targetBefore, 'atomic target');
            eq(address(source).balance, sourceBefore, 'atomic source');
            check(!source.spentNullifiers(p.proof.pubSignals[5]), 'atomic nullifier');
        }
        eq(weth.balanceOf(address(adapter)), 0, 'no adapter WETH');
        eq(tokenOut.balanceOf(address(adapter)), 0, 'no adapter output');
        eq(address(adapter).balance, 0, 'no adapter ETH');
    }

    /// ETH-output route: fee goes to treasury as WETH, only the net is unwrapped into the pool.
    function testFuzz_nativeTargetPaysFeeInWrapped(uint128 amountIn, uint256 rate) public {
        amountIn = uint128(bound(amountIn, 1e6, 100 ether));
        rate = bound(rate, 1e17, 5e18);
        router.configure(0, rate);
        MockToken tokenIn = new MockToken('IN');
        Phase2ASPPool erc20Source = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(tokenIn), type(uint128).max, type(uint128).max);
        Phase2ASPPool ethTarget = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(0), type(uint128).max, type(uint128).max);
        Phase2FeeRouteAdapter a = deployAdapter(erc20Source, ethTarget,
            abi.encodePacked(address(tokenIn), uint24(3000), address(weth)), BPS, TREASURY);
        uint256 gross = uint256(amountIn) * rate / 1e18;
        uint256 fee = feeOf(gross, BPS);
        Prepared memory p = prepare(a, erc20Source, amountIn, amountIn, 1, uint128(fee));
        (uint256 net,) = a.swap(p.action, p.proof, p.data, p.out);
        eq(net, gross - fee, 'net');
        eq(weth.balanceOf(TREASURY), fee, 'treasury paid in WETH');
        eq(TREASURY.balance, 0, 'no native sent to treasury');
        eq(address(ethTarget).balance, net, 'net unwrapped into pool');
        eq(tokenIn.balanceOf(address(erc20Source)), 0, 'source drained by exactly amountIn');
        eq(weth.balanceOf(address(a)) + address(a).balance, 0, 'no adapter residual');
    }

    /// Every fee term is bound by the proof through the envelope.
    function testFuzz_feeTermsCannotChangeAfterProving(uint8 field, uint256 value) public {
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 1, 1 ether);
        field = uint8(bound(field, 0, 3));
        if (field == 0) p.action.maxServiceFee = uint128(bound(value, 0, type(uint128).max));
        if (field == 1) p.action.minAmountOut = uint128(bound(value, 1, type(uint128).max));
        if (field == 2) p.action.targetPrecommitment = bound(value, 1, FIELD - 1);
        if (field == 3) p.action.deadline = p.action.deadline + bound(value, 1, 365 days);
        vm.assume(keccak256(adapter.actionEnvelope(p.action)) != keccak256(p.out[1]));
        vm.expectRevert(Phase2FeeRouteBase.ActionMismatch.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
    }

    /// An envelope proved for one adapter cannot be executed by a sibling with
    /// another fee or treasury, nor by calling the pool directly.
    function test_envelopeIsBoundToOneAdapter() public {
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 1, 1 ether);
        Phase2FeeRouteAdapter cheaper = deployAdapter(source, target,
            abi.encodePacked(address(weth), uint24(3000), address(tokenOut)), 1, address(0xBEEF));
        IPhase2RouteSourcePool.ExtData memory redirected = p.data;
        redirected.recipient = address(cheaper);
        redirected.processor = address(cheaper);
        vm.expectRevert(Phase2FeeRouteBase.ActionMismatch.selector);
        cheaper.swap(p.action, p.proof, redirected, p.out);
        Phase2ASPPool.ExtData memory poolData = Phase2ASPPool.ExtData({recipient: address(adapter), feeRecipient: address(0),
            processor: address(adapter), publicIn: 0, publicOut: 1 ether, fee: 0});
        vm.expectRevert(Phase2ASPPool.InvalidProcessor.selector);
        source.transact(p.proof.pA, p.proof.pB, p.proof.pC, p.proof.pubSignals, poolData, p.out);
    }

    /// M2 through the fee adapter: a swap proved before an ASP update still lands.
    function test_inFlightSwapSurvivesPolicyUpdate() public {
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 1, 1 ether);
        skip(5 minutes);
        publish(registry, 2, 7 days);
        (uint256 net,) = adapter.swap(p.action, p.proof, p.data, p.out);
        eq(net, 1 ether - feeOf(1 ether, BPS), 'settled against the superseded epoch');
    }

    function test_targetCapRestoresSourceAndTreasuryAtomically() public {
        vm.prank(GUARDIAN);
        target.setCaps(1 ether, 1 ether);
        fund(target, 0.1 ether);
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 1, 1 ether);
        uint256 sourceRoot = source.currentRoot();
        uint256 targetRoot = target.currentRoot();
        vm.expectRevert(Phase2ASPPool.PoolCapExceeded.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
        check(!source.spentNullifiers(p.proof.pubSignals[5]), 'source note remains spendable');
        eq(source.currentRoot(), sourceRoot, 'source tree restored');
        eq(target.currentRoot(), targetRoot, 'target tree restored');
        eq(source.accountedBalance(), 5 ether, 'source liabilities restored');
        eq(address(source).balance, 5 ether, 'source custody restored');
        eq(target.accountedBalance(), 0.1 ether, 'target liabilities restored');
        eq(tokenOut.balanceOf(address(target)), 0.1 ether, 'target custody restored');
        eq(tokenOut.balanceOf(TREASURY), 0, 'no service fee on reverted swap');
        eq(tokenOut.balanceOf(address(adapter)), 0, 'no adapter output');
        eq(weth.balanceOf(address(adapter)), 0, 'no adapter WETH');
        eq(tokenOut.allowance(address(adapter), address(target)), 0, 'target allowance restored');
    }

    /// Finding F1: a cap equal to the quoted fee made any better-than-quoted
    /// fill revert. The quote default now leaves slippage-sized headroom
    /// (src/phase2-aggregator/amounts.mjs); fills beyond it still revert.
    function testFuzz_F1_capWithSlippageHeadroom(uint256 rate) public {
        rate = bound(rate, 0.99e18, 1.02e18);
        uint128 cap = uint128(feeOf(1.01 ether, BPS)); // 1 ether quoted, 100 bps slippage
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 0.98 ether, cap);
        router.configure(0, rate);
        uint256 fee = feeOf(1 ether * rate / 1e18, BPS);
        if (fee > cap) vm.expectRevert(Phase2FeeRouteBase.ServiceFeeAboveLimit.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
    }

    function test_F1_quotedFeeCapRejectsFavourableFill() public {
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 0.9 ether, uint128(feeOf(1 ether, BPS)));
        router.configure(0, 1.001e18);
        vm.expectRevert(Phase2FeeRouteBase.ServiceFeeAboveLimit.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
    }

    /// Finding L1 also applies here: a ragequit of a fee-adapter note can only
    /// pay the adapter, which has no sweep.
    function test_PoC_L1_ragequitStrandsFeeAdapterNote() public {
        Prepared memory p = prepare(adapter, source, 5 ether, 1 ether, 1, 1 ether);
        (uint256 net, uint256 commitment) = adapter.swap(p.action, p.proof, p.data, p.out);
        check(target.originalDepositor(commitment) == address(adapter), 'depositor is adapter');
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: address(adapter), feeRecipient: address(0), fee: 0});
        target.ragequit(d, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0],
            [commitment, 9_999, net, target.SCOPE(), target.holderExitContext(d)]));
        eq(tokenOut.balanceOf(address(adapter)), net, 'stranded in adapter');
    }
}
