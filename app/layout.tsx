import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Engineering AI",
  description: "Five-agent guarded product engineering chatbot",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
