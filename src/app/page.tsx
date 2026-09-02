import { hasRememberedSession } from "@/auth/session";

import { SubmissionForm } from "./submission-form";
import { UnlockForm } from "./unlock-form";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await hasRememberedSession()) {
    return <SubmissionForm />;
  }

  const { erreur } = await searchParams;

  return <UnlockForm refused={erreur !== undefined} />;
}
