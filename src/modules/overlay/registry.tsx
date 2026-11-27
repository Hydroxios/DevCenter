import type { LucideIcon } from "lucide-react";
import { Clock, Music2, NotebookPen } from "lucide-react";
import type { ReactNode } from "react";

import { ClockBody } from "@/modules/dashboard/clock";
import { NotesBody } from "@/modules/dashboard/widgets/notes";
import type { FloatingType } from "@/stores/overlay";
import { SpotifyWidget } from "./SpotifyWidget";

export interface FloatingDef {
  title: string;
  icon: LucideIcon;
  size: { w: number; h: number };
  min: { w: number; h: number };
  render: (size: { width: number; height: number }, id: string) => ReactNode;
}

/** Widgets disponibles en mode flottant. */
export const FLOATING: Record<FloatingType, FloatingDef> = {
  spotify: {
    title: "Spotify",
    icon: Music2,
    size: { w: 400, h: 170 },
    min: { w: 280, h: 140 },
    render: ({ width, height }) => <SpotifyWidget width={width} height={height} />,
  },
  clock: {
    title: "Horloge",
    icon: Clock,
    size: { w: 260, h: 130 },
    min: { w: 160, h: 80 },
    render: () => (
      <div className="flex h-full items-center justify-center p-3">
        <ClockBody settings={{}} />
      </div>
    ),
  },
  notes: {
    title: "Notes",
    icon: NotebookPen,
    size: { w: 300, h: 320 },
    min: { w: 220, h: 160 },
    render: () => (
      <div className="h-full overflow-auto p-3">
        <NotesBody />
      </div>
    ),
  },
};

export const FLOATING_TYPES = Object.keys(FLOATING) as FloatingType[];
