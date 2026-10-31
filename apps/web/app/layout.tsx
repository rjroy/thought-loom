import type { Metadata, Viewport } from "next";
import { Suspense, type ReactNode } from "react";
import localFont from "next/font/local";
import Link from "next/link";
import SearchForm, { SearchFields } from "./ui/search-form";
import "./globals.css";

const sourceSans = localFont({
  src: "./fonts/SourceSans3-VariableFont_wght.ttf",
  weight: "200 900",
  style: "normal",
  display: "swap",
  variable: "--font-source-sans",
});

export const metadata: Metadata = {
  title: { default: "Capture a thought · Thoughtloom", template: "%s · Thoughtloom" },
  description: "Capture and develop a thought without losing its original.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#031315" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sourceSans.variable}>
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="site-header">
          <Link className="site-name" href="/">Thoughtloom</Link>
          <Suspense fallback={<SearchFields />}><SearchForm /></Suspense>
        </header>
        {children}
        <footer className="site-footer">Your originals stay unchanged. AI readings are attributed, not established facts.</footer>
      </body>
    </html>
  );
}
