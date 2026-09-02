"use server";

import { redirect } from "next/navigation";

import { rememberSession, sharedPassword } from "@/auth/session";
import { isSharedPassword } from "@/auth/session-token";

export async function unlock(formData: FormData): Promise<void> {
  const candidate = String(formData.get("mot-de-passe") ?? "");

  if (!isSharedPassword(candidate, sharedPassword())) {
    redirect("/?erreur=1");
  }

  await rememberSession();
  redirect("/");
}
