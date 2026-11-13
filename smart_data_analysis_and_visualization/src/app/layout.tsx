import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Data | Supabase Connection",
  description: "Connect and view your Supabase database"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
