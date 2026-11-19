// Fonds animés du tableau de bord, dessinés sur un seul <canvas> derrière la grille.
// Chaque effet est une petite simulation (init + step) ; la boucle s'arrête quand la fenêtre est
// cachée et se limite à une image fixe si le système demande de réduire les animations.

import { memo, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type { BackgroundKind, BackgroundSettings } from "./config";

type RGB = [number, number, number];

interface Ctx {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** Couleur d'accent et une teinte voisine (décalée), pour varier les effets. */
  c1: RGB;
  c2: RGB;
  /** Couleur du texte (blanc en sombre, noir en clair) pour les reflets. */
  fg: RGB;
  intensity: number;
  /** Charge CPU (historique total et par cœur) et instant de la dernière mesure, pour l'oscilloscope. */
  signal: Signal;
}

interface Signal {
  cpu: number[];
  cores: number[][];
  at: number;
}

interface Effect {
  /** Facteur de résolution du canvas (les effets flous se contentent de peu de pixels). */
  scale: number;
  /** Flou CSS appliqué à la toile, en px (effets vaporeux). */
  blur?: number;
  init(ctx: Ctx): void;
  /** t en secondes (déjà multiplié par la vitesse), dt idem ; real = dt réel (effets de clic). */
  step(ctx: Ctx, t: number, dt: number, real: number): void;
  /** Vrai si un clic en (x, y) aurait un effet (curseur main). */
  hit?(x: number, y: number): boolean;
  /** Clic en (x, y) ; vrai s'il a eu un effet. */
  poke?(x: number, y: number): boolean;
}

const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function parseColor(value: string): RGB {
  const v = value.trim();
  if (v.startsWith("#")) {
    const hex = v.length === 4 ? v.slice(1).replace(/./g, (c) => c + c) : v.slice(1, 7);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/[\d.]+/g);
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [34, 211, 238];
}

/* ------------------------------------------------------------------ */
/* Réseau neuronal : nœuds qui dérivent, liens selon la distance,      */
/* impulsions qui parcourent les liens.                                */
/* ------------------------------------------------------------------ */

function neural(): Effect {
  type Node = { x: number; y: number; vx: number; vy: number; r: number; phase: number };
  type Pulse = { a: number; b: number; p: number; v: number };
  let nodes: Node[] = [];
  let pulses: Pulse[] = [];
  let link = 150;
  let spawn = 0;
  return {
    scale: 1,
    init({ w, h }) {
      const n = Math.min(110, Math.max(30, Math.round((w * h) / 14000)));
      link = Math.max(110, Math.min(180, Math.sqrt((w * h) / n) * 1.6));
      nodes = Array.from({ length: n }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        vx: rand(-12, 12),
        vy: rand(-12, 12),
        r: rand(1.2, 2.6),
        phase: rand(0, Math.PI * 2),
      }));
      pulses = [];
    },
    step({ g, w, h, c1, c2, intensity }, t, dt) {
      g.clearRect(0, 0, w, h);
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (n.x < -20) n.x = w + 20;
        else if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        else if (n.y > h + 20) n.y = -20;
      }
      // Liens.
      const edges: [number, number][] = [];
      g.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > link * link) continue;
          const k = 1 - Math.sqrt(d2) / link;
          edges.push([i, j]);
          g.strokeStyle = rgba(c1, k * 0.35 * intensity);
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
      // Impulsions : une nouvelle de temps en temps sur un lien existant.
      spawn -= dt;
      if (spawn <= 0 && edges.length && pulses.length < 24) {
        const [a, b] = edges[(Math.random() * edges.length) | 0];
        pulses.push(Math.random() < 0.5 ? { a, b, p: 0, v: rand(0.6, 1.4) } : { a: b, b: a, p: 0, v: rand(0.6, 1.4) });
        spawn = rand(0.05, 0.25);
      }
      g.globalCompositeOperation = "lighter";
      pulses = pulses.filter((p) => {
        p.p += p.v * dt;
        if (p.p >= 1) {
          // L'impulsion se propage parfois au voisin suivant.
          const next = Math.random() < 0.55 && edges.find(([x, y]) => (x === p.b && y !== p.a) || (y === p.b && x !== p.a));
          if (next) {
            const to = next[0] === p.b ? next[1] : next[0];
            Object.assign(p, { a: p.b, b: to, p: 0 });
          } else return false;
        }
        const A = nodes[p.a];
        const B = nodes[p.b];
        const dx = A.x - B.x;
        const dy = A.y - B.y;
        if (dx * dx + dy * dy > link * link * 1.4) return false;
        const x = A.x + (B.x - A.x) * p.p;
        const y = A.y + (B.y - A.y) * p.p;
        const grad = g.createRadialGradient(x, y, 0, x, y, 10);
        grad.addColorStop(0, rgba(c2, 0.9 * intensity));
        grad.addColorStop(1, rgba(c2, 0));
        g.fillStyle = grad;
        g.fillRect(x - 10, y - 10, 20, 20);
        return true;
      });
      // Nœuds (léger battement).
      for (const n of nodes) {
        const pulse = 0.6 + 0.4 * Math.sin(t * 1.6 + n.phase);
        g.fillStyle = rgba(c1, 0.15 * intensity * pulse);
        g.beginPath();
        g.arc(n.x, n.y, n.r * 3.5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = rgba(c1, (0.55 + 0.35 * pulse) * intensity);
        g.beginPath();
        g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Brouillard : grandes nappes floues qui dérivent lentement.          */
/* ------------------------------------------------------------------ */

function fog(): Effect {
  type Blob = { x: number; y: number; r: number; ax: number; ay: number; fx: number; fy: number; ph: number; tint: number };
  let blobs: Blob[] = [];
  return {
    scale: 0.25,
    init({ w, h }) {
      const m = Math.max(w, h);
      blobs = Array.from({ length: 9 }, (_, i) => ({
        x: rand(0, w),
        y: rand(h * 0.2, h),
        r: rand(0.35, 0.65) * m,
        ax: rand(0.15, 0.35) * w,
        ay: rand(0.05, 0.15) * h,
        fx: rand(0.02, 0.06),
        fy: rand(0.03, 0.07),
        ph: rand(0, Math.PI * 2),
        tint: i % 3,
      }));
    },
    step({ g, w, h, c1, c2, fg, intensity }, t) {
      g.clearRect(0, 0, w, h);
      for (const b of blobs) {
        const x = b.x + Math.sin(t * b.fx + b.ph) * b.ax;
        const y = b.y + Math.cos(t * b.fy + b.ph * 1.3) * b.ay;
        const breathe = 0.75 + 0.25 * Math.sin(t * 0.15 + b.ph);
        const col = b.tint === 0 ? c1 : b.tint === 1 ? c2 : fg;
        const a = (b.tint === 2 ? 0.05 : 0.11) * intensity * breathe;
        const grad = g.createRadialGradient(x, y, 0, x, y, b.r);
        grad.addColorStop(0, rgba(col, a));
        grad.addColorStop(0.5, rgba(col, a * 0.5));
        grad.addColorStop(1, rgba(col, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bulles : montent en ondulant, reflet en haut à gauche.              */
/* ------------------------------------------------------------------ */

function bubbles(): Effect {
  type Bubble = { x: number; y: number; r: number; v: number; wob: number; ph: number; tint: boolean; cx: number };
  type Drop = { x: number; y: number; vx: number; vy: number; life: number; size: number; tint: boolean };
  type Ring = { x: number; y: number; r0: number; life: number; tint: boolean };
  let list: Bubble[] = [];
  let drops: Drop[] = [];
  let rings: Ring[] = [];
  let size = { w: 0, h: 0 };
  /** Bulle sous le pointeur (la plus petite si plusieurs se chevauchent : c'est celle du dessus visuellement). */
  const at = (x: number, y: number) => {
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const dx = x - b.cx;
      const dy = y - b.y;
      const reach = Math.max(b.r, 10);
      if (dx * dx + dy * dy <= reach * reach && (best < 0 || b.r < list[best].r)) best = i;
    }
    return best;
  };
  const make = (w: number, h: number, anywhere: boolean): Bubble => {
    const r = Math.pow(Math.random(), 2.2) * 34 + 3;
    const x = rand(0, w);
    return { x, cx: x, y: anywhere ? rand(0, h) : h + r + rand(0, 80), r, v: rand(14, 36) + (40 - r) * 0.5, wob: rand(6, 22), ph: rand(0, Math.PI * 2), tint: Math.random() < 0.35 };
  };
  return {
    scale: 1,
    hit: (x, y) => at(x, y) >= 0,
    poke(x, y) {
      const i = at(x, y);
      if (i < 0) return false;
      const b = list[i];
      // Gouttelettes projetées tout autour, plus nombreuses pour une grosse bulle.
      const n = Math.round(8 + b.r * 0.6);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rand(-0.2, 0.2);
        const sp = rand(60, 140) + b.r * 3;
        drops.push({
          x: b.cx + Math.cos(a) * b.r,
          y: b.y + Math.sin(a) * b.r,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 1,
          size: rand(0.8, 2.2) + b.r * 0.04,
          tint: b.tint,
        });
      }
      rings.push({ x: b.cx, y: b.y, r0: b.r, life: 1, tint: b.tint });
      // Une nouvelle bulle repart du bas : le fond ne se vide pas.
      list[i] = make(size.w, size.h, false);
      return true;
    },
    init({ w, h }) {
      size = { w, h };
      const n = Math.min(70, Math.max(20, Math.round((w * h) / 22000)));
      list = Array.from({ length: n }, () => make(w, h, true));
    },
    step({ g, w, h, c1, c2, fg, intensity }, t, dt, real) {
      size = { w, h };
      g.clearRect(0, 0, w, h);
      // Éclatements : anneau qui s'élargit et gouttelettes qui retombent (temps réel, indépendant de la vitesse).
      rings = rings.filter((r) => (r.life -= real * 3.2) > 0);
      for (const r of rings) {
        const k = 1 - r.life;
        g.strokeStyle = rgba(r.tint ? c2 : c1, r.life * 0.8 * intensity + 0.1);
        g.lineWidth = 1.5 * r.life + 0.3;
        g.beginPath();
        g.arc(r.x, r.y, r.r0 * (1 + k * 0.8), 0, Math.PI * 2);
        g.stroke();
      }
      drops = drops.filter((d) => (d.life -= real * 1.8) > 0);
      for (const d of drops) {
        d.vx *= 1 - 3 * real;
        d.vy = d.vy * (1 - 3 * real) + 260 * real;
        d.x += d.vx * real;
        d.y += d.vy * real;
        g.fillStyle = rgba(d.tint ? c2 : c1, d.life * (0.5 + 0.5 * intensity));
        g.beginPath();
        g.arc(d.x, d.y, d.size * (0.5 + 0.5 * d.life), 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        b.y -= b.v * dt;
        if (b.y < -b.r * 2) list[i] = make(w, h, false);
        const x = b.x + Math.sin(t * 0.9 + b.ph) * b.wob;
        b.cx = x;
        const col = b.tint ? c2 : c1;
        // Intérieur translucide, plus dense vers le bord (effet de membrane).
        const body = g.createRadialGradient(x, b.y, b.r * 0.2, x, b.y, b.r);
        body.addColorStop(0, rgba(col, 0));
        body.addColorStop(0.8, rgba(col, 0.06 * intensity));
        body.addColorStop(1, rgba(col, 0.22 * intensity));
        g.fillStyle = body;
        g.beginPath();
        g.arc(x, b.y, b.r, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = rgba(col, 0.4 * intensity);
        g.lineWidth = 1;
        g.stroke();
        // Reflet.
        g.fillStyle = rgba(fg, 0.35 * intensity);
        g.beginPath();
        g.ellipse(x - b.r * 0.38, b.y - b.r * 0.42, b.r * 0.22, b.r * 0.12, -Math.PI / 4, 0, Math.PI * 2);
        g.fill();
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Halos : anneaux lumineux qui orbitent et respirent.                 */
/* ------------------------------------------------------------------ */

function halos(): Effect {
  type Halo = { cx: number; cy: number; orbit: number; f: number; ph: number; r: number; tint: boolean };
  let list: Halo[] = [];
  return {
    scale: 0.5,
    init({ w, h }) {
      const m = Math.min(w, h);
      list = Array.from({ length: 6 }, (_, i) => ({
        cx: rand(0.15, 0.85) * w,
        cy: rand(0.15, 0.85) * h,
        orbit: rand(0.05, 0.18) * m,
        f: rand(0.05, 0.14) * (i % 2 ? 1 : -1),
        ph: rand(0, Math.PI * 2),
        r: rand(0.18, 0.42) * m,
        tint: i % 2 === 1,
      }));
    },
    step({ g, w, h, c1, c2, intensity }, t) {
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = "lighter";
      for (const o of list) {
        const x = o.cx + Math.cos(t * o.f + o.ph) * o.orbit;
        const y = o.cy + Math.sin(t * o.f * 1.3 + o.ph) * o.orbit;
        const breathe = 0.5 + 0.5 * Math.sin(t * 0.4 + o.ph);
        const r = o.r * (0.9 + 0.15 * breathe);
        const col = o.tint ? c2 : c1;
        const a = (0.1 + 0.08 * breathe) * intensity;
        // Lueur centrale diffuse.
        const glow = g.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, rgba(col, a * 0.6));
        glow.addColorStop(0.55, rgba(col, a * 0.15));
        glow.addColorStop(0.78, rgba(col, a));
        glow.addColorStop(0.86, rgba(col, a * 0.25));
        glow.addColorStop(1, rgba(col, 0));
        g.fillStyle = glow;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Vagues : couches de houle superposées en bas de l'écran.            */
/* ------------------------------------------------------------------ */

function waves(): Effect {
  type Wave = { base: number; amp: number; len: number; speed: number; ph: number; tint: boolean };
  let list: Wave[] = [];
  return {
    scale: 1,
    init() {
      list = Array.from({ length: 5 }, (_, i) => ({
        base: 0.5 + i * 0.09,
        amp: rand(18, 42) - i * 3,
        len: rand(380, 720),
        speed: rand(0.25, 0.6) * (i % 2 ? 1 : -1),
        ph: rand(0, Math.PI * 2),
        tint: i % 2 === 1,
      }));
    },
    step({ g, w, h, c1, c2, intensity }, t) {
      g.clearRect(0, 0, w, h);
      const stepX = 8;
      list.forEach((wv, i) => {
        const col = wv.tint ? c2 : c1;
        const baseY = h * wv.base;
        const yAt = (x: number) =>
          baseY +
          Math.sin((x / wv.len) * Math.PI * 2 + t * wv.speed * 2 + wv.ph) * wv.amp +
          Math.sin((x / (wv.len * 0.47)) * Math.PI * 2 - t * wv.speed * 1.3 + wv.ph * 2) * wv.amp * 0.35;
        g.beginPath();
        g.moveTo(0, yAt(0));
        for (let x = stepX; x <= w + stepX; x += stepX) g.lineTo(x, yAt(x));
        // Crête lumineuse.
        g.strokeStyle = rgba(col, (0.35 + i * 0.05) * intensity);
        g.lineWidth = 1.25;
        g.stroke();
        // Corps de la vague, qui s'efface vers le bas.
        g.lineTo(w, h);
        g.lineTo(0, h);
        g.closePath();
        const fill = g.createLinearGradient(0, baseY - wv.amp, 0, h);
        fill.addColorStop(0, rgba(col, 0.1 * intensity));
        fill.addColorStop(1, rgba(col, 0.01));
        g.fillStyle = fill;
        g.fill();
      });
    },
  };
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Bruit lisse peu coûteux (somme de sinus), entre -1 et 1. */
const wobble = (x: number, s: number) => Math.sin(x + s) * 0.5 + Math.sin(x * 2.17 + s * 1.7) * 0.3 + Math.sin(x * 4.31 + s * 0.6) * 0.2;

/**
 * Efface progressivement l'image précédente (traînées), à raison de `rate` par seconde.
 * Sous ~8 % par passe, l'arrondi 8 bits laisse des fantômes qui ne s'effacent jamais :
 * l'effacement est donc cumulé et appliqué par passes d'au moins 8 %.
 */
function fader(rate: number) {
  let debt = 0;
  return (g: CanvasRenderingContext2D, w: number, h: number, real: number) => {
    debt = 1 - (1 - debt) * Math.exp(-real * rate);
    if (debt < 0.08) return;
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = `rgba(0,0,0,${debt})`;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    debt = 0;
  };
}

/* ------------------------------------------------------------------ */
/* Pluie de code : colonnes de caractères mono qui tombent.            */
/* ------------------------------------------------------------------ */

function codeRain(): Effect {
  const CELL = 16;
  const CHARS = "01{}[]()<>=+-*/;:.&|!?#$%_~λΣπ0123456789abcdefABCDEF";
  type Col = { y: number; v: number; cell: number; on: boolean; wait: number };
  let cols: Col[] = [];
  const pick = () => CHARS[(Math.random() * CHARS.length) | 0];
  const fade = fader(3.5);
  return {
    scale: 1,
    init({ w, h }) {
      cols = Array.from({ length: Math.ceil(w / CELL) + 1 }, () => ({
        y: rand(0, h / CELL),
        v: rand(5, 14),
        cell: -1,
        on: Math.random() < 0.45,
        wait: rand(0, 4),
      }));
    },
    step({ g, w, h, c1, fg, intensity }, _t, dt, real) {
      fade(g, w, h, real);
      g.font = `${CELL - 3}px "Geist Mono Variable", Consolas, monospace`;
      g.textAlign = "center";
      g.textBaseline = "top";
      const rows = Math.ceil(h / CELL);
      // Colonnes ajoutées si la fenêtre s'élargit.
      while (cols.length < Math.ceil(w / CELL) + 1) cols.push({ y: 0, v: rand(5, 14), cell: -1, on: false, wait: rand(0, 3) });
      cols.forEach((c, i) => {
        if (!c.on) {
          if ((c.wait -= dt) <= 0) Object.assign(c, { on: true, y: 0, cell: -1, v: rand(5, 14) });
          return;
        }
        c.y += c.v * dt;
        const x = i * CELL + CELL / 2;
        while (c.cell < Math.floor(c.y)) {
          // L'ancienne tête redevient un caractère ordinaire, la nouvelle s'allume en blanc.
          if (c.cell >= 0) {
            g.clearRect(i * CELL, c.cell * CELL, CELL, CELL);
            g.fillStyle = rgba(c1, 0.85 * intensity);
            g.fillText(pick(), x, c.cell * CELL);
          }
          c.cell++;
          g.fillStyle = rgba(fg, 0.9 * intensity);
          g.fillText(pick(), x, c.cell * CELL);
        }
        if (c.cell > rows + 2) Object.assign(c, { on: false, wait: rand(0.2, 3) });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Circuit imprimé : pistes à 45°, impulsions jusqu'aux pastilles.     */
/* ------------------------------------------------------------------ */

function circuit(): Effect {
  const GRID = 24;
  const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  type Trace = { pts: [number, number][]; seg: number[]; len: number; glow: number };
  type Pulse = { tr: number; s: number; v: number; tint: boolean };
  let traces: Trace[] = [];
  let pulses: Pulse[] = [];
  let spawn = 0;
  const pointAt = (tr: Trace, s: number): [number, number] => {
    s = clamp(s, 0, tr.len);
    for (let i = 0; i < tr.seg.length; i++) {
      if (s <= tr.seg[i] || i === tr.seg.length - 1) {
        const k = tr.seg[i] ? s / tr.seg[i] : 0;
        const [ax, ay] = tr.pts[i];
        const [bx, by] = tr.pts[i + 1];
        return [ax + (bx - ax) * k, ay + (by - ay) * k];
      }
      s -= tr.seg[i];
    }
    return tr.pts[0];
  };
  return {
    scale: 1,
    init({ w, h }) {
      const n = clamp(Math.round((w * h) / 26000), 14, 60);
      traces = Array.from({ length: n }, () => {
        let x = Math.round(rand(0, w) / GRID) * GRID;
        let y = Math.round(rand(0, h) / GRID) * GRID;
        let d = ((Math.random() * 4) | 0) * 2;
        const pts: [number, number][] = [[x, y]];
        const steps = 3 + ((Math.random() * 6) | 0);
        for (let k = 0; k < steps; k++) {
          const run = 2 + ((Math.random() * 6) | 0);
          x += DIRS[d][0] * GRID * run;
          y += DIRS[d][1] * GRID * run;
          pts.push([x, y]);
          d = (d + (Math.random() < 0.5 ? 1 : 7)) % 8;
        }
        const seg = pts.slice(1).map(([bx, by], i) => Math.hypot(bx - pts[i][0], by - pts[i][1]));
        return { pts, seg, len: seg.reduce((a, b) => a + b, 0), glow: 0 };
      });
      pulses = [];
    },
    step({ g, w, h, c1, c2, intensity }, _t, dt) {
      g.clearRect(0, 0, w, h);
      g.lineJoin = "round";
      g.lineWidth = 1.5;
      g.strokeStyle = rgba(c1, 0.14 * intensity);
      g.beginPath();
      for (const tr of traces) {
        g.moveTo(tr.pts[0][0], tr.pts[0][1]);
        for (let i = 1; i < tr.pts.length; i++) g.lineTo(tr.pts[i][0], tr.pts[i][1]);
      }
      g.stroke();
      // Pastilles aux deux bouts ; celle d'arrivée s'allume quand une impulsion l'atteint.
      for (const tr of traces) {
        tr.glow = Math.max(0, tr.glow - dt * 1.2);
        for (const [i, [px, py]] of [tr.pts[0], tr.pts[tr.pts.length - 1]].entries()) {
          const lit = i === 1 ? tr.glow : 0;
          if (lit > 0) {
            const gl = g.createRadialGradient(px, py, 0, px, py, 18);
            gl.addColorStop(0, rgba(c1, 0.6 * lit * intensity));
            gl.addColorStop(1, rgba(c1, 0));
            g.fillStyle = gl;
            g.fillRect(px - 18, py - 18, 36, 36);
          }
          g.fillStyle = rgba(c1, (0.18 + 0.7 * lit) * intensity);
          g.strokeStyle = rgba(c1, 0.35 * intensity);
          g.beginPath();
          g.arc(px, py, 3.2, 0, TAU);
          g.fill();
          g.stroke();
        }
      }
      spawn -= dt;
      if (spawn <= 0 && pulses.length < 18) {
        pulses.push({ tr: (Math.random() * traces.length) | 0, s: 0, v: rand(90, 220), tint: Math.random() < 0.3 });
        spawn = rand(0.08, 0.4);
      }
      g.globalCompositeOperation = "lighter";
      pulses = pulses.filter((p) => {
        const tr = traces[p.tr];
        p.s += p.v * dt;
        if (p.s >= tr.len + 40) return false;
        if (p.s >= tr.len) tr.glow = 1;
        const col = p.tint ? c2 : c1;
        for (let k = 0; k < 10; k++) {
          const [x, y] = pointAt(tr, p.s - k * 4);
          const f = 1 - k / 10;
          g.fillStyle = rgba(col, f * 0.8 * intensity);
          g.beginPath();
          g.arc(x, y, 2.2 * f + 0.4, 0, TAU);
          g.fill();
        }
        const [x, y] = pointAt(tr, p.s);
        const gl = g.createRadialGradient(x, y, 0, x, y, 12);
        gl.addColorStop(0, rgba(col, 0.5 * intensity));
        gl.addColorStop(1, rgba(col, 0));
        g.fillStyle = gl;
        g.fillRect(x - 12, y - 12, 24, 24);
        return true;
      });
      g.globalCompositeOperation = "source-over";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Grille rétro : sol quadrillé qui défile vers un soleil à rayures.   */
/* ------------------------------------------------------------------ */

function retroGrid(): Effect {
  return {
    scale: 1,
    init() {},
    step({ g, w, h, c1, c2, intensity }, t) {
      g.clearRect(0, 0, w, h);
      const hz = h * 0.45;
      const cx = w / 2;
      // Ciel.
      const sky = g.createLinearGradient(0, 0, 0, hz);
      sky.addColorStop(0, rgba(c2, 0));
      sky.addColorStop(1, rgba(c2, 0.14 * intensity));
      g.fillStyle = sky;
      g.fillRect(0, 0, w, hz);
      // Soleil coupé de bandes qui descendent.
      const R = Math.min(w, h) * 0.24;
      g.save();
      g.beginPath();
      g.arc(cx, hz, R, Math.PI, TAU);
      g.clip();
      const sun = g.createLinearGradient(0, hz - R, 0, hz);
      sun.addColorStop(0, rgba(c2, 0.45 * intensity));
      sun.addColorStop(1, rgba(c1, 0.3 * intensity));
      g.fillStyle = sun;
      g.fillRect(cx - R, hz - R, R * 2, R);
      const band = R / 7;
      const off = (t * 6) % band;
      for (let y = hz - R * 0.55 + off; y < hz; y += band) {
        const k = (y - (hz - R * 0.55)) / (R * 0.55);
        g.clearRect(cx - R, y, R * 2, Math.max(1, band * 0.15 + k * band * 0.45));
      }
      g.restore();
      const halo = g.createRadialGradient(cx, hz, R * 0.8, cx, hz, R * 2);
      halo.addColorStop(0, rgba(c2, 0.12 * intensity));
      halo.addColorStop(1, rgba(c2, 0));
      g.fillStyle = halo;
      g.fillRect(cx - R * 2, hz - R * 2, R * 4, R * 2);
      // Sol.
      const floor = g.createLinearGradient(0, hz, 0, h);
      floor.addColorStop(0, rgba(c1, 0.1 * intensity));
      floor.addColorStop(1, rgba(c1, 0.02 * intensity));
      g.fillStyle = floor;
      g.fillRect(0, hz, w, h - hz);
      g.lineWidth = 1;
      // Lignes fuyantes.
      // Elles s'effacent vers l'horizon, sinon elles s'y tassent en moiré.
      const N = 16;
      const fadeUp = g.createLinearGradient(0, hz, 0, h);
      fadeUp.addColorStop(0, rgba(c1, 0));
      fadeUp.addColorStop(0.25, rgba(c1, 0.15 * intensity));
      fadeUp.addColorStop(1, rgba(c1, 0.45 * intensity));
      g.strokeStyle = fadeUp;
      g.beginPath();
      for (let i = -N; i <= N; i++) {
        g.moveTo(cx + i * (w / N) * 0.06, hz);
        g.lineTo(cx + i * (w / N) * 1.6, h);
      }
      g.stroke();
      // Lignes transversales qui avancent vers nous.
      const frac = (t * 0.9) % 1;
      for (let k = 0; k < 28; k++) {
        const z = k + 1 - frac;
        const y = hz + (h - hz) / (1 + z * 0.55);
        const near = (y - hz) / (h - hz);
        g.strokeStyle = rgba(c1, (0.08 + 0.45 * near) * intensity);
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }
      // Ligne d'horizon.
      g.strokeStyle = rgba(c2, 0.55 * intensity);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, hz);
      g.lineTo(w, hz);
      g.stroke();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Oscilloscope : trace la charge CPU réelle, balayage phosphore.      */
/* ------------------------------------------------------------------ */

function scope(): Effect {
  const VISIBLE = 90; // 3 minutes de mesures (une toutes les 2 s)
  let beam = 0;
  /** Valeur (0-100) à la position p (index flottant) d'une série. */
  const sample = (s: number[], p: number) => {
    p = clamp(p, 0, s.length - 1);
    const i = Math.floor(p);
    const k = p - i;
    return s[i] + ((s[Math.min(i + 1, s.length - 1)] ?? s[i]) - s[i]) * k;
  };
  return {
    scale: 1,
    init() {},
    step({ g, w, h, c1, c2, fg, intensity, signal }, t, dt) {
      g.clearRect(0, 0, w, h);
      // Graticule.
      g.lineWidth = 1;
      g.strokeStyle = rgba(c1, 0.06 * intensity);
      g.beginPath();
      for (let i = 1; i < 10; i++) {
        g.moveTo((w * i) / 10, 0);
        g.lineTo((w * i) / 10, h);
      }
      for (let i = 1; i < 8; i++) {
        g.moveTo(0, (h * i) / 8);
        g.lineTo(w, (h * i) / 8);
      }
      g.stroke();
      g.strokeStyle = rgba(c1, 0.12 * intensity);
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();

      const live = signal.cpu.length > 1;
      // Défilement continu entre deux mesures.
      const frac = live ? clamp((performance.now() - signal.at) / 2000, 0, 1) : 0;
      const valueAt = (s: number[], xn: number) =>
        live ? sample(s, s.length - 2 + frac - (1 - xn) * (VISIBLE - 1)) : 45 + 30 * wobble(xn * 9, t * 0.6);
      const yOf = (v: number, x: number) => h * 0.5 + ((50 - v) / 100) * h * 0.7 + Math.sin(x * 0.35 + t * 30) * 0.8;

      // Cœurs : traces fines en arrière-plan.
      if (live) {
        g.lineWidth = 1;
        g.strokeStyle = rgba(c2, 0.1 * intensity);
        for (const core of signal.cores) {
          if (core.length < 2) continue;
          g.beginPath();
          for (let x = 0; x <= w; x += 6) {
            const y = yOf(valueAt(core, x / w), x);
            if (x) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
          g.stroke();
        }
      }

      // Trace principale : plus vive juste derrière le faisceau (rémanence du phosphore).
      beam = (beam + dt * w * 0.3) % w;
      const STEP = 4;
      let px = 0;
      let py = yOf(valueAt(signal.cpu, 0), 0);
      for (let x = STEP; x <= w + STEP; x += STEP) {
        const y = yOf(valueAt(signal.cpu, x / w), x);
        const d = (beam - x + w) % w;
        const a = (0.2 + 0.8 * Math.exp(-d / (w * 0.22))) * intensity;
        g.strokeStyle = rgba(c1, a * 0.18);
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(x, y);
        g.stroke();
        g.strokeStyle = rgba(c1, a);
        g.lineWidth = 1.5;
        g.stroke();
        px = x;
        py = y;
      }
      // Point du faisceau.
      const by = yOf(valueAt(signal.cpu, beam / w), beam);
      const spot = g.createRadialGradient(beam, by, 0, beam, by, 16);
      spot.addColorStop(0, rgba(fg, 0.8 * intensity));
      spot.addColorStop(0.3, rgba(c1, 0.5 * intensity));
      spot.addColorStop(1, rgba(c1, 0));
      g.fillStyle = spot;
      g.fillRect(beam - 16, by - 16, 32, 32);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Aurore : rideaux de lumière qui ondulent.                           */
/* ------------------------------------------------------------------ */

function aurora(): Effect {
  type Curtain = { base: number; height: number; f: number; ph: number; drift: number; tint: boolean };
  let list: Curtain[] = [];
  return {
    scale: 0.5,
    blur: 10,
    init() {
      list = Array.from({ length: 4 }, (_, i) => ({
        base: rand(0.3, 0.5),
        height: rand(0.25, 0.45),
        f: rand(0.002, 0.005),
        ph: rand(0, 100),
        drift: rand(0.15, 0.35),
        tint: i % 2 === 1,
      }));
    },
    step({ g, w, h, c1, c2, intensity }, t) {
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = "lighter";
      for (const c of list) {
        const H = c.height * h;
        const top = c.tint ? c1 : c2;
        const bottom = c.tint ? c2 : c1;
        const grad = g.createLinearGradient(0, 0, 0, -H);
        grad.addColorStop(0, rgba(bottom, 0));
        grad.addColorStop(0.06, rgba(bottom, 0.55));
        grad.addColorStop(0.4, rgba(top, 0.22));
        grad.addColorStop(1, rgba(top, 0));
        g.fillStyle = grad;
        const STEP = 8;
        for (let x = -STEP; x < w + STEP; x += STEP) {
          const y = c.base * h + wobble(x * c.f, t * 0.25 + c.ph) * h * 0.09;
          const bright = clamp(0.55 + 0.6 * wobble(x * c.f * 2.6, t * c.drift + c.ph * 2), 0, 1);
          if (bright < 0.02) continue;
          const stretch = 0.6 + 0.4 * wobble(x * c.f * 1.5, t * 0.2 + c.ph);
          g.globalAlpha = bright * intensity * 0.85;
          g.save();
          g.translate(x, y);
          g.scale(1, Math.max(0.15, stretch));
          g.fillRect(0, -H, STEP + 1, H);
          g.restore();
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Étoiles : voyage en profondeur, étoiles filantes de temps en temps. */
/* ------------------------------------------------------------------ */

function stars(): Effect {
  type Star = { x: number; y: number; z: number; tint: 0 | 1 | 2 };
  type Shooting = { x: number; y: number; vx: number; vy: number; life: number };
  let list: Star[] = [];
  let shooting: Shooting[] = [];
  let next = 3;
  const make = (z = rand(0.05, 1)): Star => {
    const r = Math.random();
    return { x: rand(-1, 1), y: rand(-1, 1), z, tint: r < 0.15 ? 1 : r < 0.25 ? 2 : 0 };
  };
  return {
    scale: 1,
    init({ w, h }) {
      list = Array.from({ length: clamp(Math.round((w * h) / 3500), 150, 500) }, () => make());
    },
    step({ g, w, h, c1, c2, fg, intensity }, _t, dt) {
      g.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const f = Math.max(w, h) * 0.5;
      g.lineCap = "round";
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const pz = s.z;
        s.z -= dt * 0.08;
        const x = cx + (s.x / s.z) * f;
        const y = cy + (s.y / s.z) * f;
        if (s.z <= 0.02 || x < -20 || x > w + 20 || y < -20 || y > h + 20) {
          list[i] = make(1);
          continue;
        }
        const near = 1 - s.z;
        g.strokeStyle = rgba(s.tint === 1 ? c1 : s.tint === 2 ? c2 : fg, (0.35 + 0.65 * near) * intensity);
        g.lineWidth = 1 + near * 2.2;
        g.beginPath();
        g.moveTo(cx + (s.x / pz) * f, cy + (s.y / pz) * f);
        g.lineTo(x + 0.01, y);
        g.stroke();
      }
      // Étoiles filantes.
      if ((next -= dt) <= 0) {
        const a = rand(0.3, 0.7) + (Math.random() < 0.5 ? 0 : Math.PI - 1);
        const sp = rand(600, 1000);
        shooting.push({ x: rand(0.1, 0.9) * w, y: rand(0, 0.4) * h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 });
        next = rand(3, 8);
      }
      shooting = shooting.filter((s) => {
        s.life -= dt * 1.4;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.life <= 0) return false;
        const tx = s.x - s.vx * 0.12;
        const ty = s.y - s.vy * 0.12;
        const tail = g.createLinearGradient(s.x, s.y, tx, ty);
        tail.addColorStop(0, rgba(fg, s.life * intensity));
        tail.addColorStop(0.3, rgba(c1, s.life * 0.5 * intensity));
        tail.addColorStop(1, rgba(c1, 0));
        g.strokeStyle = tail;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(s.x, s.y);
        g.lineTo(tx, ty);
        g.stroke();
        return true;
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lucioles : points lumineux qui errent et clignotent.                */
/* ------------------------------------------------------------------ */

function fireflies(): Effect {
  type Fly = { x: number; y: number; a: number; v: number; ph: number; period: number; tint: boolean };
  let list: Fly[] = [];
  return {
    scale: 1,
    init({ w, h }) {
      list = Array.from({ length: clamp(Math.round((w * h) / 30000), 20, 60) }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        a: rand(0, TAU),
        v: rand(12, 30),
        ph: rand(0, 100),
        period: rand(2.5, 6),
        tint: Math.random() < 0.3,
      }));
    },
    step({ g, w, h, c1, c2, fg, intensity }, t, dt) {
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = "lighter";
      for (const f of list) {
        f.a += wobble(t * 0.4, f.ph) * dt * 2;
        f.x += Math.cos(f.a) * f.v * dt;
        f.y += Math.sin(f.a) * f.v * dt;
        if (f.x < -30) f.x = w + 30;
        else if (f.x > w + 30) f.x = -30;
        if (f.y < -30) f.y = h + 30;
        else if (f.y > h + 30) f.y = -30;
        // Allumage bref puis extinction lente.
        const glow = Math.pow(Math.max(0, Math.sin((t / f.period) * TAU + f.ph)), 4);
        const col = f.tint ? c2 : c1;
        const R = 10 + glow * 18;
        const gl = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, R);
        gl.addColorStop(0, rgba(col, (0.08 + 0.6 * glow) * intensity));
        gl.addColorStop(1, rgba(col, 0));
        g.fillStyle = gl;
        g.fillRect(f.x - R, f.y - R, R * 2, R * 2);
        g.fillStyle = rgba(glow > 0.5 ? fg : col, (0.25 + 0.75 * glow) * intensity);
        g.beginPath();
        g.arc(f.x, f.y, 1.2 + glow, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Flux : particules entraînées par un champ de courant.               */
/* ------------------------------------------------------------------ */

function flow(): Effect {
  type P = { x: number; y: number; life: number };
  let list: P[] = [];
  const spawn = (w: number, h: number): P => ({ x: rand(0, w), y: rand(0, h), life: rand(2, 8) });
  const fade = fader(0.9);
  return {
    scale: 1,
    init({ w, h }) {
      list = Array.from({ length: clamp(Math.round((w * h) / 1100), 400, 1600) }, () => spawn(w, h));
    },
    step({ g, w, h, c1, c2, intensity }, t, dt, real) {
      fade(g, w, h, real);
      g.lineWidth = 1;
      const paths = [new Path2D(), new Path2D()];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const ang =
          (Math.sin(p.x * 0.0021 + t * 0.05) + Math.cos(p.y * 0.0027 - t * 0.04) + Math.sin((p.x - p.y) * 0.0013 + t * 0.03)) * Math.PI * 0.6;
        const nx = p.x + Math.cos(ang) * 45 * dt;
        const ny = p.y + Math.sin(ang) * 45 * dt;
        const path = paths[i % 4 === 0 ? 1 : 0];
        path.moveTo(p.x, p.y);
        path.lineTo(nx, ny);
        p.x = nx;
        p.y = ny;
        if ((p.life -= dt) <= 0 || nx < 0 || nx > w || ny < 0 || ny > h) list[i] = spawn(w, h);
      }
      g.strokeStyle = rgba(c1, 0.6 * intensity);
      g.stroke(paths[0]);
      g.strokeStyle = rgba(c2, 0.7 * intensity);
      g.stroke(paths[1]);
    },
  };
}

const EFFECTS: Record<Exclude<BackgroundKind, "none">, () => Effect> = {
  neural,
  fog,
  bubbles,
  halos,
  waves,
  code: codeRain,
  circuit,
  grid: retroGrid,
  scope,
  aurora,
  stars,
  fireflies,
  flow,
};

/** Fond animé plein cadre ; se place en premier enfant d'un conteneur `relative isolate`. */
export const DashboardBackground = memo(function DashboardBackground({
  settings,
  cpu,
  cores,
}: {
  settings: BackgroundSettings;
  cpu: number[];
  cores: number[][];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Dernières mesures, lues à chaque image sans relancer l'animation.
  const signal = useRef<Signal>({ cpu, cores, at: performance.now() });
  if (signal.current.cpu !== cpu) signal.current = { cpu, cores, at: performance.now() };
  const { kind, accent, intensity, speed } = settings;
  // Vitesse et intensité changent sans relancer la simulation.
  const live = useRef({ intensity, speed });
  live.current = { intensity, speed };

  useEffect(() => {
    if (kind === "none") return;
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    const effect = EFFECTS[kind]();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    const ctx: Ctx = { g, w: 0, h: 0, c1: [34, 211, 238], c2: [167, 139, 250], fg: [255, 255, 255], intensity: live.current.intensity, signal: signal.current };
    canvas.style.filter = effect.blur ? `blur(${effect.blur}px)` : "";
    const readColors = () => {
      const style = getComputedStyle(canvas);
      ctx.c1 = parseColor(style.getPropertyValue("--primary") || "#22d3ee");
      // Seconde couleur : orange (ou cyan si l'accent est déjà ambré, pour garder le contraste).
      const dark = document.documentElement.classList.contains("dark");
      const [r, gr, b] = ctx.c1;
      const warm = r > 180 && gr > 120 && b < 110;
      ctx.c2 = warm ? (dark ? [34, 211, 238] : [8, 145, 178]) : dark ? [251, 146, 60] : [234, 88, 12];
      ctx.fg = parseColor(style.getPropertyValue("--foreground") || "#ffffff");
    };

    let raf = 0;
    let last = 0;
    let t = rand(0, 100);
    const frame = (now: number) => {
      const real = last ? Math.min(0.05, (now - last) / 1000) : 0;
      const dt = real * live.current.speed;
      last = now;
      t += dt;
      ctx.intensity = live.current.intensity;
      ctx.signal = signal.current;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.scale(canvas.width / ctx.w, canvas.height / ctx.h);
      effect.step(ctx, t, dt, real);
      if (!reduce.matches) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      last = 0;
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      if (!w || !h) return;
      const first = !ctx.w;
      const k = Math.min(window.devicePixelRatio || 1, 1.5) * effect.scale;
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      ctx.w = w;
      ctx.h = h;
      if (first) effect.init(ctx);
      readColors();
      start();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    // Thème clair / sombre basculé : on relit les couleurs.
    const recolor = () => {
      readColors();
      if (reduce.matches) start();
    };
    const mo = new MutationObserver(recolor);
    canvas.addEventListener("accent", recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // Clics : la toile est sous la grille (pointer-events: none), on écoute donc son conteneur
    // et on ignore ce qui vise un widget ou une commande.
    const host = canvas.parentElement;
    const point = (e: PointerEvent) => {
      if (!effect.poke || (e.target as Element).closest(".widget-card, .bg-nopoke, button, input, a, [role=dialog], .react-resizable-handle")) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      const p = point(e);
      if (p && e.button === 0 && effect.poke!(p.x, p.y) && reduce.matches) start();
    };
    let hovering = false;
    const onMove = (e: PointerEvent) => {
      const p = point(e);
      const over = !!p && !!effect.hit?.(p.x, p.y);
      if (over !== hovering && host) host.style.cursor = (hovering = over) ? "pointer" : "";
    };
    host?.addEventListener("pointerdown", onDown);
    host?.addEventListener("pointermove", onMove);
    const onVisibility = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", start);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      canvas.removeEventListener("accent", recolor);
      document.removeEventListener("visibilitychange", onVisibility);
      host?.removeEventListener("pointerdown", onDown);
      host?.removeEventListener("pointermove", onMove);
      if (host) host.style.cursor = "";
      reduce.removeEventListener("change", start);
    };
  }, [kind]);

  // Couleur changée : relecture au prochain rendu (la classe d'accent porte --primary).
  useEffect(() => {
    canvasRef.current?.dispatchEvent(new Event("accent"));
  }, [accent]);

  if (kind === "none") return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 -z-10 size-full", `accent-${accent}`)}
    />
  );
});
