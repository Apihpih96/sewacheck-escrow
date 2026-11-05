"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Client-only: the wallet button reads window state and would mismatch on hydration.
// BaseWalletMultiButton lets us use a short "Connect" label so the header fits one row on phones.
const WalletButton = dynamic(
  async () => {
    const { BaseWalletMultiButton } = await import("@solana/wallet-adapter-react-ui");
    function WalletButton() {
      return <BaseWalletMultiButton labels={WALLET_LABELS} />;
    }
    return WalletButton;
  },
  { ssr: false, loading: () => <span className="wallet-placeholder" /> },
);

const WALLET_LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied",
  disconnect: "Disconnect",
  "has-wallet": "Connect",
  "no-wallet": "Connect",
};

const LINKS = [
  { href: "/create", label: "New lease" },
  { href: "/#my-leases", label: "My leases" },
];

export function Header() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the phone menu on navigation, outside click, or Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="header">
      <Link href="/" className="brand" aria-label="SewaCheck Escrow home">
        <span className="logo" aria-hidden>
          ✓
        </span>
        <span className="brand-name">
          SewaCheck <strong className="brand-sub">Escrow</strong>
        </span>
        <span className="pill">devnet</span>
      </Link>
      <nav className="nav" aria-label="Main">
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </div>
        <div className="nav-menu" ref={menuRef}>
          <button
            type="button"
            className="menu-btn"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls="nav-menu-list"
            onClick={() => setOpen((o) => !o)}
          >
            <span aria-hidden>☰</span>
          </button>
          {open && (
            <ul id="nav-menu-list" className="menu-list">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} onClick={() => setOpen(false)}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <WalletButton />
      </nav>
    </header>
  );
}
