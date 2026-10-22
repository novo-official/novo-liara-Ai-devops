import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { fa } from "@/i18n/fa";

const vazir = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  variable: "--font-vazir",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: { default: fa.app.name, template: `%s | ${fa.app.name}` },
  description: fa.app.tagline,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: "#0f1420",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={`dark ${vazir.variable}`}>
      <body className="bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
