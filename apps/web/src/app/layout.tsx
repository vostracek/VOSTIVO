import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vostivo",
  description: "Vostivo — training that keeps pace with you.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
