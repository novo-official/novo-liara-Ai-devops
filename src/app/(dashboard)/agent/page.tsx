import type { Metadata } from "next";
import { Bot } from "lucide-react";
import { AgentWorkspace } from "@/components/agent-workspace";
import { ui } from "@/i18n/agent-fa";
import { requireSession } from "@/server/auth-dal";
import { getConfig } from "@/server/config/env";
import { getService } from "@/server/liara/service";

export const metadata: Metadata = { title: ui.title };
export const dynamic = "force-dynamic";

export default async function AgentPage() {
  await requireSession();
  const svc = getService();
  const apps = await svc.listApps();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Bot className="size-6 text-primary" aria-hidden /> {ui.title}
        </h1>
        <p className="text-sm text-muted-foreground">{ui.subtitle}</p>
      </div>
      <AgentWorkspace apps={apps.ok ? apps.data.items.map((a) => a.name) : []} provider={getConfig().ai.provider} mode={svc.mode} />
    </div>
  );
}
