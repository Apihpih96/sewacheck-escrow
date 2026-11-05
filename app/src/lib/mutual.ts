import { Buffer } from "buffer";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID } from "./constants";
import { bytesEqual, ixDiscriminator, type Lease } from "./codec";
import { buildActionIxs, leaseAddresses } from "./tx";
import { usdcAta } from "./pda";

/**
 * Two-signer mutual_release flow (no server, no durable nonce):
 *  1. Party A builds the tx (fee payer = A), signs it, and shares a link whose URL *fragment*
 *     carries the partially signed tx (`#mr=<base64url>&h=<lastValidBlockHeight>`). The
 *     fragment is never sent to any server.
 *  2. Party B opens the link; the page decodes and *validates* the tx (only ATA-creates for
 *     the two parties and one mutual_release for this lease), shows the split, B signs and
 *     sends.
 * Limitation: a recent blockhash is valid for ~60–90 s, so both parties should have the lease
 * page open at the same time (e.g. on a call). A durable-nonce version is a later upgrade.
 */
export interface MutualDraft {
  tx: Transaction;
  lastValidBlockHeight: number;
}

export function buildMutualRelease(
  lease: Lease,
  initiator: PublicKey,
  toLandlord: bigint,
  blockhash: string,
  lastValidBlockHeight: number,
): Transaction {
  if (!initiator.equals(lease.landlord) && !initiator.equals(lease.tenant))
    throw new Error("Only the landlord or tenant can start a mutual release.");
  if (toLandlord < 0n || toLandlord > lease.funded) throw new Error("Split can't exceed the funded deposit.");
  const tx = new Transaction();
  tx.add(...buildActionIxs("mutual_release", lease, initiator, { toLandlord }));
  tx.feePayer = initiator;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function encodeMutualFragment(tx: Transaction, lastValidBlockHeight: number): string {
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return `mr=${b64url(raw)}&h=${lastValidBlockHeight}`;
}

export function parseMutualFragment(hash: string): MutualDraft | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const mr = p.get("mr");
  const h = Number(p.get("h"));
  if (!mr || !/^[A-Za-z0-9_-]+$/.test(mr) || mr.length > 2000 || !Number.isSafeInteger(h)) return null;
  try {
    return { tx: Transaction.from(fromB64url(mr)), lastValidBlockHeight: h };
  } catch {
    return null;
  }
}

/**
 * Validates a received mutual_release tx against the on-chain lease and the signer about to
 * co-sign. Returns the split. Throws with a readable reason on anything unexpected, so a
 * crafted link can't get a party to sign extra instructions (e.g. a SOL/USDC transfer).
 */
export function validateMutualRelease(tx: Transaction, lease: Lease, leaseAddr: PublicKey, cosigner: PublicKey) {
  const a = leaseAddresses(lease);
  if (!a.lease.equals(leaseAddr)) throw new Error("Lease mismatch.");
  const parties = [lease.landlord, lease.tenant];
  const isParty = (k: PublicKey) => parties.some((p) => p.equals(k));
  if (!isParty(cosigner)) throw new Error("Only the landlord or tenant can co-sign.");
  if (!tx.feePayer || !isParty(tx.feePayer)) throw new Error("Fee payer must be the landlord or tenant.");
  if (tx.feePayer.equals(cosigner)) throw new Error("This request was created by your own wallet; send the link to the other party.");

  // The initiator (fee payer) must already have signed, and the signature must be valid.
  const feeSig = tx.signatures.find((s) => s.publicKey.equals(tx.feePayer!));
  if (!feeSig?.signature) throw new Error("The other party has not signed this request.");
  if (!tx.verifySignatures(false)) throw new Error("Invalid signature on the release request.");

  const allowedAtas = [usdcAta(lease.landlord, lease.mint), usdcAta(lease.tenant, lease.mint)];
  let toLandlord: bigint | null = null;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // createIdempotent: data = [1]; keys = payer, ata, owner, mint, system, token
      const ata = ix.keys[1]?.pubkey;
      const payer = ix.keys[0]?.pubkey;
      const mint = ix.keys[3]?.pubkey;
      if (ix.data.length !== 1 || ix.data[0] !== 1) throw new Error("Unexpected token-account instruction.");
      if (!ata || !allowedAtas.some((x) => x.equals(ata))) throw new Error("Unexpected token account.");
      if (!payer || !isParty(payer) || !mint || !mint.equals(lease.mint)) throw new Error("Unexpected token-account payer or mint.");
      continue;
    }
    if (ix.programId.equals(PROGRAM_ID)) {
      if (toLandlord !== null) throw new Error("More than one release instruction.");
      const disc = ixDiscriminator("mutual_release");
      if (ix.data.length !== 16 || !bytesEqual(Uint8Array.from(ix.data.subarray(0, 8)), disc))
        throw new Error("Not a mutual release.");
      const keys = ix.keys.map((k) => k.pubkey);
      const expect = [lease.landlord, lease.tenant, a.lease, lease.mint, a.landlordToken, a.tenantToken, a.vault];
      if (!expect.every((e, i) => keys[i]?.equals(e))) throw new Error("Release accounts don't match this lease.");
      toLandlord = Buffer.from(ix.data).readBigUInt64LE(8);
      continue;
    }
    throw new Error(`Unexpected instruction for program ${ix.programId.toBase58()}.`);
  }
  if (toLandlord === null) throw new Error("No mutual release instruction found.");
  if (toLandlord > lease.funded) throw new Error("Split exceeds the funded deposit.");
  return { toLandlord, toTenant: lease.funded - toLandlord, initiator: tx.feePayer };
}
