import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../src/idl/sewacheck_escrow.json";
import {
  buildActionIxs,
  createLeaseIx,
  fundDepositIx,
  cancelLeaseIx,
  autoRefundIx,
  arbiterTimeoutIx,
  proposeDeductionIx,
  disputeIx,
  acceptDeductionIx,
  autoAcceptIx,
  resolveDisputeIx,
  mutualReleaseIx,
  leaseAddresses,
} from "../src/lib/tx";
import { ixDiscriminator } from "../src/lib/codec";
import { configPda, leasePda, usdcAta, vaultPda } from "../src/lib/pda";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT } from "../src/lib/constants";
import { fixtureLease } from "./fixtures";

const idlIx = (name: string) => idl.instructions.find((i) => i.name === name)!;

/** Every builder must match the IDL's account count, order of signer/writable flags. */
function expectMatchesIdl(name: string, keys: { isSigner: boolean; isWritable: boolean }[]) {
  const accs = idlIx(name).accounts;
  expect(keys.length).toBe(accs.length);
  accs.forEach((a, i) => {
    expect({ n: a.name, s: keys[i]!.isSigner, w: keys[i]!.isWritable }).toEqual({
      n: a.name,
      s: Boolean((a as { signer?: boolean }).signer),
      w: Boolean((a as { writable?: boolean }).writable),
    });
  });
}

describe("instruction builders", () => {
  const l = fixtureLease();
  const caller = Keypair.generate().publicKey;
  const a = leaseAddresses(l);

  it("create_lease: 8 args, accounts and data layout", () => {
    const arbiter = Keypair.generate().publicKey;
    const { ix, lease } = createLeaseIx({
      landlord: l.landlord,
      tenant: l.tenant,
      leaseId: 1793774376n,
      amount: 1_000_000n,
      leaseEndTs: 1_800_000_000n,
      arbiter,
      termsHash: new Uint8Array(32).fill(9),
      claimWindowSecs: 600n,
      responseWindowSecs: 601n,
      arbiterWindowSecs: 602n,
    });
    expect(idlIx("create_lease").args.length).toBe(8);
    expectMatchesIdl("create_lease", ix.keys);
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(lease.equals(leasePda(l.landlord, l.tenant, 1793774376n))).toBe(true);
    const k = ix.keys.map((x) => x.pubkey.toBase58());
    expect(k).toEqual([
      l.landlord.toBase58(),
      l.tenant.toBase58(),
      configPda().toBase58(),
      USDC_MINT.toBase58(),
      lease.toBase58(),
      vaultPda(lease).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    const d = Buffer.from(ix.data);
    expect(d.length).toBe(8 + 8 + 8 + 8 + 32 + 32 + 8 * 3);
    expect(d.subarray(0, 8).equals(Buffer.from(ixDiscriminator("create_lease")))).toBe(true);
    expect(d.readBigUInt64LE(8)).toBe(1793774376n);
    expect(d.readBigUInt64LE(16)).toBe(1_000_000n);
    expect(d.readBigInt64LE(24)).toBe(1_800_000_000n);
    expect(new PublicKey(d.subarray(32, 64)).equals(arbiter)).toBe(true);
    expect(d.subarray(64, 96).every((x) => x === 9)).toBe(true);
    expect([d.readBigInt64LE(96), d.readBigInt64LE(104), d.readBigInt64LE(112)]).toEqual([600n, 601n, 602n]);
  });

  it("create_lease defaults: no arbiter = default pubkey, zero windows, zero terms", () => {
    const { ix } = createLeaseIx({ landlord: l.landlord, tenant: l.tenant, leaseId: 1n, amount: 1n, leaseEndTs: 2n });
    const d = Buffer.from(ix.data);
    expect(new PublicKey(d.subarray(32, 64)).equals(PublicKey.default)).toBe(true);
    expect(d.subarray(64).every((x) => x === 0)).toBe(true);
  });

  it("every builder matches the IDL account flags", () => {
    expectMatchesIdl("fund_deposit", fundDepositIx(l, 1n).keys);
    expectMatchesIdl("cancel_lease", cancelLeaseIx(l, caller).keys);
    expectMatchesIdl("auto_refund", autoRefundIx(l, caller).keys);
    expectMatchesIdl("arbiter_timeout", arbiterTimeoutIx(l, caller).keys);
    expectMatchesIdl("propose_deduction", proposeDeductionIx(l, 1n, new Uint8Array(32).fill(1)).keys);
    expectMatchesIdl("dispute", disputeIx(l).keys);
    expectMatchesIdl("accept_deduction", acceptDeductionIx(l).keys);
    expectMatchesIdl("auto_accept", autoAcceptIx(l, caller).keys);
    expectMatchesIdl("resolve_dispute", resolveDisputeIx(l, caller, 1n).keys);
    expectMatchesIdl("mutual_release", mutualReleaseIx(l, 1n).keys);
  });

  it("payout accounts use the parties' USDC ATAs and the vault PDA", () => {
    const ix = resolveDisputeIx(l, caller, 5n);
    const k = ix.keys.map((x) => x.pubkey);
    expect(k[0]!.equals(caller)).toBe(true);
    expect(k[1]!.equals(configPda())).toBe(true);
    expect(k[2]!.equals(a.lease)).toBe(true);
    expect(k[3]!.equals(l.landlord)).toBe(true);
    expect(k[5]!.equals(usdcAta(l.landlord))).toBe(true);
    expect(k[6]!.equals(usdcAta(l.tenant))).toBe(true);
    expect(k[7]!.equals(vaultPda(a.lease))).toBe(true);
    expect(Buffer.from(ix.data).readBigUInt64LE(8)).toBe(5n);
  });

  it("propose_deduction encodes amount + evidence and rejects bad hashes", () => {
    const h = new Uint8Array(32).fill(3);
    const d = Buffer.from(proposeDeductionIx(l, 250_000n, h).data);
    expect(d.readBigUInt64LE(8)).toBe(250_000n);
    expect(d.subarray(16).every((x) => x === 3)).toBe(true);
    expect(() => proposeDeductionIx(l, 1n, new Uint8Array(31))).toThrow();
  });

  it("u64 args keep full precision above 2^53", () => {
    const big = (1n << 64n) - 1n;
    expect(Buffer.from(fundDepositIx(l, big).data).readBigUInt64LE(8)).toBe(big);
  });

  it("payout actions create missing recipient ATAs first (idempotent)", () => {
    const signer = l.tenant;
    const atasOf = (kind: Parameters<typeof buildActionIxs>[0], p = {}) =>
      buildActionIxs(kind, l, signer, p)
        .filter((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
        .map((i) => {
          expect(Array.from(i.data)).toEqual([1]); // CreateIdempotent
          expect(i.keys[0]!.pubkey.equals(signer)).toBe(true); // signer pays
          return i.keys[1]!.pubkey.toBase58();
        });
    const L = usdcAta(l.landlord).toBase58();
    const T = usdcAta(l.tenant).toBase58();
    expect(atasOf("accept")).toEqual([L, T]);
    expect(atasOf("auto_accept")).toEqual([L, T]);
    expect(atasOf("resolve", { toLandlord: 1n })).toEqual([L, T]);
    expect(atasOf("mutual_release", { toLandlord: 1n })).toEqual([L, T]);
    expect(atasOf("cancel")).toEqual([T]);
    expect(atasOf("auto_refund")).toEqual([T]);
    expect(atasOf("arbiter_timeout")).toEqual([T]);
    expect(atasOf("fund", { amount: 1n })).toEqual([T]);
    expect(atasOf("dispute")).toEqual([]);
  });

  it("missing params throw instead of sending zero", () => {
    expect(() => buildActionIxs("fund", l, l.tenant)).toThrow(/amount/);
    expect(() => buildActionIxs("resolve", l, caller)).toThrow(/ruling/);
    expect(() => buildActionIxs("propose", l, l.landlord, { deduction: 1n })).toThrow(/evidence/);
  });
});
