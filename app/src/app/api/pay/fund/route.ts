import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { RPC_URL } from "@/lib/constants";
import { buildFundTransaction, parsePubkey, PayError } from "@/lib/solanaPay";

// Solana Pay transaction request endpoint for funding a lease deposit.
// GET  -> { label, icon }                       (wallet shows who is asking)
// POST { account } -> { transaction, message }  (unsigned tx for the wallet to sign + send)
// Spec: https://docs.solanapay.com/spec#specification-transaction-request

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Encoding",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

/** Public base URL for absolute links (icon). Prefer configured URL over the Host header. */
function baseUrl(req: NextRequest): string {
  const env = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, "");
  return req.nextUrl.origin;
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(req: NextRequest) {
  return json({ label: "SewaCheck Escrow", icon: `${baseUrl(req)}/icon.png` });
}

export async function POST(req: NextRequest) {
  const lease = parsePubkey(req.nextUrl.searchParams.get("lease"));
  if (!lease) return json({ error: "Missing or invalid lease address.", message: "Invalid lease link." }, 400);

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 4096) return json({ error: "Body too large." }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "Body must be JSON: { \"account\": \"<base58>\" }" }, 400);
  }
  const account = parsePubkey((body as { account?: unknown } | null)?.account);
  if (!account) return json({ error: "Invalid account.", message: "Invalid wallet address." }, 400);

  try {
    const conn = new Connection(process.env.RPC_URL ?? RPC_URL, "confirmed");
    const { transaction, message } = await buildFundTransaction(conn, lease, account);
    return json({ transaction, message });
  } catch (e) {
    if (e instanceof PayError) return json({ error: e.message, message: e.message }, e.status);
    console.error("pay/fund error", e);
    return json({ error: "Could not build the transaction. Try again shortly.", message: "Server error." }, 500);
  }
}
