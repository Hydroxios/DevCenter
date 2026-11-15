import { cn } from "@/lib/utils";

/** Symbole « </> » : chevrons blancs, barre oblique cyan (même esprit que le logo PowerBack). */
export function LogoMark({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 7.5 3.5 12 8 16.5" className="stroke-foreground" strokeWidth="2" />
      <path d="M16 7.5 20.5 12 16 16.5" className="stroke-foreground" strokeWidth="2" />
      <path d="M13.6 5.5 10.4 18.5" className="stroke-primary" strokeWidth="2" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-mono text-sm tracking-tight", className)}>
      <LogoMark />
      <span>
        Dev<span className="text-primary">Center</span>
      </span>
    </span>
  );
}
