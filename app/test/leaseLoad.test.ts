import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { encodeLease } from "../src/lib/codec";
import { PROGRAM_ID } from "../src/lib/constants";
import { fetchLease } from "../src/lib/leases";
import { NotSewaCheckLeaseError, classifyLeaseLoadError, closingSignature } from "../src/lib/leaseLoad";
import { fixtureLease } from "./fixtures";

function conn(info: { owner: PublicKey; data: Uint8Array } | null | Error): Connection {
  return {
    getAccountInfo: async () => {
      if (info instanceof Error) throw info;
      return info && { ...info, executable: false, lamports: 1, rentEpoch: 0 };
    },
  } as unknown as Connection;
}
const addr = Keypair.generate().publicKey;

describe("fetchLease", () => {
  it("decodes a lease owned by the program", async () => {
    const l = fixtureLease();
    const got = await fetchLease(conn({ owner: PROGRAM_ID, data: encodeLease(l) }), addr);
    expect(got?.amount).toBe(l.amount);
  });
  it("returns null for a missing (closed) account", async () => {
    expect(await fetchLease(conn(null), addr)).toBeNull();
  });
  it("rejects an account owned by another program as not a SewaCheck lease", async () => {
    await expect(fetchLease(conn({ owner: PublicKey.default, data: new Uint8Array(10) }), addr)).rejects.toBeInstanceOf(
      NotSewaCheckLeaseError,
    );
  });
  it("rejects a program account that isn't a lease (e.g. Config) the same way", async () => {
    await expect(fetchLease(conn({ owner: PROGRAM_ID, data: new Uint8Array(300) }), addr)).rejects.toBeInstanceOf(
      NotSewaCheckLeaseError,
    );
  });
});

describe("classifyLeaseLoadError", () => {
  it("marks foreign accounts", () => {
    expect(classifyLeaseLoadError(new NotSewaCheckLeaseError())).toEqual({ kind: "foreign" });
  });
  it("treats anything else as a retryable network problem with a message", () => {
    const p = classifyLeaseLoadError(new TypeError("Failed to fetch"));
    expect(p.kind).toBe("network");
    if (p.kind === "network") expect(p.message.length).toBeGreaterThan(0);
  });
});

describe("closingSignature", () => {
  it("picks the newest successful signature", () => {
    const sigs = [
      { signature: "failed", err: { InstructionError: [0, "x"] } },
      { signature: "close", err: null, blockTime: 2 },
      { signature: "create", err: null, blockTime: 1 },
    ];
    expect(closingSignature(sigs)?.signature).toBe("close");
  });
  it("returns null with no successful history (address never held a lease)", () => {
    expect(closingSignature([])).toBeNull();
    expect(closingSignature([{ signature: "f", err: "boom" }])).toBeNull();
  });
});
