import Link from "next/link";
import { MyLeases } from "@/components/MyLeases";

export default function Home() {
  return (
    <div className="stack">
      <section className="hero card">
        <h1>Rental deposits, held by neither side.</h1>
        <p>
          The tenant locks the deposit in USDC on Solana. At move-out the landlord can claim deductions with evidence;
          the tenant accepts or disputes; silence and missed deadlines resolve automatically.
        </p>
        <div className="row">
          <Link className="btn primary" href="/create">
            Create a lease
          </Link>
          <a className="btn ghost" href="#how">
            How it works
          </a>
        </div>
      </section>
      <MyLeases />
      <section className="card" id="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li><strong>Landlord creates the lease</strong>: tenant wallet, deposit, end date and the claim, response and arbiter windows.</li>
          <li><strong>Tenant funds</strong> by scanning a Solana Pay code or connecting a wallet. The USDC sits in a program vault.</li>
          <li><strong>After the lease ends</strong> the landlord has the claim window to propose a deduction with an evidence fingerprint. No claim: anyone can refund the tenant in full.</li>
          <li><strong>The tenant accepts or disputes.</strong> No answer in time counts as acceptance. A dispute goes to the arbiter; no ruling in time refunds the tenant.</li>
          <li><strong>Any time</strong>, both can release by agreement with one jointly signed transaction.</li>
        </ol>
      </section>
    </div>
  );
}
