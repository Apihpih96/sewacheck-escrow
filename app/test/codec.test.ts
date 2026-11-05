import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fixtureLease } from "./fixtures";
import { decodeConfig, decodeLease, encodeLease, i64le, u64le, U64_MAX, accountDiscriminator, concatBytes } from "../src/lib/codec";
import { LEASE_ACCOUNT_SIZE, LEASE_LANDLORD_OFFSET, LEASE_TENANT_OFFSET, USDC_MINT } from "../src/lib/constants";

describe("codec", () => {
  it("u64/i64 little-endian with range checks", () => {
    expect(Array.from(u64le(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(u64le(U64_MAX))).toEqual(Array(8).fill(255));
    expect(() => u64le(-1n)).toThrow(RangeError);
    expect(() => u64le(U64_MAX + 1n)).toThrow(RangeError);
    expect(Array.from(i64le(-1n))).toEqual(Array(8).fill(255));
    expect(() => i64le(1n << 63n)).toThrow(RangeError);
  });

  it("Lease round-trips and is exactly 283 bytes", () => {
    const l = fixtureLease({ status: "Disputed", deduction: 123n, proposedTs: 5n, disputedTs: 6n, leaseId: U64_MAX });
    const data = encodeLease(l);
    expect(data.length).toBe(LEASE_ACCOUNT_SIZE);
    const d = decodeLease(data);
    expect(d.landlord.equals(l.landlord)).toBe(true);
    expect(d.tenant.equals(l.tenant)).toBe(true);
    expect(d.leaseId).toBe(U64_MAX);
    expect(d.status).toBe("Disputed");
    expect(d.deduction).toBe(123n);
    expect(d.disputedTs).toBe(6n);
    expect(d.bump).toBe(254);
    expect(d.vaultBump).toBe(253);
  });

  it("memcmp offsets point at landlord and tenant", () => {
    const l = fixtureLease();
    const data = encodeLease(l);
    expect(new PublicKey(data.subarray(LEASE_LANDLORD_OFFSET, LEASE_LANDLORD_OFFSET + 32)).equals(l.landlord)).toBe(true);
    expect(new PublicKey(data.subarray(LEASE_TENANT_OFFSET, LEASE_TENANT_OFFSET + 32)).equals(l.tenant)).toBe(true);
  });

  it("rejects non-lease data", () => {
    const data = encodeLease(fixtureLease());
    const bad = Uint8Array.from(data);
    bad[0] = (bad[0]! + 1) % 256;
    expect(() => decodeLease(bad)).toThrow(/discriminator/);
    expect(() => decodeLease(data.subarray(0, 100))).toThrow(/too short/);
    const badStatus = Uint8Array.from(data);
    badStatus[8 + 32 * 4 + 8 * 7 + 32] = 9;
    expect(() => decodeLease(badStatus)).toThrow(/status/);
  });

  it("decodes Config", () => {
    const admin = Keypair.generate().publicKey;
    const c = decodeConfig(concatBytes(accountDiscriminator("Config"), admin.toBytes(), USDC_MINT.toBytes(), Uint8Array.of(255)));
    expect(c.admin.equals(admin)).toBe(true);
    expect(c.usdcMint.equals(USDC_MINT)).toBe(true);
  });
});
