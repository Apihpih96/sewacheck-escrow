import { mapError } from "./errors";

/** Thrown by fetchLease when the account exists but belongs to another program. */
export class NotSewaCheckLeaseError extends Error {
  constructor() {
    super("That address is not a SewaCheck lease.");
    this.name = "NotSewaCheckLeaseError";
  }
}

export type LeaseLoadProblem = { kind: "foreign" } | { kind: "network"; message: string };

/** Sort a failed lease load into "not ours" (dead end, offer other links) or "network" (retryable). */
export function classifyLeaseLoadError(e: unknown): LeaseLoadProblem {
  if (e instanceof NotSewaCheckLeaseError) return { kind: "foreign" };
  return { kind: "network", message: mapError(e).message };
}

export interface SigInfo {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

/**
 * The transaction that closed a lease account: the newest successful signature on its address
 * (getSignaturesForAddress returns newest first). null when the address has no successful history,
 * i.e. it never held a lease.
 */
export function closingSignature(sigs: readonly SigInfo[]): SigInfo | null {
  return sigs.find((s) => s.err == null) ?? null;
}
