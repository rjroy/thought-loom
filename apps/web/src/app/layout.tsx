import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import { PrimaryNavigation } from "../components/primary-navigation";
import { ExploreProvider } from "../components/explore-provider";
import { IdeaNavigationProvider } from "../components/idea-navigation-provider";
import { EvolveProvider } from "../components/evolve-provider";
import { ExportProvider } from "../components/export-provider";
import { ContextualBack, ContextualBackProvider } from "../components/contextual-back";
import { CaptureProvider } from "../components/capture-provider";
import { ImportProvider } from "../components/import-provider";
import { AgenticSearchProvider } from "../components/agentic-search-provider";
import { RootSplashShell } from "../components/root-splash-shell";
import "./globals.css";

const sourceSans = localFont({
  src: "../../public/fonts/SourceSans3-VariableFont_wght.ttf",
  variable: "--font-source-sans",
  weight: "200 900",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: { default: "Thoughtloom", template: "%s · Thoughtloom" },
  description: "Capture and develop connected thinking.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#031315",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sourceSans.variable}>
      <body>
        <ExploreProvider>
          <IdeaNavigationProvider>
           <EvolveProvider>
           <ExportProvider>
           <ContextualBackProvider>
           <CaptureProvider>
            <ImportProvider>
           <AgenticSearchProvider>
          <RootSplashShell>
            <div className="site-header-inner">
              <div className="site-header-identity">
                <ContextualBack />
                <div className="brand">
                <Link className="brand-name" href="/explore" aria-label="Thoughtloom home">
                  thoughtloom
                </Link>
                <p className="brand-tagline">Where ideas take shape.</p>
                </div>
              </div>
              <PrimaryNavigation />
            </div>
          </RootSplashShell>
          <main id="main-content" className="workspace" tabIndex={-1}>
            {children}
          </main>
           </AgenticSearchProvider>
           </ImportProvider>
           </CaptureProvider>
           </ContextualBackProvider>
           </ExportProvider>
           </EvolveProvider>
          </IdeaNavigationProvider>
        </ExploreProvider>
      </body>
    </html>
  );
}
