import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Thai } from "next/font/google";
import { Header } from "@/components/shell/Header";
import { MockBanner } from "@/components/shell/MockBanner";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "./providers";
import "./globals.css";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex", display: "swap" });
const plexThai = IBM_Plex_Sans_Thai({ subsets: ["thai"], weight: ["400", "500", "600", "700"], variable: "--font-plex-thai", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "CentMe",
  description: "Send USD to Thailand. Test-mode demo: USD funding and THB payout are simulated.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plex.variable} ${plexThai.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh">
        <Providers>
          <Header />
          <MockBanner />
          <main id="main" className="mx-auto w-full max-w-[1040px] px-4 py-8 sm:px-6 lg:py-12">
            {children}
          </main>
        </Providers>
        <Toaster theme="light" richColors position="top-center" />
      </body>
    </html>
  );
}
