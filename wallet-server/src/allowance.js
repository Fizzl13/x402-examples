// On-chain spending limits for agents (../agent-allowance: FizzlAgentAllowance on Base). The owner's USDC stays in
// the owner's own wallet; the contract tops each agent's wallet up to a small float, within a limit per period, so
// a leaked agent key (or an agent that ignores its rules) can take at most that. This server reads the state for
// the dashboard, builds the transactions the owner signs, and asks for a top-up when an agent needs one: the
// charger wallet pays the gas, so the agent needs no ETH. It holds no keys or money, and a top-up can only move
// USDC from that owner to that agent.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, erc20Abi } from "viem";

const ALLOWANCE = JSON.parse(readFileSync(new URL("./allowance-artifact.json", import.meta.url), "utf8"));
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAY = 86_400;
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const usd = (units) => Number(units) / 1e6;
const units = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw Object.assign(new Error(`${what} must be an amount of USDC above 0`), { status: 400 });
  return BigInt(Math.round(n * 1e6));
};
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * @param {object} o
 * @param {string|null} o.contract   the deployed FizzlAgentAllowance (ALLOWANCE_CONTRACT); null = off
 * @param {(method: string, params: any[]) => Promise<any>} o.rpc   JSON-RPC on Base
 * @param {{ address: string, send(to: string, data: string): Promise<string> }|null} o.charger   pays the gas of top-ups
 */
export function createAllowance({ contract = null, rpc, charger = null, token = USDC_BASE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const busy = new Set(); // owner:agent pairs with a top-up on its way
  const last = new Map(); // owner:agent -> when the last top-up was sent
  const call = async (to, abi, functionName, args) => decodeFunctionResult({ abi, functionName, data: await rpc("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
  const tx = (functionName, args) => ({ to: contract, data: encodeFunctionData({ abi: ALLOWANCE.abi, functionName, args }) });
  const need = () => { if (!contract) throw bad("On-chain limits aren't set up on this server (ALLOWANCE_CONTRACT).", 503); };

  // Everything the dashboard shows for one owner and agent wallet, in dollars.
  async function status(owner, agent) {
    need();
    if (!isAddr(owner) || !isAddr(agent)) throw bad("owner and agent must be 0x… addresses");
    const [[perPeriod, float, period], [topUpNow, left, periodEnds], approval, ownerBalance, agentBalance] = await Promise.all([
      call(contract, ALLOWANCE.abi, "limits", [owner, agent]),
      call(contract, ALLOWANCE.abi, "available", [owner, agent]),
      call(token, erc20Abi, "allowance", [owner, contract]),
      call(token, erc20Abi, "balanceOf", [owner]),
      call(token, erc20Abi, "balanceOf", [agent]),
    ]);
    const on = perPeriod > 0n;
    return {
      contract, owner, agent, on,
      perPeriodUsdc: usd(perPeriod), floatUsdc: usd(float), periodSeconds: Number(period),
      sentThisPeriodUsdc: on ? usd(perPeriod - left) : 0, leftThisPeriodUsdc: usd(left), periodEnds: on ? Number(periodEnds) * 1000 : null,
      topUpNowUsdc: usd(topUpNow), approvalUsdc: usd(approval), ownerBalanceUsdc: usd(ownerBalance), agentBalanceUsdc: usd(agentBalance),
    };
  }

  // The two transactions the owner signs to turn it on: approve the contract for a capped amount, then the limit.
  function turnOnTxs(agent, { perDayUsdc, floatUsdc, approveUsdc }) {
    need();
    if (!isAddr(agent)) throw bad("the agent has no wallet address yet");
    const perDay = units(perDayUsdc, "The limit per day"), float = units(floatUsdc, "The most in the agent's wallet"), approve = units(approveUsdc, "The approval");
    if (float > perDay) throw bad("The most in the agent's wallet can't be more than the limit per day");
    if (approve < perDay) throw bad("The approval must be at least the limit per day");
    return {
      approve: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, approve] }) },
      setLimit: tx("setLimit", [agent, perDay, DAY, float]),
    };
  }

  // Fill the agent's wallet back up to its float, when it needs it: under half the float, or short of what it must
  // pay now. At least $0.10 at a time (unless that is all that is left today) and one a minute per agent, so whoever
  // holds an agent key can't spend the charger's gas on a stream of tiny top-ups.
  async function topUp(owner, agent, { needUsdc = 0 } = {}) {
    need();
    if (!charger) throw bad("Top-ups aren't set up on this server (CHARGER_KEY).", 503);
    const s = await status(owner, agent);
    const want = Math.max(0, Number(needUsdc) || 0);
    const no = (reason) => ({ toppedUp: 0, reason, status: s });
    if (!s.on) return no("there is no on-chain limit for this agent, or it was stopped");
    if (s.agentBalanceUsdc >= s.floatUsdc / 2 && s.agentBalanceUsdc >= want) return no("the agent's wallet has enough");
    if (s.topUpNowUsdc <= 0) return no(s.leftThisPeriodUsdc <= 0 ? `the limit for today is used up (a new day starts ${new Date(s.periodEnds).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "nothing to top up");
    if (s.approvalUsdc < s.topUpNowUsdc) return no("the owner's approval for the contract is used up");
    if (s.ownerBalanceUsdc < s.topUpNowUsdc) return no("the owner's wallet doesn't have enough USDC on Base");
    if (s.topUpNowUsdc < 0.1 && s.topUpNowUsdc < s.leftThisPeriodUsdc) return no("less than $0.10 to top up");
    const key = `${owner}:${agent}`.toLowerCase();
    if (busy.has(key)) return no("a top-up is already on its way");
    if (now() - (last.get(key) ?? 0) < 60_000) return no("the last top-up was less than a minute ago");
    busy.add(key);
    try {
      const { data } = tx("topUp", [owner, agent]);
      await rpc("eth_call", [{ from: charger.address, to: contract, data }, "latest"]); // refused on chain? then don't spend gas on it
      const hash = await charger.send(contract, data);
      last.set(key, now());
      for (let i = 0; i < 30; i++) {
        const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
        if (r) {
          if (r.status !== "0x1") throw bad(`the top-up failed on chain (${hash})`, 502);
          return { toppedUp: s.topUpNowUsdc, tx: hash, status: await status(owner, agent) };
        }
        await sleep(1000);
      }
      return { toppedUp: s.topUpNowUsdc, tx: hash, pending: true, status: s };
    } finally {
      busy.delete(key);
    }
  }

  // For the owner: the transaction that deploys the contract, and the charger's state.
  async function setup() {
    const balance = charger ? await rpc("eth_getBalance", [charger.address, "latest"]).catch(() => "0x0") : null;
    return {
      contract, token,
      deployData: encodeDeployData({ abi: ALLOWANCE.abi, bytecode: ALLOWANCE.bytecode, args: [token] }),
      compiler: ALLOWANCE.compiler,
      charger: charger ? { address: charger.address, balanceEth: Number(BigInt(balance)) / 1e18 } : null,
    };
  }

  return { enabled: Boolean(contract), contract, status, turnOnTxs, stopTx: (agent) => (need(), tx("stop", [agent])), topUp, setup };
}
