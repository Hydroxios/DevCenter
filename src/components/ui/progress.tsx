import { cn } from "@/lib/utils";

/** Barre fine ; passe à l'avertissement puis au danger selon la valeur. */
export function Progress({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 90 ? "bg-destructive" : v >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${v}%` }} />
    </div>
  );
}
