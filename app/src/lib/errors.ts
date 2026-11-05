import idl from "../idl/sewacheck_escrow.json";
import { PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";

/** Plain-English messages for the program's custom errors (codes 6000+), keyed by name. */
const FRIENDLY: Record<string, string> = {
  InvalidAmount: "The amount must be greater than zero.",
  LeaseEndInPast: "The lease end date must be in the future.",
  InvalidClaimWindow: "The claim window can't be negative.",
  SameParty: "Landlord and tenant must be different wallets.",
  InvalidStatus: "This action isn't possible at the lease's current stage. Refresh to see the latest status.",
  Overfund: "That's more than the remaining deposit.",
  Unauthorized: "The connected wallet isn't allowed to do this on this lease.",
  DeadlineNotReached: "Too early: the deadline for this action hasn't passed yet.",
  ClaimExists: "A deduction claim exists, so an automatic refund isn't possible.",
  WrongMint: "Wrong token: this lease only accepts its USDC mint.",
  WrongTokenOwner: "A token account doesn't belong to the expected wallet.",
  WrongLandlord: "The landlord account doesn't match this lease.",
  VaultMismatch: "The escrow vault balance is lower than the funded amount.",
  Overpay: "The split can't exceed the funded deposit.",
  MathOverflow: "A number is too large (arithmetic overflow). Try shorter windows or a smaller amount.",
  MintNotAllowed: "This token isn't the USDC mint the escrow accepts.",
  InvalidResponseWindow: "The response window can't be negative.",
  ArbiterIsParty: "The arbiter must be someone other than the landlord or tenant.",
  DeductionTooLarge: "The deduction can't be more than the funded deposit.",
  MissingEvidence: "Attach an evidence file: its fingerprint (SHA-256) is required.",
  LeaseNotEnded: "Deductions can only be proposed after the lease ends.",
  ClaimWindowClosed: "The claim window has closed.",
  ResponseWindowClosed: "The tenant's response window has closed.",
  ExceedsClaim: "The ruling can't give the landlord more than the claimed deduction.",
  InvalidArbiterWindow: "The arbiter window can't be negative.",
  ArbiterWindowClosed: "The arbiter's deadline has passed; anyone can now refund the tenant.",
  InvalidAdmin: "Invalid admin key.",
};

export const PROGRAM_ERRORS: Record<number, { name: string; msg: string }> = Object.fromEntries(
  idl.errors.map((e) => [e.code, { name: e.name, msg: FRIENDLY[e.name] ?? e.msg }]),
);

/** A few Anchor framework errors a user can realistically hit. */
const ANCHOR_ERRORS: Record<number, string> = {
  2006: "An account doesn't match this lease (seeds check failed).",
  2012: "An account address doesn't match what the lease expects.",
  2003: "An account constraint failed.",
  3007: "An account isn't owned by the expected program.",
  3012: "A required account doesn't exist yet (for example, a USDC token account).",
  3001: "That address isn't a SewaCheck lease.",
  3002: "That address isn't a SewaCheck lease.",
};

/** SPL Token program errors. */
const TOKEN_ERRORS: Record<number, string> = {
  1: "Not enough USDC in the wallet. Get devnet USDC from faucet.circle.com.",
  3: "Token mint mismatch.",
  4: "Token account owner mismatch.",
};

export interface MappedError {
  message: string;
  code?: number;
  name?: string;
}

function textOf(err: unknown): { text: string; logs: string[] } {
  const logs: string[] = [];
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number) => {
    if (e == null || depth > 4 || seen.has(e)) return;
    seen.add(e);
    if (typeof e === "string") {
      parts.push(e);
      return;
    }
    if (typeof e !== "object") {
      parts.push(String(e));
      return;
    }
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") parts.push(o.message);
    if (Array.isArray(o.logs)) logs.push(...o.logs.filter((x): x is string => typeof x === "string"));
    if (o.InstructionError !== undefined) parts.push(JSON.stringify(o));
    visit(o.error, depth + 1);
    visit(o.cause, depth + 1);
    visit(o.err, depth + 1);
  };
  visit(err, 0);
  return { text: parts.join(" | "), logs };
}

/** Turns any wallet / RPC / simulation error into one readable sentence. */
export function mapError(err: unknown): MappedError {
  const { text, logs } = textOf(err);
  const all = `${text}\n${logs.join("\n")}`;

  // Anchor log line: "Error Code: X. Error Number: 6004. Error Message: ..."
  const an = /Error Number: (\d+)/.exec(all);
  if (an?.[1]) {
    const code = Number(an[1]);
    if (PROGRAM_ERRORS[code]) return { code, ...PROGRAM_ERRORS[code], message: PROGRAM_ERRORS[code].msg };
    if (ANCHOR_ERRORS[code]) return { code, message: ANCHOR_ERRORS[code] };
  }

  // "Program <id> failed: custom program error: 0x1770" — attribute the code to the program.
  const failLine = /Program (\w+) failed: custom program error: 0x([0-9a-fA-F]+)/.exec(all);
  if (failLine?.[1] && failLine[2]) {
    const code = parseInt(failLine[2], 16);
    if (failLine[1] === TOKEN_PROGRAM_ID.toBase58() && TOKEN_ERRORS[code]) return { code, message: TOKEN_ERRORS[code] };
    if (failLine[1] === PROGRAM_ID.toBase58()) {
      if (PROGRAM_ERRORS[code]) return { code, ...PROGRAM_ERRORS[code], message: PROGRAM_ERRORS[code].msg };
      if (ANCHOR_ERRORS[code]) return { code, message: ANCHOR_ERRORS[code] };
    }
  }

  // Bare codes without a program attribution: only trust ranges that are unambiguous.
  const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(all);
  const json = /"Custom":\s*(\d+)/.exec(all);
  const raw = hex?.[1] ? parseInt(hex[1], 16) : json?.[1] ? Number(json[1]) : undefined;
  if (raw !== undefined) {
    if (PROGRAM_ERRORS[raw]) return { code: raw, ...PROGRAM_ERRORS[raw], message: PROGRAM_ERRORS[raw].msg };
    if (ANCHOR_ERRORS[raw]) return { code: raw, message: ANCHOR_ERRORS[raw] };
  }

  if (/insufficient funds/i.test(all) && /Tokenkeg/.test(all)) return { message: TOKEN_ERRORS[1]! };
  if (/User rejected|rejected the request|Approval Denied|cancelled by user/i.test(all))
    return { message: "You cancelled the request in your wallet." };
  if (/no record of a prior credit|insufficient lamports|InsufficientFundsForFee|insufficient funds for fee/i.test(all))
    return { message: "Not enough devnet SOL for fees. Get some at faucet.solana.com." };
  if (/Blockhash not found|block height exceeded|has expired/i.test(all))
    return { message: "The transaction expired before it was sent. Please try again." };
  if (/WalletNotConnected|wallet not connected/i.test(all)) return { message: "Connect a wallet first." };
  if (/429|Too many requests/i.test(all)) return { message: "The devnet RPC is rate-limiting. Wait a few seconds and retry." };
  if (/failed to fetch|NetworkError|ECONNREFUSED/i.test(all)) return { message: "Network error reaching Solana devnet." };

  const first = text.split(" | ")[0]?.trim();
  return { message: first ? first.slice(0, 300) : "Something went wrong." };
}
