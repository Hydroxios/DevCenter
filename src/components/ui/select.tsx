import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/** Liste déroulante native stylée comme les champs (accessible au clavier, sans dépendance). */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-9 w-full appearance-none rounded-lg border border-input bg-card py-1 pr-8 pl-3 text-sm text-foreground outline-none transition hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { Select };
