import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VoiceBridge",
  description: "用手机录音，在电脑光标处自动输入。",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png"
  },
  manifest: "/manifest.json"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
