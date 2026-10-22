// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Spending limits for AI agents, kept by the chain
/// @notice An agent pays from its own wallet, so its key must be on the computer it runs on, where a
///         capable agent (or anyone who copies the key) could sign without the rules of its wallet
///         software. This contract puts the limit on the chain instead: the owner's USDC stays in the
///         owner's own wallet, and the agent's wallet only ever holds a small float.
///
///         The owner approves this contract once, for a capped amount of USDC, and sets per agent wallet:
///         how much may go to it per period, and how much it may hold at once (its float). After that
///         anyone may call topUp(owner, agent). The only thing it can do is fill that agent's wallet back
///         up to its float from the owner's wallet, never more than what is left of the period's limit.
///         Whoever holds the agent's key can take at most the float plus the limit per period, and the
///         owner stops it all with stop(agent), or by setting the approval to 0.
///
///         There is no owner of this contract and nothing can be changed after deployment.
contract FizzlAgentAllowance {
    IERC20 public immutable token;

    /// A period is at least an hour and at most a year.
    uint32 public constant MIN_PERIOD = 1 hours;
    uint32 public constant MAX_PERIOD = 365 days;

    struct Limit {
        uint96 perPeriod; // most that may go to the agent's wallet per period; 0 = stopped
        uint96 float; // a top-up fills the agent's wallet to this balance, no further
        uint32 period; // seconds
        uint32 periodStart; // when the current period began
        uint96 spent; // sent to the agent's wallet in the current period
    }

    /// owner => agent wallet => its limit
    mapping(address => mapping(address => Limit)) public limits;

    event LimitSet(address indexed owner, address indexed agent, uint256 perPeriod, uint256 period, uint256 float);
    event Stopped(address indexed owner, address indexed agent);
    event ToppedUp(address indexed owner, address indexed agent, uint256 amount, uint256 spentThisPeriod);

    error BadConfig();
    error BadLimit();
    error NoLimit();
    error Full();
    error LimitReached(uint256 periodEnds);
    error PaymentFailed();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert BadConfig();
        token = token_;
    }

    /// @notice Set or change the limit for one agent wallet. Changing it keeps what was already sent in the
    ///         current period, so a change can't start a fresh period.
    function setLimit(address agent, uint96 perPeriod, uint32 period, uint96 float) external {
        if (agent == address(0) || agent == msg.sender) revert BadLimit();
        if (perPeriod == 0 || float == 0 || float > perPeriod || period < MIN_PERIOD || period > MAX_PERIOD) revert BadLimit();
        Limit storage l = limits[msg.sender][agent];
        if (l.periodStart == 0) l.periodStart = uint32(block.timestamp);
        l.perPeriod = perPeriod;
        l.float = float;
        l.period = period;
        emit LimitSet(msg.sender, agent, perPeriod, period, float);
    }

    /// @notice Stop all top-ups for one agent wallet. What it already holds stays there.
    function stop(address agent) external {
        Limit storage l = limits[msg.sender][agent];
        if (l.perPeriod == 0) revert NoLimit();
        l.perPeriod = 0;
        emit Stopped(msg.sender, agent);
    }

    /// @notice Fill `agent`'s wallet back up to its float from `owner`'s wallet, within the period's limit.
    ///         Anyone may call this: the money only ever goes from that owner to that agent.
    function topUp(address owner, address agent) external returns (uint256 amount) {
        Limit storage l = limits[owner][agent];
        if (l.perPeriod == 0) revert NoLimit();
        if (block.timestamp >= uint256(l.periodStart) + l.period) {
            l.periodStart = uint32(block.timestamp);
            l.spent = 0;
        }
        uint256 balance = token.balanceOf(agent);
        if (balance >= l.float) revert Full();
        uint256 left = l.perPeriod > l.spent ? l.perPeriod - l.spent : 0;
        if (left == 0) revert LimitReached(uint256(l.periodStart) + l.period);
        amount = l.float - balance;
        if (amount > left) amount = left;
        l.spent += uint96(amount);
        emit ToppedUp(owner, agent, amount, l.spent);
        if (!token.transferFrom(owner, agent, amount)) revert PaymentFailed();
    }

    /// @notice What a top-up would send now, what is left of this period's limit, and when the period ends.
    function available(address owner, address agent) external view returns (uint256 topUpNow, uint256 leftThisPeriod, uint256 periodEnds) {
        Limit memory l = limits[owner][agent];
        if (l.perPeriod == 0) return (0, 0, 0);
        periodEnds = uint256(l.periodStart) + l.period;
        uint256 spent = l.spent;
        if (block.timestamp >= periodEnds) {
            spent = 0;
            periodEnds = block.timestamp + l.period;
        }
        leftThisPeriod = l.perPeriod > spent ? l.perPeriod - spent : 0;
        uint256 balance = token.balanceOf(agent);
        topUpNow = balance >= l.float ? 0 : l.float - balance;
        if (topUpNow > leftThisPeriod) topUpNow = leftThisPeriod;
    }
}
