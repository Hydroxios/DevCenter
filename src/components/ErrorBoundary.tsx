import { Component, type ErrorInfo, type ReactNode } from "react";
import { Copy, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/logger";

interface Props {
  children: ReactNode;
  /** Zone concernée, ajoutée au journal (« page /servers », « application »…). */
  scope: string;
  /** Plein écran (erreur hors des pages) plutôt que dans la zone de contenu. */
  fullScreen?: boolean;
}

interface State {
  error: Error | null;
  copied: boolean;
}

/**
 * Filet de sécurité : une erreur de rendu affiche un message et un bouton de reprise au lieu
 * d'un écran noir. L'erreur est écrite dans le journal de DevCenter.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(`Erreur d'affichage (${this.props.scope})`, error, info.componentStack ?? undefined);
  }

  private reset = () => this.setState({ error: null, copied: false });

  private copy = async () => {
    const { error } = this.state;
    if (!error) return;
    try {
      await navigator.clipboard.writeText(`${error.name}: ${error.message}\n${error.stack ?? ""}`);
      this.setState({ copied: true });
    } catch {
      /* presse-papiers indisponible */
    }
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.fullScreen ? "flex h-full items-center justify-center bg-background p-8" : "flex flex-1 items-center justify-center p-8"}>
        <div className="grid max-w-lg gap-4 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlert className="size-6" />
          </div>
          <div>
            <p className="font-medium">Cette page a rencontré une erreur</p>
            <p className="mt-1 text-sm text-muted-foreground">Le reste de DevCenter continue de fonctionner. L'erreur a été enregistrée dans le journal.</p>
          </div>
          <pre className="max-h-32 overflow-auto rounded-lg border bg-black p-3 text-left font-mono text-xs whitespace-pre-wrap text-[#fca5a5] select-text">
            {error.message || String(error)}
          </pre>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={this.copy}>
              <Copy /> {copied ? "Copié" : "Copier le détail"}
            </Button>
            <Button onClick={this.props.fullScreen ? () => window.location.reload() : this.reset}>
              <RotateCcw /> {this.props.fullScreen ? "Recharger" : "Réessayer"}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
