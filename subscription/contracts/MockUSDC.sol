// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A minimal ERC-20 with 6 decimals, for tests only.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnFalse;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setReturnFalse(bool v) external { returnFalse = v; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
