import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { buildMutualRelease, encodeMutualFragment, parseMutualFragment, validateMutualRelease } from "../src/lib/mutual";
import { leasePda } from "../src/lib/pda";
import { fixtureLease } from "./fixtures";

const BH = "11111111111111111111111111111111";

function setup() {
  const landlord = Keypair.generate();
  const tenant = Keypair.generate();
  const l = fixtureLease({ landlord: landlord.publicKey, tenant: tenant.publicKey, funded: 1_000_000n, amount: 1_000_000n });
  const addr = leasePda(l.landlord, l.tenant, l.leaseId);
  return { landlord, tenant, l, addr };
}

describe("mutual_release two-signer flow", () => {
  it("landlord signs, link round-trips, tenant validates the split", () => {
    const { landlord, tenant, l, addr } = setup();
    const tx = buildMutualRelease(l, landlord.publicKey, 300_000n, BH, 1234);
    tx.partialSign(landlord);
    const frag = encodeMutualFragment(tx, 1234);
    expect(frag).toMatch(/^mr=[A-Za-z0-9_-]+&h=1234$/);
    const draft = parseMutualFragment(`#${frag}`)!;
    expect(draft.lastValidBlockHeight).toBe(1234);
    const v = validateMutualRelease(draft.tx, l, addr, tenant.publicKey);
    expect(v.toLandlord).toBe(300_000n);
    expect(v.toTenant).toBe(700_000n);
    // tenant co-signs: now fully signed
    draft.tx.partialSign(tenant);
    expect(draft.tx.verifySignatures(true)).toBe(true);
  });

  it("rejects an unsigned request, own request, and outsiders", () => {
    const { landlord, tenant, l, addr } = setup();
    const unsigned = buildMutualRelease(l, landlord.publicKey, 0n, BH, 1);
    expect(() => validateMutualRelease(unsigned, l, addr, tenant.publicKey)).toThrow(/not signed/);
    const signed = buildMutualRelease(l, landlord.publicKey, 0n, BH, 1);
    signed.partialSign(landlord);
    expect(() => validateMutualRelease(signed, l, addr, landlord.publicKey)).toThrow(/your own wallet/);
    expect(() => validateMutualRelease(signed, l, addr, Keypair.generate().publicKey)).toThrow(/landlord or tenant/);
    expect(() => buildMutualRelease(l, Keypair.generate().publicKey, 0n, BH, 1)).toThrow();
    expect(() => buildMutualRelease(l, landlord.publicKey, l.funded + 1n, BH, 1)).toThrow();
  });

  it("rejects a crafted link with an extra transfer instruction", () => {
    const { landlord, tenant, l, addr } = setup();
    const tx = buildMutualRelease(l, landlord.publicKey, 0n, BH, 1);
    tx.add(SystemProgram.transfer({ fromPubkey: tenant.publicKey, toPubkey: landlord.publicKey, lamports: 1_000_000_000 }));
    tx.partialSign(landlord);
    expect(() => validateMutualRelease(tx, l, addr, tenant.publicKey)).toThrow(/Unexpected instruction/);
  });

  it("rejects tampering after the initiator signed", () => {
    const { landlord, tenant, l, addr } = setup();
    const tx = buildMutualRelease(l, landlord.publicKey, 0n, BH, 1);
    tx.partialSign(landlord);
    const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const t2 = Transaction.from(raw);
    // flip the split in the release ix data (last ix, bytes 8..16)
    const last = t2.instructions[t2.instructions.length - 1]!;
    last.data.writeBigUInt64LE(999_999n, 8);
    const re = Transaction.from(t2.serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(() => validateMutualRelease(re, l, addr, tenant.publicKey)).toThrow(/Invalid signature/);
  });

  it("rejects a release for a different lease", () => {
    const { landlord, tenant, l } = setup();
    const tx = buildMutualRelease(l, landlord.publicKey, 0n, BH, 1);
    tx.partialSign(landlord);
    const otherAddr = leasePda(l.landlord, l.tenant, l.leaseId + 1n);
    expect(() => validateMutualRelease(tx, { ...l, leaseId: l.leaseId + 1n }, otherAddr, tenant.publicKey)).toThrow(/accounts don't match|Unexpected/);
  });

  it("malformed fragments return null", () => {
    expect(parseMutualFragment("#mr=<script>&h=1")).toBeNull();
    expect(parseMutualFragment("#mr=AAAA&h=x")).toBeNull();
    expect(parseMutualFragment("#nothing")).toBeNull();
    expect(PublicKey.default).toBeTruthy();
  });
});
