// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';

/// @dev Minimal cheatcode surface; forge-std is not vendored in this repository.
interface Vm {
    function warp(uint256) external;
    function getBlockTimestamp() external view returns (uint256);
    function chainId(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function assume(bool) external;
    function label(address, string calldata) external;
}

/// @dev Accepts every proof. These suites test contract accounting and
/// authorization assuming a sound circuit, never proof soundness itself.
contract MockJoinSplitVerifier {
    bool public result = true;
    function set(bool next) external { result = next; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[9] calldata)
        external view returns (bool) { return result; }
}

contract MockExitVerifier {
    bool public result = true;
    function set(bool next) external { result = next; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external view returns (bool) { return result; }
}

contract MockToken is ERC20 {
    constructor(string memory name) ERC20(name, name) {}
    function mint(address receiver, uint256 amount) external { _mint(receiver, amount); }
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address internal constant PROVIDER = address(0xA5B);
    address internal constant GUARDIAN = address(0x6A2D);
    uint256 internal constant START = 1_800_000_000;

    error AssertionFailed(string message);

    /// @dev via-IR may cache block.timestamp across vm.warp; always ask the VM.
    function now_() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function skip(uint256 seconds_) internal {
        vm.warp(now_() + seconds_);
    }

    function check(bool condition, string memory message) internal pure {
        if (!condition) revert AssertionFailed(message);
    }

    function eq(uint256 a, uint256 b, string memory message) internal pure {
        if (a != b) revert AssertionFailed(message);
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + x % (max - min + 1);
    }

    function cipher(uint256 seed) internal pure returns (bytes memory out) {
        out = new bytes(256);
        bytes32 word = keccak256(abi.encode(seed));
        assembly ('memory-safe') { mstore(add(out, 0x20), word) }
    }

    function outputs(uint256 seed) internal pure returns (bytes[2] memory pair) {
        pair[0] = cipher(seed);
        pair[1] = cipher(seed + 1);
    }

    function deployRegistry() internal returns (Phase2ASPRegistry registry) {
        vm.chainId(4663);
        vm.warp(START);
        registry = new Phase2ASPRegistry(PROVIDER, GUARDIAN);
    }

    function publish(Phase2ASPRegistry registry, uint256 root, uint64 lifetime) internal {
        vm.prank(PROVIDER);
        registry.updateRoot(root, keccak256(abi.encode(root, now_())), uint64(now_()) + lifetime);
    }

    function signals(Phase2ASPPool pool, uint256 context, uint256 nf0, uint256 nf1, uint256 out0, uint256 out1,
        uint256 publicOut) internal view returns (uint256[9] memory s)
    {
        s = [pool.currentRoot(), 0, publicOut, context, pool.SCOPE(), nf0, nf1, out0, out1];
    }

    function selfData(uint128 publicOut, address recipient) internal view returns (Phase2ASPPool.ExtData memory) {
        return Phase2ASPPool.ExtData({recipient: recipient, feeRecipient: address(0), processor: address(this),
            publicIn: 0, publicOut: publicOut, fee: 0});
    }
}
