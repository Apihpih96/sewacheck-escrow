"use client";

import { useParams } from "next/navigation";
import { LeaseView } from "@/components/LeaseView";
import { LeaseProblem } from "@/components/LeaseProblem";
import { parsePubkey } from "@/lib/solanaPay";

export default function LeasePage() {
  const params = useParams<{ address: string }>();
  const raw = typeof params?.address === "string" ? decodeURIComponent(params.address) : "";
  const address = parsePubkey(raw);
  if (!address)
    return (
      <LeaseProblem title="That link doesn't point to a lease">
        <p>
          The address in the link isn&apos;t a valid Solana address. Check that the whole link was copied, or open the lease
          from your list.
        </p>
      </LeaseProblem>
    );
  return <LeaseView key={address.toBase58()} address={address} />;
}
