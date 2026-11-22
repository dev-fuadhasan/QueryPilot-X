import type { Metadata } from "next";
import "./globals.css";
import "./landing.css";
import "./ask-ai.css";

export const metadata: Metadata = {
  title: "QueryPilot",
  description: "A workspace for connected data analysis and monitoring.",
  icons: {
    icon: [{ url: "/querypilot-logo.svg", type: "image/svg+xml" }],
    shortcut: "/querypilot-logo.svg"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
