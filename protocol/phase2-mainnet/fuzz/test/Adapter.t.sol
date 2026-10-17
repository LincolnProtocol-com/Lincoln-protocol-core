// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Base, MockJoinSplitVerifier, MockExitVerifier, MockToken} from './Base.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';
import {Phase2RouteAdapter, IPhase2RouteSourcePool} from '../../contracts/Phase2RouteAdapter.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

contract MockWETH is ERC20 {
    constructor() ERC20('WETH', 'WETH') {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount); // WETH9 forwards a 2300-gas stipend.
    }
}

contract HopPool {
    function pay(address token, address to, uint256 amount) external { MockToken(token).mint(to, amount); }
}

contract MockFactory {
    address public immutable hop;
    constructor(address hop_) { hop = hop_; }
    function getPool(address, address, uint24) external view returns (address) { return hop; }
}

/// @dev Exact-input router with injectable misbehaviour; it never enforces
/// amountOutMinimum, so the adapter's own measurement is what is tested.
contract MockRouter {
    address public immutable factory;
    address public immutable WETH9;
    address public immutable hop;
    uint8 public mode; // 0 honest, 1 partial pull, 2 router keeps residual, 3 overreport only
    uint256 public rate = 1e18;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    constructor(address factory_, address weth, address hop_) { factory = factory_; WETH9 = weth; hop = hop_; }

    function configure(uint8 nextMode, uint256 nextRate) external { mode = nextMode; rate = nextRate; }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        require(p.deadline >= block.timestamp, 'deadline');
        address tokenIn = address(bytes20(p.path[0:20]));
        address tokenOut = address(bytes20(p.path[23:43]));
        uint256 pulled = mode == 1 ? p.amountIn / 2 : p.amountIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pulled);
        uint256 forwarded = mode == 2 ? pulled - pulled / 3 : pulled;
        IERC20(tokenIn).transfer(hop, forwarded);
        out = forwarded * rate / 1e18;
        HopPool(hop).pay(tokenOut, p.recipient, out);
        if (mode == 3) return out * 2;
    }
}

contract AdapterTest is Base {
    Phase2ASPRegistry internal registry;
    Phase2ASPPool internal source;
    Phase2ASPPool internal target;
    MockToken internal tokenOut;
    MockWETH internal weth;
    MockRouter internal router;
    Phase2RouteAdapter internal adapter;
    uint256 internal nonce;

    receive() external payable {}

    function setUp() public {
        registry = deployRegistry();
        MockJoinSplitVerifier verifier = new MockJoinSplitVerifier();
        MockExitVerifier exitVerifier = new MockExitVerifier();
        tokenOut = new MockToken('OUT');
        weth = new MockWETH();
        source = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(0));
        target = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(tokenOut));
        HopPool hop = new HopPool();
        router = new MockRouter(address(new MockFactory(address(hop))), address(weth), address(hop));
        adapter = new Phase2RouteAdapter(address(source), address(target), address(router), address(weth), 0,
            abi.encodePacked(address(weth), uint24(3000), address(tokenOut)));
        publish(registry, 1, 7 days);
        vm.deal(address(this), 1_000_000 ether);
    }

    struct Prepared {
        Phase2RouteAdapter.Action action;
        Phase2RouteAdapter.Proof proof;
        IPhase2RouteSourcePool.ExtData data;
        bytes[2] out;
    }

    function prepare(uint128 noteValue, uint128 amountIn, uint128 minOut) internal returns (Prepared memory p) {
        source.depositDynamic{value: noteValue}(noteValue, ++nonce, cipher(nonce));
        p.action = Phase2RouteAdapter.Action({processor: address(this), amountIn: amountIn, minAmountOut: minOut,
            deadline: now_() + 1 hours, targetPrecommitment: ++nonce, encryptedTemplate: cipher(nonce)});
        p.out[0] = cipher(++nonce);
        p.out[1] = adapter.actionEnvelope(p.action);
        p.data = IPhase2RouteSourcePool.ExtData({recipient: address(adapter), feeRecipient: address(0),
            processor: address(adapter), publicIn: 0, publicOut: amountIn, fee: 0});
        Phase2ASPPool.ExtData memory poolData = Phase2ASPPool.ExtData({recipient: address(adapter), feeRecipient: address(0),
            processor: address(adapter), publicIn: 0, publicOut: amountIn, fee: 0});
        uint128 change = noteValue - amountIn;
        p.proof.pubSignals = [source.currentRoot(), 0, uint256(amountIn), source.hashContext(poolData, p.out), source.SCOPE(),
            ++nonce, ++nonce, change == 0 ? 0 : ++nonce, 0];
    }

    function testFuzz_swapIsExactOrReverts(uint128 noteValue, uint128 amountIn, uint256 rate, uint128 minOut, uint8 mode)
        public
    {
        noteValue = uint128(bound(noteValue, 2, 100 ether));
        amountIn = uint128(bound(amountIn, 1, noteValue));
        rate = bound(rate, 0, 5e18);
        minOut = uint128(bound(minOut, 1, uint256(amountIn) * 5));
        mode = uint8(bound(mode, 0, 3));
        router.configure(mode, rate);
        Prepared memory p = prepare(noteValue, amountIn, minOut);
        uint256 pulled = mode == 1 ? amountIn / 2 : amountIn;
        uint256 forwarded = mode == 2 ? pulled - pulled / 3 : pulled;
        uint256 expectedOut = forwarded * rate / 1e18;
        // Honest iff the whole input reached the hop pool, whatever the mode label.
        bool shouldSucceed = forwarded == amountIn && expectedOut >= minOut;
        uint256 targetBefore = tokenOut.balanceOf(address(target));
        uint256 sourceBefore = address(source).balance;

        try adapter.swap(p.action, p.proof, p.data, p.out) returns (uint256 amountOut, uint256 commitment) {
            check(shouldSucceed, 'adapter accepted a residual, short or under-minimum swap');
            eq(amountOut, expectedOut, 'measured, not reported, output');
            eq(tokenOut.balanceOf(address(target)), targetBefore + amountOut, 'target custody');
            eq(commitment, PoseidonT3.hash([amountOut, p.action.targetPrecommitment]), 'target note value');
            check(target.commitments(commitment), 'target note inserted');
            eq(address(source).balance, sourceBefore - amountIn, 'source custody');
            check(source.spentNullifiers(p.proof.pubSignals[5]), 'source spent');
        } catch {
            check(!shouldSucceed, 'honest swap reverted');
            eq(tokenOut.balanceOf(address(target)), targetBefore, 'atomic target');
            eq(address(source).balance, sourceBefore, 'atomic source');
            check(!source.spentNullifiers(p.proof.pubSignals[5]), 'atomic nullifier');
        }
        eq(weth.balanceOf(address(adapter)), 0, 'no adapter residual');
        eq(tokenOut.balanceOf(address(adapter)), 0, 'no adapter output residual');
        eq(address(adapter).balance, 0, 'no adapter ETH');
    }

    function testFuzz_actionCannotBeSwappedAfterProving(uint8 field, uint256 value) public {
        Prepared memory p = prepare(5 ether, 1 ether, 1);
        field = uint8(bound(field, 0, 3));
        if (field == 0) p.action.minAmountOut = uint128(bound(value, 2, type(uint128).max));
        if (field == 1) p.action.targetPrecommitment = bound(value, 1, FIELD - 1);
        if (field == 2) p.action.deadline = p.action.deadline + bound(value, 1, 365 days);
        if (field == 3) p.action.encryptedTemplate = cipher(value);
        vm.assume(keccak256(adapter.actionEnvelope(p.action)) != keccak256(p.out[1]));
        vm.expectRevert(Phase2RouteAdapter.ActionMismatch.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
    }

    function testFuzz_onlyActionProcessor(address caller) public {
        vm.assume(caller != address(this));
        Prepared memory p = prepare(5 ether, 1 ether, 1);
        vm.prank(caller);
        vm.expectRevert(Phase2RouteAdapter.InvalidProcessor.selector);
        adapter.swap(p.action, p.proof, p.data, p.out);
    }

    function test_proofCannotBypassAdapter() public {
        Prepared memory p = prepare(5 ether, 1 ether, 1);
        Phase2ASPPool.ExtData memory poolData = Phase2ASPPool.ExtData({recipient: address(adapter), feeRecipient: address(0),
            processor: address(adapter), publicIn: 0, publicOut: 1 ether, fee: 0});
        vm.expectRevert(Phase2ASPPool.InvalidProcessor.selector);
        source.transact(p.proof.pA, p.proof.pB, p.proof.pC, p.proof.pubSignals, poolData, p.out);
    }

    /// PoC for audit finding L1 (unchanged): ragequit of an adapter-created
    /// note can only pay the adapter, where ERC20 output is stranded forever.
    function test_PoC_L1_ragequitStrandsAdapterNote() public {
        Prepared memory p = prepare(5 ether, 1 ether, 1);
        (, uint256 commitment) = adapter.swap(p.action, p.proof, p.data, p.out);
        check(target.originalDepositor(commitment) == address(adapter), 'depositor is adapter');
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: address(adapter), feeRecipient: address(0), fee: 0});
        target.ragequit(d, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0],
            [commitment, 9_999, 1 ether, target.SCOPE(), target.holderExitContext(d)]));
        eq(tokenOut.balanceOf(address(adapter)), 1 ether, 'stranded in adapter; no sweep exists');
    }
}
