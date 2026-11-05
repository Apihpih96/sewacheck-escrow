import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";
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
            Devnet demo · funds are test USDC · the program never holds a company key over deposits
          </footer>
        </Providers>
      </body>
    </html>
  );
}
