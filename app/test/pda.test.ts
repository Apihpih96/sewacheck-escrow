import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { configPda, leasePda, randomLeaseId, usdcAta, vaultPda } from "../src/lib/pda";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT } from "../src/lib/constants";

// Known devnet accounts (WEEK1.md / WEEK2.md smoke run).
const LANDLORD = new PublicKey("DHxsPj2y48FBokAKD3xj8BH6Fw6C3bLvN4x2Mi39UHKh");
const TENANT = new PublicKey("JCFcMQZGxs9Pj4MEmEEYKBQywnQMFtSKTWDkmdsgBuq");
const TENANT_USDC_ATA = "XPcGrftUJpmqsknwymBNC2itUToL3eMcd2ATXyw8wYH"; // holds the tenant's devnet USDC

describe("PDA derivation", () => {
  it("uses the deployed program and devnet USDC", () => {
    expect(PROGRAM_ID.toBase58()).toBe("9Uu5DcNxbueKnS2UdYuAQnQCBwHH6QnBo8RtNNQ91mrQ");
    expect(USDC_MINT.toBase58()).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });
  it("program IDs are the canonical SPL ones (regression: hand-typed ATA program ID)", () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });
  it("tenant ATA matches the real devnet USDC account", () => {
    expect(usdcAta(TENANT).toBase58()).toBe(TENANT_USDC_ATA);
  });
  it("config PDA matches the devnet Config account", () => {
    expect(configPda().toBase58()).toBe("2oyW4LPcBkS8E1hixGCbG1eqgBbtceAyEBmTeEvjwE5H");
  });
  it("lease PDA matches the Week 2 devnet smoke lease (u64 LE id)", () => {
    expect(leasePda(LANDLORD, TENANT, 1793774376n).toBase58()).toBe("9x78YiYtuorfDMHFMG6ARe34vQvQRvkqXSspSneJhfTa");
  });
  it("lease PDA depends on order of landlord/tenant and on the id", () => {
    const a = leasePda(LANDLORD, TENANT, 1n);
    expect(leasePda(TENANT, LANDLORD, 1n).equals(a)).toBe(false);
    expect(leasePda(LANDLORD, TENANT, 2n).equals(a)).toBe(false);
  });
  it("handles ids above 2^53 exactly (no Number rounding)", () => {
    const big = (1n << 64n) - 1n;
    const near = big - 1n;
    expect(leasePda(LANDLORD, TENANT, big).equals(leasePda(LANDLORD, TENANT, near))).toBe(false);
  });
  it("vault is the PDA [vault, lease], not an ATA", () => {
    const lease = leasePda(LANDLORD, TENANT, 1793774376n);
    const v = vaultPda(lease);
    expect(v.equals(usdcAta(lease))).toBe(false);
    expect(PublicKey.isOnCurve(v.toBytes())).toBe(false);
  });
  it("ATA derivation allows off-curve owners (PDA wallets)", () => {
    const lease = leasePda(LANDLORD, TENANT, 1n);
    expect(() => usdcAta(lease)).not.toThrow();
  });
  it("random lease ids are non-zero u64", () => {
    for (let i = 0; i < 50; i++) {
      const id = randomLeaseId();
      expect(id > 0n && id < 1n << 64n).toBe(true);
    }
  });
});
