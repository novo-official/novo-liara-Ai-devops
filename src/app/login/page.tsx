import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { ConfigErrorView } from "@/components/config-error";
import { ConfigError, getConfig } from "@/server/config/env";
import { getOptionalSession } from "@/server/auth-dal";
import { fa } from "@/i18n/fa";

export const metadata: Metadata = { title: fa.login.title };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  let configured = false;
  try {
    configured = getConfig().auth.passwordHash !== null;
  } catch (e) {
    if (e instanceof ConfigError) return <ConfigErrorView problems={e.problems} />;
    throw e;
  }
  if (await getOptionalSession()) redirect("/apps");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <ShieldCheck aria-hidden />
          </div>
          <h1 className="text-lg font-medium">{fa.login.title}</h1>
          <CardDescription>{fa.app.name}</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm configured={configured} />
        </CardContent>
      </Card>
    </main>
  );
}
