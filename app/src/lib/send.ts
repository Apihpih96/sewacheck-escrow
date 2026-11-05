import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { mapError } from "./errors";

export type SendFn = (tx: Transaction, conn: Connection) => Promise<string>;

/**
 * Builds a legacy tx, simulates it first (so program errors are shown in plain English
 * before the wallet pops up), then hands it to the wallet and waits for confirmation.
 */
export async function simulateThenSend(
  conn: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  send: SendFn,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...ixs);
  await simulateOrThrow(conn, tx);
  const sig = await send(tx, conn);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

export async function simulateOrThrow(conn: Connection, tx: Transaction): Promise<void> {
  const vtx = new VersionedTransaction(tx.compileMessage());
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err) {
    const e = mapError({ message: JSON.stringify(sim.value.err), logs: sim.value.logs ?? [] });
    throw Object.assign(new Error(e.message), { logs: sim.value.logs ?? [], mapped: e });
  }
}
