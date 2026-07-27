import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "VoiceBridge",
  description: "用手机录音，在电脑光标处自动输入。"
};

export default function Home() {
  redirect("/index.html");
}
