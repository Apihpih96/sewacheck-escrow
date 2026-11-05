import { Keypair, PublicKey } from "@solana/web3.js";
import type { Lease } from "../src/lib/codec";
import { USDC_MINT } from "../src/lib/constants";

export function fixtureLease(over: Partial<Lease> = {}): Lease {
  return {
    landlord: Keypair.generate().publicKey,
    tenant: Keypair.generate().publicKey,
    arbiter: PublicKey.default,
    mint: USDC_MINT,
    leaseId: 42n,
    amount: 5_400_000_000n,
    funded: 5_400_000_000n,
    leaseEndTs: 1_800_000_000n,
    claimWindowSecs: 1_209_600n,
    responseWindowSecs: 604_800n,
    arbiterWindowSecs: 1_209_600n,
    termsHash: new Uint8Array(32).fill(7),
    status: "Active",
    deduction: 0n,
    evidenceHash: new Uint8Array(32),
    proposedTs: 0n,
    disputedTs: 0n,
    bump: 254,
    vaultBump: 253,
    ...over,
  };
}

