"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { OpenByAddress } from "./OpenByAddress";

/** A lease-page dead end turned into a page: heading, explanation, and ways out. */
export function LeaseProblem({
  title,
  children,
  tone = "neutral",
  action,
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "error";
  action?: ReactNode;
}) {
  return (
    <section className="card problem" role={tone === "error" ? "alert" : undefined}>
      <h2>{title}</h2>
      <div className={tone === "error" ? "error" : undefined}>{children}</div>
      <div className="row">
        {action}
        <Link className="btn" href="/#my-leases">
          My leases
        </Link>
        <Link className="btn ghost" href="/create">
          Create a lease
        </Link>
      </div>
      <OpenByAddress placeholder="Open another lease by address" />
    </section>
  );
}
