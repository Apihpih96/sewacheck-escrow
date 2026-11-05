import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idl from "../idl/sewacheck_escrow.json";

/** Program deployed on devnet (same ID on localnet). Taken from the committed IDL. */
export const PROGRAM_ID = new PublicKey(idl.address);

/** Circle devnet USDC. The program's Config only accepts this mint on devnet. */
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
export const USDC_DECIMALS = 6;

// Take program IDs from spl-token rather than hand-typing them (a typo here once produced
// wrong ATA addresses and a ProgramAccountNotFound on every payout; see WEEK3.md).
export const TOKEN_PROGRAM_ID = SPL_TOKEN_PROGRAM_ID;
export const ASSOCIATED_TOKEN_PROGRAM_ID = SPL_ATA_PROGRAM_ID;

export const CLUSTER = "devnet" as const;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

/** Program defaults when a window argument is 0 (mirrors lib.rs). */
export const DEFAULT_CLAIM_WINDOW_SECS = 14 * 24 * 60 * 60;
export const DEFAULT_RESPONSE_WINDOW_SECS = 7 * 24 * 60 * 60;
export const DEFAULT_ARBITER_WINDOW_SECS = 14 * 24 * 60 * 60;

/** Lease account size: 8 discriminator + 275 bytes of fields (see lib.rs / WEEK2.md). */
export const LEASE_ACCOUNT_SIZE = 283;
/** memcmp offsets inside the Lease account. */
export const LEASE_LANDLORD_OFFSET = 8;
export const LEASE_TENANT_OFFSET = 40;

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=${CLUSTER}`;
}
export function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(addr)}?cluster=${CLUSTER}`;
}
