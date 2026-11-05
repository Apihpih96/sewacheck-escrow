import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "./constants";
import { u64le } from "./codec";

const enc = new TextEncoder();

/** Lease PDA: ["lease", landlord, tenant, lease_id (u64 LE)]. */
export function leasePda(landlord: PublicKey, tenant: PublicKey, leaseId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("lease"), landlord.toBytes(), tenant.toBytes(), u64le(leaseId)],
    PROGRAM_ID,
  )[0];
}

/** Vault PDA (token account owned by the program): ["vault", lease]. Not an ATA. */
export function vaultPda(lease: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault"), lease.toBytes()], PROGRAM_ID)[0];
}

/** Config PDA: ["config"]. */
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("config")], PROGRAM_ID)[0];
}

/**
 * USDC associated token account for a wallet. allowOwnerOffCurve=true so a party can be a
 * PDA wallet (e.g. a multisig vault) without the derivation throwing.
 */
export function usdcAta(owner: PublicKey, mint: PublicKey = USDC_MINT): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** Random non-zero u64 lease id (the PDA also includes landlord + tenant). */
export function randomLeaseId(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  const v = new DataView(b.buffer).getBigUint64(0, true);
  return v === 0n ? 1n : v;
}
