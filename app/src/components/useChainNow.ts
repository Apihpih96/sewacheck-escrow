"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchChainTime } from "@/lib/leases";

/**
 * Ticking "now" in chain time (unix seconds). The program checks windows against the
 * cluster clock, which can drift from the device clock, so we measure the offset once.
 */
export function useChainNow(): number {
  const { connection } = useConnection();
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    let alive = true;
    fetchChainTime(connection).then((t) => {
      if (alive) setOffset(t - Math.floor(Date.now() / 1000));
    });
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connection]);
  return now + offset;
}
