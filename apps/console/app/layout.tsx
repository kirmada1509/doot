import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Doot Caller Demo",
  description: "Browser softphone for Doot's coordination demonstration."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
