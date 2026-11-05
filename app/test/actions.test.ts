import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { availableActions, effectiveArbiter, deadlines } from "../src/lib/actions";
import { fixtureLease } from "./fixtures";

const get = (xs: ReturnType<typeof availableActions>, k: string) => xs.find((x) => x.kind === k);

describe("available actions mirror the program's rules", () => {
  const admin = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;

  it("Created: tenant funds, either party cancels, strangers can't", () => {
    const l = fixtureLease({ status: "Created", funded: 0n });
    expect(get(availableActions(l, l.tenant, 0, admin), "fund")?.enabled).toBe(true);
    expect(get(availableActions(l, l.landlord, 0, admin), "fund")?.enabled).toBe(false);
    expect(get(availableActions(l, l.landlord, 0, admin), "cancel")?.enabled).toBe(true);
    expect(get(availableActions(l, l.tenant, 0, admin), "cancel")?.enabled).toBe(true);
    expect(get(availableActions(l, stranger, 0, admin), "cancel")?.enabled).toBe(false);
    expect(get(availableActions(l, null, 0, admin), "fund")?.reason).toMatch(/Connect/);
  });

  it("Active: claim window inclusive at both ends; auto_refund strictly after", () => {
    const l = fixtureLease({ status: "Active" });
    const end = Number(l.leaseEndTs);
    const cd = end + Number(l.claimWindowSecs);
    const at = (t: number, w: PublicKey) => availableActions(l, w, t, admin);
    expect(get(at(end - 1, l.landlord), "propose")?.enabled).toBe(false);
    expect(get(at(end - 1, l.landlord), "propose")?.opensAt).toBe(end);
    expect(get(at(end, l.landlord), "propose")?.enabled).toBe(true);
    expect(get(at(cd, l.landlord), "propose")?.enabled).toBe(true);
    expect(get(at(cd + 1, l.landlord), "propose")?.enabled).toBe(false);
    expect(get(at(cd, stranger), "auto_refund")?.enabled).toBe(false);
    expect(get(at(cd + 1, stranger), "auto_refund")?.enabled).toBe(true);
    expect(get(at(end, l.tenant), "propose")?.enabled).toBe(false);
    expect(get(at(0, l.tenant), "mutual_release")?.enabled).toBe(true);
  });

  it("DeductionProposed: dispute until deadline (inclusive), auto_accept after", () => {
    const l = fixtureLease({ status: "DeductionProposed", deduction: 1n, proposedTs: 1000n, responseWindowSecs: 100n });
    expect(get(availableActions(l, l.tenant, 1100, admin), "dispute")?.enabled).toBe(true);
    expect(get(availableActions(l, l.tenant, 1101, admin), "dispute")?.enabled).toBe(false);
    expect(get(availableActions(l, stranger, 1100, admin), "auto_accept")?.enabled).toBe(false);
    expect(get(availableActions(l, stranger, 1101, admin), "auto_accept")?.enabled).toBe(true);
    expect(get(availableActions(l, l.tenant, 5000, admin), "accept")?.enabled).toBe(true);
    expect(get(availableActions(l, l.landlord, 5000, admin), "accept")?.enabled).toBe(false);
    expect(deadlines(l).responseDeadline).toBe(1100);
  });

  it("Disputed: named arbiter rules until deadline; timeout after; config admin can't if arbiter named", () => {
    const arb = Keypair.generate().publicKey;
    const l = fixtureLease({ status: "Disputed", deduction: 5n, proposedTs: 1000n, disputedTs: 2000n, arbiterWindowSecs: 50n, arbiter: arb });
    expect(get(availableActions(l, arb, 2050, admin), "resolve")?.enabled).toBe(true);
    expect(get(availableActions(l, arb, 2051, admin), "resolve")?.enabled).toBe(false);
    expect(get(availableActions(l, admin, 2000, admin), "resolve")?.enabled).toBe(false);
    expect(get(availableActions(l, stranger, 2051, admin), "arbiter_timeout")?.enabled).toBe(true);
    expect(get(availableActions(l, stranger, 2050, admin), "arbiter_timeout")?.enabled).toBe(false);
  });

  it("no named arbiter: Config admin is the arbiter, unless the admin is a party", () => {
    const l = fixtureLease({ status: "Disputed", deduction: 5n, disputedTs: 2000n, arbiterWindowSecs: 50n });
    expect(effectiveArbiter(l, admin)?.equals(admin)).toBe(true);
    expect(get(availableActions(l, admin, 2000, admin), "resolve")?.enabled).toBe(true);
    const own = fixtureLease({ status: "Disputed", deduction: 5n, disputedTs: 2000n, arbiterWindowSecs: 50n });
    expect(get(availableActions(own, own.landlord, 2000, own.landlord), "resolve")?.enabled).toBe(false);
    expect(effectiveArbiter(l, null)).toBeNull();
    expect(l.arbiter.equals(PublicKey.default)).toBe(true);
  });
});
