"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parsePubkey } from "@/lib/solanaPay";

export function OpenByAddress({ placeholder = "Open a lease by address" }: { placeholder?: string }) {
  const router = useRouter();
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const pk = parsePubkey(v.trim());
        if (!pk) return setErr("Not a valid lease address.");
        setErr(null);
        router.push(`/lease/${pk.toBase58()}`);
      }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label="Lease address" spellCheck={false} />
      <button className="btn small" type="submit">
        Open
      </button>
      {err && <span className="error small">{err}</span>}
    </form>
  );
}
