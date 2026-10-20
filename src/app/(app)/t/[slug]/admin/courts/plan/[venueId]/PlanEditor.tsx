'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Minus } from '@/components/ui/icons/nucleo/minus';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import type { PlanPoint, VenuePlanShape } from '@/lib/venues/plan';
import {
  angleTowards,
  editable,
  handlesOf,
  moved,
  outlineOf,
  placed,
  resized,
  sameOutline,
  stretched,
  turned,
  type EditedCourt,
  type Side,
} from '@/lib/venues/plan-edit';
import {
  clampView,
  fitPlan,
  planBounds,
  pointInPolygon,
  toPlan,
  toScreen,
  zoomAt,
  type Fit,
  type View,
} from '@/lib/venues/plan-geometry';
import { paintedCourt, paintPlan, readPlanColors, type PlanColors } from '@/lib/venues/plan-paint';

import { saveVenuePlanAction } from '../../actions';

/**
 * The club's plan editor (#626): every court of one venue, moved, turned,
 * resized or drawn where it really is, then saved at once.
 *
 * ═══ THE CANVAS, AND EVERYTHING WITHOUT IT ═══
 *
 * On the canvas (the player's plan's painter, so the club sees what players
 * will): drag a court to move it, a side's dot to stretch that side, the dot
 * above it to turn it; two fingers or the buttons zoom. A gesture repaints
 * from refs and becomes React state only when it ends, so a drag never
 * re-renders the page.
 *
 * Below it, the same edits without a pointer: each court's length, width and
 * turn as numbers, and moves of a metre. That is the keyboard's way, and the
 * precise one.
 *
 * ═══ UNDO, THEN ONE SAVE ═══
 *
 * Every finished edit can be undone. «Запази плана» sends only the courts that
 * differ from what was saved, and the server marks each the club's own.
 */

export interface EditorCourt {
  resourceId: string;
  name: string;
  sport: string;
  outline: PlanPoint[] | null;
  source: 'OSM' | 'CLUB' | null;
}

type Edits = Record<string, EditedCourt | null>;

/** Moving, turning or stretching one court, from the pointer going down to it coming up. */
interface ShapeGesture {
  kind: 'shape';
  id: string;
  how: 'move' | 'turn' | Side;
  /** Where the pointer went down, on the plan. */
  from: PlanPoint;
  start: EditedCourt;
  now: EditedCourt;
  changed: boolean;
}

/** Panning, or a tap on nothing (which deselects). */
interface PanGesture {
  kind: 'pan';
  last: PlanPoint;
  changed: boolean;
}

type Gesture = ShapeGesture | PanGesture;

const PAD = 24;
/** How close to a handle counts as on it, in CSS pixels. */
const GRAB_PX = 18;
/** How far above the court the turn handle sits, in CSS pixels. */
const TURN_PX = 28;

function initialEdits(courts: EditorCourt[]): Edits {
  return Object.fromEntries(
    courts.map((c) => [c.resourceId, c.outline ? editable(c.outline) : null]),
  );
}

export function PlanEditor({
  slug,
  venueId,
  courts,
  features,
}: {
  slug: string;
  venueId: string;
  courts: EditorCourt[];
  features: Pick<VenuePlanShape, 'kind' | 'outline'>[];
}) {
  const t = useTranslations('admin.courts.plan');
  const hintId = useId();

  const [saved, setSaved] = useState<Record<string, PlanPoint[] | null>>(() =>
    Object.fromEntries(courts.map((c) => [c.resourceId, c.outline])),
  );
  const [edits, setEdits] = useState<Edits>(() => initialEdits(courts));
  const [history, setHistory] = useState<Edits[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [saving, startSaving] = useTransition();

  const outlines = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(edits).map(([id, e]) => [id, e ? outlineOf(e) : null]),
      ) as Record<string, PlanPoint[] | null>,
    [edits],
  );
  const changes = courts.filter(
    (c) => !sameOutline(outlines[c.resourceId] ?? null, saved[c.resourceId] ?? null),
  );
  const fromOsm =
    courts.some(
      (c) => c.source === 'OSM' && sameOutline(outlines[c.resourceId] ?? null, c.outline),
    ) || features.length > 0;

  /** One finished edit: undoable, and unsaved until «Запази плана». */
  const commit = useCallback(
    (id: string, next: EditedCourt | null) => {
      setHistory((h) => [...h, edits]);
      setEdits((e) => ({ ...e, [id]: next }));
      setStatus('idle');
    },
    [edits],
  );

  function undo() {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setEdits(previous);
    setStatus('idle');
  }

  function draw(court: EditorCourt) {
    const others = Object.values(outlines).filter((o): o is PlanPoint[] => o !== null);
    commit(court.resourceId, placed(court.sport, [...others, ...features.map((f) => f.outline)]));
    setSelected(court.resourceId);
    refitRef.current = true;
  }

  function remove(court: EditorCourt) {
    commit(court.resourceId, null);
    refitRef.current = true;
  }

  function save() {
    const payload = changes.map((c) => ({
      resourceId: c.resourceId,
      outline: outlines[c.resourceId] ?? null,
    }));
    startSaving(async () => {
      const result = await saveVenuePlanAction(slug, venueId, payload);
      if (result.ok) {
        setSaved(outlines);
        setHistory([]);
        setStatus('saved');
      } else {
        setStatus('failed');
      }
    });
  }

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (changes.length === 0) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [changes.length]);

  // ── The canvas ───────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const fitRef = useRef<Fit | null>(null);
  const colorsRef = useRef<PlanColors | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /** Fit the view again at the next paint: after a court is drawn or taken off. */
  const refitRef = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  const latest = useRef({ edits, selected, courts, commit });
  useEffect(() => {
    latest.current = { edits, selected, courts, commit };
  });

  /** The view that shows every shape with room to move them. */
  const refit = useCallback(() => {
    const { width, height } = sizeRef.current;
    const shapes = [
      ...Object.values(latest.current.edits).flatMap((e) => (e ? [outlineOf(e)] : [])),
      ...features.map((f) => f.outline),
    ];
    const [minX, minY, maxX, maxY] = shapes.length > 0 ? planBounds(shapes) : [-20, -15, 20, 15];
    const [mx, my] = [Math.max(10, (maxX - minX) * 0.25), Math.max(10, (maxY - minY) * 0.25)];
    fitRef.current = fitPlan([minX - mx, minY - my, maxX + mx, maxY + my], width, height, PAD);
    viewRef.current = { k: 1, tx: 0, ty: 0 };
    setZoomed(false);
  }, [features]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || width === 0 || height === 0) return;
    if (refitRef.current || !fitRef.current) {
      refitRef.current = false;
      refit();
    }
    const fit = fitRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const view = viewRef.current;
    const colors = (colorsRef.current ??= readPlanColors(canvas));
    const { edits: e, selected: sel, courts: list } = latest.current;
    const g = gestureRef.current;
    const shapeOf = (id: string) => (g?.kind === 'shape' && g.id === id ? g.now : e[id]);
    const painted = list.flatMap((c) => {
      const shape = shapeOf(c.resourceId);
      return shape ? [paintedCourt({ ...c, outline: outlineOf(shape) })] : [];
    });
    paintPlan(ctx, window.devicePixelRatio || 1, {
      width,
      height,
      fit,
      view,
      colors,
      features,
      courts: painted,
      look: () => 'plain',
      lit: sel,
    });

    // The selected court's handles: a dot on each side, and the turn dot.
    const current = sel ? shapeOf(sel) : null;
    if (!current) return;
    const metre = fit.scale * view.k;
    const h = handlesOf(current, TURN_PX / metre);
    const at = (p: PlanPoint) => toScreen(p, fit, view);
    ctx.strokeStyle = colors.lit;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(...at(h.left));
    ctx.lineTo(...at(h.turn));
    ctx.stroke();
    for (const name of ['front', 'back', 'left', 'right', 'turn'] as const) {
      const [x, y] = at(h[name]);
      ctx.beginPath();
      ctx.arc(x, y, name === 'turn' ? 8 : 7, 0, 2 * Math.PI);
      ctx.fillStyle = name === 'turn' ? colors.lit : colors.labelBg;
      ctx.fill();
      ctx.stroke();
    }
  }, [features, refit]);

  // Size: the wrapper's box, in device pixels; the first one fits the plan.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = sizeRef.current.width === 0;
      sizeRef.current = { width, height };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (first) refitRef.current = true;
      viewRef.current = clampView(viewRef.current, width, height);
      paint();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [paint]);

  // The theme: read the colours again when it changes.
  useEffect(() => {
    const again = () => {
      colorsRef.current = null;
      paint();
    };
    const observer = new MutationObserver(again);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', again);
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', again);
    };
  }, [paint]);

  useEffect(() => {
    paint();
  }, [paint, edits, selected]);

  const setView = useCallback(
    (view: View) => {
      viewRef.current = view;
      setZoomed(view.k > 1);
      paint();
    },
    [paint],
  );

  // Pointer and wheel, attached once: they read `latest` and the refs.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, PlanPoint>();
    let pinch: number | null = null;

    const local = (e: MouseEvent): PlanPoint => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onPlan = (s: PlanPoint) => toPlan(s, fitRef.current!, viewRef.current);
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
    };

    /** What is under the pointer: a handle of the selected court, a court, or nothing. */
    const grab = (s: PlanPoint): ShapeGesture | null => {
      const fit = fitRef.current;
      if (!fit) return null;
      const { edits: e, selected: sel, courts: list } = latest.current;
      const q = onPlan(s);
      const current = sel ? e[sel] : null;
      if (sel && current) {
        const metre = fit.scale * viewRef.current.k;
        const h = handlesOf(current, TURN_PX / metre);
        for (const name of ['turn', 'front', 'back', 'left', 'right'] as const) {
          const [x, y] = toScreen(h[name], fit, viewRef.current);
          if (Math.hypot(x - s[0], y - s[1]) <= GRAB_PX) {
            const how = name === 'turn' ? 'turn' : name;
            return {
              kind: 'shape',
              id: sel,
              how,
              from: q,
              start: current,
              now: current,
              changed: false,
            };
          }
        }
      }
      // The selected court first, then the others from the top down.
      const order = [
        ...(sel ? [sel] : []),
        ...list
          .map((c) => c.resourceId)
          .reverse()
          .filter((id) => id !== sel),
      ];
      for (const id of order) {
        const shape = e[id];
        if (shape && pointInPolygon(q, outlineOf(shape))) {
          return {
            kind: 'shape',
            id,
            how: 'move',
            from: q,
            start: shape,
            now: shape,
            changed: false,
          };
        }
      }
      return null;
    };

    const down = (e: PointerEvent) => {
      if (!fitRef.current) return;
      const s = local(e);
      pointers.set(e.pointerId, s);
      canvas.setPointerCapture?.(e.pointerId);
      if (pointers.size === 2) {
        // A second finger: zoom, and drop whatever the first one started.
        gestureRef.current = null;
        pinch = spread();
        paint();
        return;
      }
      const g = grab(s);
      gestureRef.current = g ?? { kind: 'pan', last: s, changed: false };
      if (g && g.id !== latest.current.selected) setSelected(g.id);
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const s = local(e);
      pointers.set(e.pointerId, s);
      const { width, height } = sizeRef.current;
      if (pointers.size === 2 && pinch) {
        const d = spread();
        const [a, b] = [...pointers.values()] as [PlanPoint, PlanPoint];
        setView(
          zoomAt(viewRef.current, d / pinch, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], width, height),
        );
        pinch = d;
        return;
      }
      const g = gestureRef.current;
      if (!g) return;
      if (g.kind === 'pan') {
        const v = viewRef.current;
        if (v.k > 1) {
          viewRef.current = clampView(
            { k: v.k, tx: v.tx + s[0] - g.last[0], ty: v.ty + s[1] - g.last[1] },
            width,
            height,
          );
          paint();
        }
        if (Math.hypot(s[0] - g.last[0], s[1] - g.last[1]) > 2) g.changed = true;
        g.last = s;
        return;
      }
      const q = onPlan(s);
      g.now =
        g.how === 'move'
          ? moved(g.start, q[0] - g.from[0], q[1] - g.from[1])
          : g.how === 'turn'
            ? turned(g.start, angleTowards(g.start, q))
            : stretched(g.start, g.how, q);
      g.changed = true;
      paint();
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size > 0) return;
      pinch = null;
      const g = gestureRef.current;
      gestureRef.current = null;
      if (g?.kind === 'shape' && g.changed) latest.current.commit(g.id, g.now);
      else if (g?.kind === 'pan' && !g.changed) setSelected(null);
      else paint();
    };
    const cancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinch = null;
      gestureRef.current = null;
      paint();
    };
    const hover = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || pointers.size > 0) return;
      const g = grab(local(e));
      canvas.style.cursor = !g
        ? viewRef.current.k > 1
          ? 'grab'
          : 'default'
        : g.kind === 'shape' && g.how === 'move'
          ? 'move'
          : 'pointer';
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { width, height } = sizeRef.current;
      setView(zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.01), local(e), width, height));
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointermove', hover);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointermove', hover);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [paint, setView, setSelected]);

  const zoomBy = (factor: number) => {
    const { width, height } = sizeRef.current;
    setView(zoomAt(viewRef.current, factor, [width / 2, height / 2], width, height));
  };

  // ── Around the canvas ────────────────────────────────────────────────────
  const chosen = courts.find((c) => c.resourceId === selected) ?? null;
  const chosenShape = chosen ? edits[chosen.resourceId] : null;
  const onThePlan = courts.filter((c) => edits[c.resourceId]).length;

  /** A number typed into the selected court's panel, applied on Enter or leaving the field. */
  const numberField = (
    label: string,
    value: number,
    step: number,
    apply: (n: number) => EditedCourt,
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-content-muted">{label}</span>
      <input
        // A new value from the canvas or an undo replaces what is typed.
        key={`${selected}-${value}`}
        type="number"
        inputMode="decimal"
        step={step}
        defaultValue={Math.round(value / step) * step}
        className="border-border-strong bg-bg-default text-content-default w-24 rounded-md border px-2 py-1 tabular-nums"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value);
          if (!chosen || !Number.isFinite(n) || n === Math.round(value / step) * step) return;
          commit(chosen.resourceId, apply(n));
        }}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <p id={hintId} className="text-content-muted text-sm">
        {t('hint')}
      </p>
      {onThePlan === 0 && <InlineNotice variant="info">{t('empty')}</InlineNotice>}

      <div
        ref={wrapRef}
        className="border-border-subtle bg-bg-subtle relative h-[360px] w-full overflow-hidden rounded-lg border md:h-[480px]"
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('canvas')}
          aria-describedby={hintId}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: 'none' }}
        />
        <div className="absolute right-2 bottom-2 flex gap-1">
          {zoomed && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              text={t('fit')}
              onClick={() => {
                refit();
                paint();
              }}
            />
          )}
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label={t('zoomOut')}
            icon={<Minus aria-hidden="true" />}
            disabled={!zoomed}
            onClick={() => zoomBy(1 / 1.5)}
          />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label={t('zoomIn')}
            icon={<Plus aria-hidden="true" />}
            onClick={() => zoomBy(1.5)}
          />
        </div>
      </div>
      {fromOsm && (
        <Caption>
          <TextLink
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('credit')}
          </TextLink>
        </Caption>
      )}

      {chosen && (
        <section
          aria-labelledby="plan-chosen"
          className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
        >
          <Heading level={2} id="plan-chosen">
            {chosen.name}
          </Heading>
          {chosenShape ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                {numberField(t('length'), chosenShape.frame.length, 0.1, (n) =>
                  resized(chosenShape, n, chosenShape.frame.width),
                )}
                {numberField(t('width'), chosenShape.frame.width, 0.1, (n) =>
                  resized(chosenShape, chosenShape.frame.length, n),
                )}
                {numberField(
                  t('angle'),
                  ((((chosenShape.frame.angle * 180) / Math.PI) % 180) + 180) % 180,
                  1,
                  (n) => turned(chosenShape, (n * Math.PI) / 180),
                )}
              </div>
              <div role="group" aria-label={t('moveLabel')} className="flex flex-wrap gap-2">
                {(
                  [
                    [t('west'), -1, 0],
                    [t('east'), 1, 0],
                    [t('north'), 0, 1],
                    [t('south'), 0, -1],
                  ] as const
                ).map(([label, dx, dy]) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant="secondary"
                    text={label}
                    onClick={() => commit(chosen.resourceId, moved(chosenShape, dx, dy))}
                  />
                ))}
              </div>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  text={t('remove')}
                  onClick={() => remove(chosen)}
                />
              </div>
            </>
          ) : (
            <div>
              <Button type="button" size="sm" text={t('draw')} onClick={() => draw(chosen)} />
            </div>
          )}
        </section>
      )}

      <ul className="divide-border-subtle border-border-subtle divide-y rounded-lg border">
        {courts.map((c) => {
          const shape = edits[c.resourceId];
          const osm = c.source === 'OSM' && sameOutline(outlines[c.resourceId] ?? null, c.outline);
          return (
            <li key={c.resourceId} className="flex items-center justify-between gap-3 px-4 py-2">
              <div className="flex min-w-0 flex-col items-start gap-0.5">
                {/* The name selects the court, on the plan and in the panel above. */}
                <Button
                  type="button"
                  size="sm"
                  variant={selected === c.resourceId ? 'primary' : 'ghost'}
                  aria-pressed={selected === c.resourceId}
                  text={c.name}
                  onClick={() => setSelected(c.resourceId)}
                />
                <Caption>{shape ? (osm ? t('fromOsm') : t('onPlan')) : t('notOnPlan')}</Caption>
              </div>
              {!shape && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  text={t('draw')}
                  onClick={() => draw(c)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {/* Undo and save, pinned at the bottom like the venue page's booking bar. */}
      <div className="border-border-subtle bg-bg-page sticky bottom-[var(--app-bottom-inset,0px)] z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <p className="text-content-muted text-sm" aria-live="polite">
          {status === 'saved'
            ? t('saved')
            : status === 'failed'
              ? t('failed')
              : changes.length > 0
                ? t('unsaved', { count: changes.length })
                : null}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            text={t('undo')}
            disabled={history.length === 0 || saving}
            onClick={undo}
          />
          <Button
            type="button"
            text={saving ? t('saving') : t('save')}
            disabled={changes.length === 0 || saving}
            onClick={save}
          />
        </div>
      </div>
    </div>
  );
}
