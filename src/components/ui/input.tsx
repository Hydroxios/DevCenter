import * as React from "react";

import { cn } from "@/lib/utils";

/** Champ « .field » de PowerBack. */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
