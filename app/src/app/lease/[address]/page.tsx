"use client";

import { useParams } from "next/navigation";
import { LeaseView } from "@/components/LeaseView";
import { parsePubkey } from "@/lib/solanaPay";

export default function LeasePage() {
  const params = useParams<{ address: string }>();
  const raw = typeof params?.address === "string" ? decodeURIComponent(params.address) : "";
  const address = parsePubkey(raw);
  if (!address)
    return (
      <section className="card error" role="alert">
        That is not a valid lease address.
      </section>
    );
  return <LeaseView key={address.toBase58()} address={address} />;
}
