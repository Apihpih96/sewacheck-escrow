"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

// Client-only: the wallet button reads window state and would mismatch on hydration.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false, loading: () => <span className="wallet-placeholder" /> },
);

export function Header() {
  return (
    <header className="header">
      <Link href="/" className="brand" aria-label="SewaCheck Escrow home">
        <span className="logo" aria-hidden>
          ✓
        </span>
        <span>
          SewaCheck <strong>Escrow</strong>
        </span>
        <span className="pill">devnet</span>
      </Link>
      <nav className="nav">
        <Link href="/create">New lease</Link>
        <Link href="/#my-leases">My leases</Link>
        <WalletMultiButton />
      </nav>
    </header>
  );
}
