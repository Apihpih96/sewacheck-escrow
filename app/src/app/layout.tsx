import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./wallet-adapter.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "SewaCheck Escrow",
  description: "Rental deposits held in a neutral USDC escrow on Solana (devnet).",
  icons: { icon: "/icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#168054" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main className="main">{children}</main>
          <footer className="footer muted small">
            Devnet demo · funds are test USDC · deposits sit in a program-owned vault, not a company wallet
          </footer>
        </Providers>
      </body>
    </html>
  );
}
