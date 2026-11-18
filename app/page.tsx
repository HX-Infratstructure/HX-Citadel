import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function RootPage() {
  const { userId, orgSlug } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  redirect(orgSlug ? `/${orgSlug}` : "/onboarding");
}
