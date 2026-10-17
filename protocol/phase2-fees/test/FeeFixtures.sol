// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @dev Explicit component-test fixtures. No fixture checks a ZK proof.
contract FeeTestToken is ERC20 {
    address public taxRecipient;
    constructor(string memory name) ERC20(name, name) {}
    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
    function configureTax(address recipient) external { taxRecipient = recipient; }
    function _update(address from, address to, uint256 amount) internal override {
        if (to != address(0) && to == taxRecipient && from != address(0) && amount > 0) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else super._update(from, to, amount);
    }
}

contract FeeTestWrapped is ERC20 {
    constructor() ERC20('Wrapped Test Native', 'WTN') {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}(''); require(ok);
    }
}

contract FeeTestSource {
    address public immutable ASSET;
    uint256 public withdrawals;
    mapping(uint256 => bool) public spent;
    struct ExtData { address recipient; address feeRecipient; address processor; uint128 publicIn; uint128 publicOut; uint128 fee; }
    constructor(address asset) { ASSET = asset; }
    receive() external payable {}
    function transact(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata,
        uint256[9] calldata signals, ExtData calldata data, bytes[2] calldata) external payable
    {
        require(msg.value == 0 && data.processor == msg.sender && data.recipient == msg.sender);
        require(data.publicIn == 0 && data.fee == 0 && data.publicOut == signals[2]);
        require(!spent[signals[5]] && !spent[signals[6]] && signals[5] != signals[6]);
        spent[signals[5]] = true; spent[signals[6]] = true; withdrawals++;
        if (ASSET == address(0)) { (bool ok,) = payable(msg.sender).call{value: data.publicOut}(''); require(ok); }
        else require(IERC20(ASSET).transfer(msg.sender, data.publicOut));
    }
}

contract FeeTestTarget {
    address public immutable ASSET;
    uint256 public deposits;
    uint256 public lastValue;
    uint256 public totalDeposited;
    uint8 public mode;
    constructor(address asset) { ASSET = asset; }
    function configure(uint8 value) external { mode = value; }
    function depositDynamic(uint128 amount, uint256 precommitment, bytes calldata encryptedTemplate)
        external payable returns (uint256 commitment)
    {
        require(mode != 1, 'TARGET_REVERT');
        require(amount > 0 && encryptedTemplate.length == 256);
        if (ASSET == address(0)) require(msg.value == amount);
        else { require(msg.value == 0); require(IERC20(ASSET).transferFrom(msg.sender, address(this), mode == 2 ? amount - 1 : amount)); }
        deposits++; lastValue = amount; totalDeposited += amount;
        return uint256(keccak256(abi.encode(amount, precommitment)));
    }
}

contract FeeTestHopPool {
    receive() external payable {}
    function pay(address token, address recipient, uint256 amount) external { require(IERC20(token).transfer(recipient, amount)); }
}

contract FeeTestFactory {
    address public immutable A; address public immutable B; address public immutable C;
    address public immutable firstPool; address public immutable secondPool;
    constructor(address a, address b, address c, address first, address second) { A = a; B = b; C = c; firstPool = first; secondPool = second; }
    function _getPool(address a, address b) internal view returns (address) {
        if ((a == A && b == B) || (a == B && b == A)) return firstPool;
        if ((a == B && b == C) || (a == C && b == B)) return secondPool;
        return address(0);
    }
    function getPool(address a, address b, uint24) external view returns (address) { return _getPool(a, b); }
    function getPool(address a, address b, int24) external view returns (address) { return _getPool(a, b); }
}

contract FeeTestRouter {
    address public immutable factory; address public immutable WETH9;
    IERC20 public immutable A; FeeTestToken public immutable B; IERC20 public immutable C;
    address public immutable firstPool; address public immutable secondPool;
    uint8 public mode; uint256 public actualOutput; uint256 public reportedOutput; address public drainToken;
    uint256 public lastMinimum; uint256 public deadlineCalls; uint256 public router02Calls;
    struct Params { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }
    struct Params02 { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    constructor(address f, address w, address a, address b, address c, address first, address second) {
        factory = f; WETH9 = w; A = IERC20(a); B = FeeTestToken(b); C = IERC20(c); firstPool = first; secondPool = second;
    }
    receive() external payable {}
    function configure(uint8 nextMode, uint256 actual, uint256 reported, address drain) external {
        mode = nextMode; actualOutput = actual; reportedOutput = reported; drainToken = drain;
    }
    function exactInput(Params calldata p) external payable returns (uint256) {
        require(p.deadline >= block.timestamp); deadlineCalls++;
        return _swap(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }
    function exactInput(Params02 calldata p) external payable returns (uint256) {
        router02Calls++;
        return _swap(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }
    function _swap(bytes calldata path, address recipient, uint256 amountIn, uint256 amountOutMinimum) internal returns (uint256) {
        require(msg.value == 0 && path.length == 66); require(mode != 4, 'ROUTER_REVERT');
        lastMinimum = amountOutMinimum;
        require(A.transferFrom(msg.sender, firstPool, mode == 1 ? amountIn / 2 : amountIn));
        B.mint(address(this), amountIn);
        require(B.transfer(secondPool, mode == 2 ? amountIn / 2 : amountIn));
        if (mode == 3) require(IERC20(drainToken).transfer(secondPool, 1));
        if (mode == 5) { (bool ok,) = payable(secondPool).call{value: 1}(''); require(ok); }
        FeeTestHopPool(payable(secondPool)).pay(address(C), recipient, actualOutput);
        // Intentionally ignores minimum and lies on demand: adapter must measure real output.
        return reportedOutput;
    }
}

contract FeeTestForceEther {
    constructor(address payable recipient) payable { selfdestruct(recipient); }
}
