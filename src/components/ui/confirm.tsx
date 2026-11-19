import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Confirmation impérative : `if (await confirmAction({ … })) …`.
 * Sert surtout aux actions destructives lancées depuis un menu contextuel.
 */
interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Bouton rouge (par défaut). */
  danger?: boolean;
}

interface ConfirmState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
}

const useConfirm = create<ConfirmState>(() => ({ current: null }));

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().current?.resolve(false);
    useConfirm.setState({ current: { ...options, resolve } });
  });
}

const settle = (ok: boolean) => {
  const cur = useConfirm.getState().current;
  if (!cur) return;
  useConfirm.setState({ current: null });
  cur.resolve(ok);
};

/** À monter une fois (dans `App`). */
export function ConfirmHost() {
  const current = useConfirm((s) => s.current);
  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && settle(false)}>
      {current && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{current.title}</DialogTitle>
            {current.description && <DialogDescription>{current.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => settle(false)}>
              Annuler
            </Button>
            <Button variant={current.danger === false ? "default" : "destructive"} onClick={() => settle(true)} autoFocus>
              {current.confirmLabel ?? "Confirmer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
