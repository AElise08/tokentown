import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TOKENTOWN — leaderboard",
  description:
    "The TOKENTOWN season leaderboard: who burned the most AI tokens building a city. Every token your AI agents burn becomes a building, live in the corner of your screen.",
};

export const viewport: Viewport = {
  themeColor: "#141019",
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
