// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title Fizzl wallet Pro, paid automatically
/// @notice A customer approves this contract once (for a capped amount of USDC) and calls subscribe().
///         After that, anyone may call charge(customer) when a period is due. The only thing a charge
///         can do is move `price` from that customer to `payee`, at most once per `period`.
///         There is no owner and nothing can be changed after deployment. A customer stops with
///         cancel() (or by setting their approval to 0); time already paid for is kept.
contract FizzlSubscription {
    IERC20 public immutable token;
    address public immutable payee;
    uint256 public immutable price;
    uint256 public immutable period;

    /// A charge that comes later than this after it was due starts a new period from now
    /// (instead of from the due date), so a customer never pays for time they didn't have.
    uint256 public constant GRACE = 3 days;
    /// subscribe() can start at most this far in the future.
    uint256 public constant MAX_START_DELAY = 400 days;

    /// When the next charge may happen; 0 when not subscribed.
    mapping(address => uint256) public dueAt;
    /// Until when the customer has paid through this contract.
    mapping(address => uint256) public paidThrough;

    event Subscribed(address indexed customer, uint256 firstChargeAt);
    event Charged(address indexed customer, uint256 amount, uint256 paidThrough);
    event Cancelled(address indexed customer, uint256 paidThrough);

    error NotSubscribed();
    error NotDue(uint256 dueAt);
    error StartTooLate();
    error PaymentFailed();
    error BadConfig();

    constructor(IERC20 token_, address payee_, uint256 price_, uint256 period_) {
        if (address(token_) == address(0) || payee_ == address(0) || price_ == 0 || period_ < 1 days) revert BadConfig();
        token = token_;
        payee = payee_;
        price = price_;
        period = period_;
    }

    /// @notice Turn on automatic payment. The first charge is at `startAt`, or now if that has passed,
    ///         or when time already paid through this contract ends. A first charge that is due now
    ///         happens in this same call.
    function subscribe(uint256 startAt) external {
        if (startAt > block.timestamp + MAX_START_DELAY) revert StartTooLate();
        uint256 first = startAt > block.timestamp ? startAt : block.timestamp;
        if (paidThrough[msg.sender] > first) first = paidThrough[msg.sender];
        dueAt[msg.sender] = first;
        emit Subscribed(msg.sender, first);
        if (first <= block.timestamp) _charge(msg.sender);
    }

    /// @notice Take one period's payment from `customer` if it is due. Anyone may call this.
    function charge(address customer) external {
        _charge(customer);
    }

    /// @notice Turn off automatic payment. Time already paid for is kept.
    function cancel() external {
        if (dueAt[msg.sender] == 0) revert NotSubscribed();
        dueAt[msg.sender] = 0;
        emit Cancelled(msg.sender, paidThrough[msg.sender]);
    }

    /// @notice Whether a charge for `customer` can happen now (subscribed and due).
    function isDue(address customer) external view returns (bool) {
        uint256 due = dueAt[customer];
        return due != 0 && block.timestamp >= due;
    }

    function _charge(address customer) private {
        uint256 due = dueAt[customer];
        if (due == 0) revert NotSubscribed();
        if (block.timestamp < due) revert NotDue(due);
        uint256 start = due + GRACE >= block.timestamp ? due : block.timestamp;
        uint256 through = start + period;
        dueAt[customer] = through;
        paidThrough[customer] = through;
        emit Charged(customer, price, through);
        if (!token.transferFrom(customer, payee, price)) revert PaymentFailed();
    }
}
