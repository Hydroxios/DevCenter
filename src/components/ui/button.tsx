import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Variantes calquées sur PowerBack : .btn (cyan), .btn-secondary, .btn-danger, .btn-icon.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition outline-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:ring-2 focus-visible:ring-ring/40",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-foreground hover:text-background",
        destructive: "bg-destructive text-black hover:bg-destructive/85",
        outline: "border bg-secondary text-foreground hover:border-primary/50 hover:text-primary",
        secondary: "border bg-secondary text-foreground hover:border-primary/50 hover:text-primary",
        ghost: "text-muted-foreground hover:bg-primary/10 hover:text-primary",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "size-9 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
