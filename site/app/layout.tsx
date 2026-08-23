import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://nort.works"),
  title: "NORTOWN — leaderboard",
  description:
    "The NORTOWN season leaderboard: who burned the most AI tokens building a city. Every token your AI agents burn becomes a building, live in the corner of your screen.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "NORTOWN — leaderboard",
    description: "Every token your AI agents burn becomes a building. Build your city and join the season leaderboard.",
    url: "/",
    siteName: "NORTOWN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NORTOWN — leaderboard",
    description: "Every token your AI agents burn becomes a building. Build your city and join the season leaderboard.",
  },
};

export const viewport: Viewport = {
  themeColor: "#07111f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
