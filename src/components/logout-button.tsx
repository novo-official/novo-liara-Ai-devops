"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fa } from "@/i18n/fa";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      className="min-h-11 px-3"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        } finally {
          router.replace("/login");
          router.refresh();
        }
      }}
    >
      <LogOut aria-hidden />
      {fa.nav.logout}
    </Button>
  );
}
