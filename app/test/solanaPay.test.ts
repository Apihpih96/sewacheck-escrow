import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildFundTransaction, fundRequestLink, parsePubkey, PayError, transactionRequestUrl } from "../src/lib/solanaPay";
import { encodeLease, ixDiscriminator } from "../src/lib/codec";
import { PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "../src/lib/constants";
import { leasePda } from "../src/lib/pda";
import { fixtureLease } from "./fixtures";

function mockConn(accounts: Record<string, { owner: PublicKey; data: Uint8Array } | null>): Connection {
  return {
    getAccountInfo: async (pk: PublicKey) => {
      const a = accounts[pk.toBase58()];
      return a ? { owner: a.owner, data: Buffer.from(a.data), lamports: 1, executable: false } : null;
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
  } as unknown as Connection;
}

describe("Solana Pay transaction request", () => {
  it("encodes links with query strings per spec", () => {
    const lease = Keypair.generate().publicKey;
    const link = fundRequestLink("https://app.example", lease);
    expect(link).toBe(`https://app.example/api/pay/fund?lease=${lease.toBase58()}`);
    const url = transactionRequestUrl(link);
    expect(url.startsWith("solana:https%3A%2F%2Fapp.example%2Fapi%2Fpay%2Ffund%3Flease%3D")).toBe(true);
    expect(decodeURIComponent(url.slice("solana:".length))).toBe(link);
    expect(transactionRequestUrl("https://app.example/pay")).toBe("solana:https://app.example/pay");
    expect(() => transactionRequestUrl("javascript:alert(1)")).toThrow();
  });

  it("parsePubkey rejects injection / non-canonical input", () => {
    const pk = Keypair.generate().publicKey.toBase58();
    expect(parsePubkey(pk)?.toBase58()).toBe(pk);
    for (const bad of ["<script>alert(1)</script>", `${pk}"`, `${pk} `, "0".repeat(44), "", null, 5, { toString: () => pk }, "1".repeat(45)]) {
      expect(parsePubkey(bad as unknown)).toBeNull();
    }
  });

  it("builds an unsigned fund tx for the tenant: fee payer, remaining amount, ATA create", async () => {
    const l = fixtureLease({ status: "Created", amount: 3_000_000n, funded: 1_000_000n });
    const addr = leasePda(l.landlord, l.tenant, l.leaseId);
    const conn = mockConn({ [addr.toBase58()]: { owner: PROGRAM_ID, data: encodeLease(l) } });
    const res = await buildFundTransaction(conn, addr, l.tenant);
    const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
    expect(tx.feePayer?.equals(l.tenant)).toBe(true);
    expect(tx.recentBlockhash).toBe("11111111111111111111111111111111");
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(tx.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const fund = tx.instructions[1]!;
    expect(fund.programId.equals(PROGRAM_ID)).toBe(true);
    expect(fund.data.subarray(0, 8).equals(Buffer.from(ixDiscriminator("fund_deposit")))).toBe(true);
    expect(fund.data.readBigUInt64LE(8)).toBe(2_000_000n);
    expect(res.message).toMatch(/2\.00 USDC/);
  });

  it("refuses non-tenants, funded/closed leases, and foreign accounts", async () => {
    const l = fixtureLease({ status: "Created", funded: 0n });
    const addr = leasePda(l.landlord, l.tenant, l.leaseId);
    const ok = mockConn({ [addr.toBase58()]: { owner: PROGRAM_ID, data: encodeLease(l) } });
    await expect(buildFundTransaction(ok, addr, l.landlord)).rejects.toMatchObject({ status: 403 });
    const active = mockConn({ [addr.toBase58()]: { owner: PROGRAM_ID, data: encodeLease({ ...l, status: "Active" }) } });
    await expect(buildFundTransaction(active, addr, l.tenant)).rejects.toThrow(/already funded/);
    await expect(buildFundTransaction(mockConn({}), addr, l.tenant)).rejects.toMatchObject({ status: 404 });
    const foreign = mockConn({ [addr.toBase58()]: { owner: Keypair.generate().publicKey, data: encodeLease(l) } });
    await expect(buildFundTransaction(foreign, addr, l.tenant)).rejects.toBeInstanceOf(PayError);
    const junk = mockConn({ [addr.toBase58()]: { owner: PROGRAM_ID, data: new Uint8Array(283) } });
    await expect(buildFundTransaction(junk, addr, l.tenant)).rejects.toThrow(/not a SewaCheck lease/);
  });
});
