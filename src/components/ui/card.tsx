import * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-start justify-between gap-2", className)} {...props} />;
}

/** Titre de carte : petites capitales mono (« eyebrow » PowerBack). */
function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("eyebrow", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
