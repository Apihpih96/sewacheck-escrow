import { PublicKey } from "@solana/web3.js";
import type { Lease } from "./codec";
import type { ActionKind } from "./tx";

export type Role = "landlord" | "tenant" | "party" | "arbiter" | "anyone";

export interface ActionState {
  kind: ActionKind;
  /** Who can sign it. */
  role: Role;
  /** Valid right now for the connected wallet (status, signer, and time all OK). */
  enabled: boolean;
  /** Why it is not available yet / any more, when disabled. */
  reason?: string;
  /** Unix seconds when it becomes valid (for countdowns), if time-gated. */
  opensAt?: number;
}

export interface Deadlines {
  leaseEnd: number;
  claimDeadline: number; // last second a deduction can be proposed (inclusive)
  responseDeadline?: number; // last second the tenant can dispute (inclusive)
  arbiterDeadline?: number; // last second the arbiter can rule (inclusive)
}

export function deadlines(l: Lease): Deadlines {
  const leaseEnd = Number(l.leaseEndTs);
  const out: Deadlines = { leaseEnd, claimDeadline: leaseEnd + Number(l.claimWindowSecs) };
  if (l.status === "DeductionProposed" || l.status === "Disputed")
    out.responseDeadline = Number(l.proposedTs) + Number(l.responseWindowSecs);
  if (l.status === "Disputed") out.arbiterDeadline = Number(l.disputedTs) + Number(l.arbiterWindowSecs);
  return out;
}

/** The arbiter that can sign resolve_dispute: the named one, else the Config admin. */
export function effectiveArbiter(l: Lease, configAdmin: PublicKey | null): PublicKey | null {
  if (!l.arbiter.equals(PublicKey.default)) return l.arbiter;
  return configAdmin;
}

/**
 * Every action that makes sense for the lease's status, flagged enabled only when the
 * program would accept it from `wallet` at `now` (chain time, unix seconds). Mirrors the
 * windows in lib.rs exactly: claim end<=now<=end+claim, auto_refund now>end+claim,
 * dispute now<=proposed+resp, auto_accept now>proposed+resp, resolve now<=disputed+arb,
 * arbiter_timeout now>disputed+arb.
 */
export function availableActions(
  l: Lease,
  wallet: PublicKey | null,
  now: number,
  configAdmin: PublicKey | null,
): ActionState[] {
  const isL = !!wallet && wallet.equals(l.landlord);
  const isT = !!wallet && wallet.equals(l.tenant);
  const arb = effectiveArbiter(l, configAdmin);
  const isA = !!wallet && !!arb && wallet.equals(arb);
  const d = deadlines(l);
  const out: ActionState[] = [];
  const add = (
    kind: ActionKind,
    role: Role,
    who: boolean,
    timeOk: boolean,
    timeReason?: string,
    opensAt?: number,
  ) => {
    const roleText =
      role === "anyone" ? "any connected wallet" : role === "party" ? "the landlord or tenant" : `the ${role}`;
    let reason: string | undefined;
    if (!wallet) reason = "Connect a wallet";
    else if (!who) reason = `Only ${roleText} can do this`;
    else if (!timeOk) reason = timeReason;
    out.push({ kind, role, enabled: !!wallet && who && timeOk, reason, opensAt });
  };

  switch (l.status) {
    case "Created":
      add("fund", "tenant", isT, l.funded < l.amount, "Already fully funded");
      add("cancel", "party", isL || isT, true);
      break;
    case "Active":
      add(
        "propose",
        "landlord",
        isL,
        now >= d.leaseEnd && now <= d.claimDeadline,
        now < d.leaseEnd ? "Opens when the lease ends" : "Claim window has closed",
        now < d.leaseEnd ? d.leaseEnd : undefined,
      );
      add(
        "auto_refund",
        "anyone",
        !!wallet,
        now > d.claimDeadline,
        "Available after the claim window ends with no claim",
        d.claimDeadline + 1,
      );
      add("mutual_release", "party", isL || isT, true);
      break;
    case "DeductionProposed": {
      const rd = d.responseDeadline ?? 0;
      add("accept", "tenant", isT, true);
      add("dispute", "tenant", isT, now <= rd, "Response window has closed");
      add("auto_accept", "anyone", !!wallet, now > rd, "Available after the tenant's response window", rd + 1);
      add("mutual_release", "party", isL || isT, true);
      break;
    }
    case "Disputed": {
      const ad = d.arbiterDeadline ?? 0;
      const arbIsParty = !!arb && (arb.equals(l.landlord) || arb.equals(l.tenant));
      add(
        "resolve",
        "arbiter",
        isA && !arbIsParty,
        now <= ad,
        "Arbiter window has closed",
      );
      add(
        "arbiter_timeout",
        "anyone",
        !!wallet,
        now > ad,
        "Available if the arbiter has not ruled by the deadline",
        ad + 1,
      );
      add("mutual_release", "party", isL || isT, true);
      break;
    }
    default:
      break;
  }
  return out;
}

export function roleOf(l: Lease, wallet: PublicKey | null, configAdmin: PublicKey | null): Role | null {
  if (!wallet) return null;
  if (wallet.equals(l.landlord)) return "landlord";
  if (wallet.equals(l.tenant)) return "tenant";
  const arb = effectiveArbiter(l, configAdmin);
  if (arb && wallet.equals(arb)) return "arbiter";
  return "anyone";
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  fund: "Fund deposit",
  cancel: "Cancel lease",
  propose: "Propose a deduction",
  accept: "Accept deduction",
  dispute: "Dispute deduction",
  resolve: "Resolve dispute",
  auto_accept: "Finalise (tenant did not respond)",
  auto_refund: "Refund tenant (no claim made)",
  arbiter_timeout: "Refund tenant (arbiter did not rule)",
  mutual_release: "Release by agreement",
};

export const STATUS_TEXT: Record<Lease["status"], string> = {
  Created: "Waiting for the tenant to fund",
  Active: "Deposit locked in escrow",
  DeductionProposed: "Landlord proposed a deduction",
  Disputed: "Deduction disputed — waiting for the arbiter",
  Settled: "Settled",
  Cancelled: "Cancelled",
};
