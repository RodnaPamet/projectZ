'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { Minus } from '@/components/ui/icons/nucleo/minus';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, TextLink } from '@/components/ui/typography';
import type { Offer } from '@/lib/booking/offers';
import { resourceNoun } from '@/lib/sports/resource-kinds';
import type { PlanPoint, VenuePlan as Plan } from '@/lib/venues/plan';
import {
  clampView,
  courtFrame,
  fitPlan,
  markingsFor,
  placeMarkings,
  planBounds,
  pointInPolygon,
  toPlan,
  toScreen,
  zoomAt,
  type CourtFrame,
  type Fit,
  type Mark,
  type View,
} from '@/lib/venues/plan-geometry';
import { courtAt, laterOffers, planLengths, planTimes } from '@/lib/venues/plan-slots';

import type { Selection } from './BookingSheet';

/**
 * The venue plan (#625): pick a start and a length, see which courts are free
 * for exactly that, tap one. Loaded only on a venue that has a plan
 * (VenueBooking's dynamic import), so no other venue pays for it.
 *
 * ═══ TIME FIRST, THEN THE PLAN ═══
 *
 * The owner's order (2026-10-20). The starts offered are those at which some
 * court on the plan is free, from the same day's availability the list reads
 * (`plan-slots.ts`), so the plan and the list never disagree. A free court
 * tapped is the same pick as its time tapped in the list; a taken one shows its
 * next free times. A pick made in the list moves the plan to its time.
 *
 * ═══ A CANVAS OF OUR OWN ═══
 *
 * After Agrent's exchange map: shapes in metres in the venue's frame, fitted to
 * the canvas, with pan and zoom held in a ref so dragging never re-renders
 * React. Hit-testing is plain geometry on the plan (`pointInPolygon`). Colours
 * are the theme's tokens, read again when the theme changes.
 *
 * ═══ NOTHING ONLY ON THE CANVAS ═══
 *
 * The canvas is an image with a text alternative: a list of every court's
 * state at the picked time. Keyboard and screen-reader users book from the
 * court list below, which does everything the plan does.
 */

export interface VenuePlanProps {
  plan: Plan;
  /** The day's courts, as the list shows them; undefined while the day loads. */
  resources: ResourceSlotsDto[] | undefined;
  now: number;
  timezone: string;
  selection: Selection | null;
  /** The court lit, from the list or from the plan. */
  lit: string | null;
  lightAction: (resourceId: string | null) => void;
  pickAction: (selection: Selection) => void;
}

type CourtState = 'free' | 'taken' | 'picked' | 'unknown';

interface Geometry {
  bounds: [number, number, number, number];
  courts: { id: string; name: string; outline: PlanPoint[]; frame: CourtFrame; marks: Mark[] }[];
  features: Plan['features'];
}

/** The theme's colours, as the canvas needs them. */
interface Colors {
  grounds: string;
  building: string;
  entrance: string;
  edge: string;
  free: string;
  taken: string;
  hatch: string;
  picked: string;
  pickedEdge: string;
  lit: string;
  markOn: string;
  markOff: string;
  labelBg: string;
  label: string;
  font: string;
}

function readColors(el: Element): Colors {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    grounds: v('--bg-muted'),
    building: v('--border-default'),
    entrance: v('--accent-default'),
    edge: v('--border-strong'),
    free: v('--bg-success-emphasis'),
    taken: v('--bg-muted'),
    hatch: v('--border-strong'),
    picked: v('--brand-default'),
    pickedEdge: v('--brand-emphasis'),
    lit: v('--content-emphasis'),
    markOn: v('--content-inverted'),
    markOff: v('--border-strong'),
    labelBg: v('--bg-default'),
    label: v('--content-default'),
    font: css.fontFamily || 'sans-serif',
  };
}

const PAD = 16;

export default function VenuePlan({
  plan,
  resources,
  now,
  timezone,
  selection,
  lit,
  lightAction,
  pickAction,
}: VenuePlanProps) {
  const t = useTranslations('venue');
  const format = useFormatter();
  const listId = useId();

  const geometry = useMemo<Geometry>(() => {
    const courts = plan.courts.map((c) => {
      const frame = courtFrame(c.outline);
      const markings = markingsFor(c.sport);
      return {
        id: c.resourceId,
        name: c.name,
        outline: c.outline,
        frame,
        marks: markings ? placeMarkings(markings, frame) : [],
      };
    });
    return {
      bounds: planBounds([...plan.courts, ...plan.features].map((s) => s.outline)),
      courts,
      features: plan.features,
    };
  }, [plan]);

  // ── The picked start and length ──────────────────────────────────────────
  const rows = useMemo(() => new Map((resources ?? []).map((r) => [r.resourceId, r])), [resources]);
  const onPlan = useMemo(
    () => plan.courts.flatMap((c) => rows.get(c.resourceId) ?? []),
    [plan.courts, rows],
  );
  const [minutes, setMinutes] = useState<number | null>(selection?.minutes ?? null);
  const [time, setTime] = useState<string | null>(selection?.startTs ?? null);
  const [tapped, setTapped] = useState<string | null>(null);
  // A pick made in the list moves the plan to it (React's "adjusting state
  // when a prop changes": no effect, no extra paint).
  const [seen, setSeen] = useState(selection);
  if (selection !== seen) {
    setSeen(selection);
    if (selection) {
      setMinutes(selection.minutes);
      setTime(selection.startTs);
      setTapped(null);
    }
  }

  const lengths = useMemo(() => planLengths(onPlan), [onPlan]);
  const length = minutes !== null && lengths.includes(minutes) ? minutes : (lengths[0] ?? null);
  const times = useMemo(
    () => (length === null ? [] : planTimes(onPlan, length, now)),
    [onPlan, length, now],
  );
  const start = time !== null && times.includes(time) ? time : (times[0] ?? null);

  const states = useMemo(() => {
    const out = new Map<string, CourtState>();
    for (const c of plan.courts) {
      const r = rows.get(c.resourceId);
      if (!r || length === null) {
        out.set(c.resourceId, resources ? 'taken' : 'unknown');
        continue;
      }
      const picked =
        selection?.resourceId === c.resourceId &&
        selection.startTs === start &&
        selection.minutes === length;
      out.set(
        c.resourceId,
        picked ? 'picked' : courtAt(r, length, start, now).free ? 'free' : 'taken',
      );
    }
    return out;
  }, [plan.courts, rows, resources, length, start, now, selection]);

  const clock = useCallback(
    (iso: string) =>
      format.dateTime(new Date(iso), {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: timezone,
      }),
    [format, timezone],
  );

  const pick = useCallback(
    (court: ResourceSlotsDto, offer: Offer) => {
      setTapped(null);
      pickAction({
        resourceId: court.resourceId,
        courtName: court.name,
        noun: resourceNoun(court.resourceType),
        currency: court.currency,
        ...offer,
      });
    },
    [pickAction],
  );

  /** A tap on the plan: a free court is picked, a taken one says when it is free. */
  const tap = useCallback(
    (id: string | null) => {
      const court = id ? rows.get(id) : undefined;
      if (!court || length === null) {
        setTapped(null);
        return;
      }
      const at = courtAt(court, length, start, now);
      if (at.free) pick(court, at.offer);
      else setTapped(court.resourceId);
    },
    [rows, length, start, now, pick],
  );

  // ── The canvas ───────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const fitRef = useRef<Fit | null>(null);
  const colorsRef = useRef<Colors | null>(null);
  const hoverRef = useRef<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  // What the listeners and the painter read: refreshed after every render, so
  // the listeners are attached once and never see a stale render.
  const latest = useRef({ geometry, states, lit, tap, lightAction });
  useEffect(() => {
    latest.current = { geometry, states, lit, tap, lightAction };
  });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const fit = fitRef.current;
    const { width, height } = sizeRef.current;
    // Nothing to draw on before the first layout (and never in jsdom).
    if (!canvas || !fit || width === 0 || height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const c = (colorsRef.current ??= readColors(canvas));
    const view = viewRef.current;
    const { geometry: g, states: s, lit: on } = latest.current;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const path = (points: PlanPoint[], close = true) => {
      const p = new Path2D();
      points.forEach((pt, i) => {
        const [x, y] = toScreen(pt, fit, view);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      });
      if (close) p.closePath();
      return p;
    };
    // A metre on the screen, for line weights that grow with the zoom.
    const metre = fit.scale * view.k;

    for (const f of g.features) {
      const p = path(f.outline);
      ctx.fillStyle =
        f.kind === 'GROUNDS' ? c.grounds : f.kind === 'BUILDING' ? c.building : c.entrance;
      ctx.fill(p);
      if (f.kind !== 'ENTRANCE') {
        ctx.lineWidth = 1;
        ctx.strokeStyle = c.edge;
        ctx.stroke(p);
      }
    }

    for (const court of g.courts) {
      const state = s.get(court.id) ?? 'unknown';
      const p = path(court.outline);
      ctx.fillStyle = state === 'free' ? c.free : state === 'picked' ? c.picked : c.taken;
      ctx.fill(p);
      if (state === 'taken')
        hatch(
          ctx,
          p,
          court.outline.map((pt) => toScreen(pt, fit, view)),
          c.hatch,
        );

      ctx.strokeStyle = state === 'free' || state === 'picked' ? c.markOn : c.markOff;
      ctx.globalAlpha = 0.85;
      for (const mark of court.marks) {
        ctx.lineWidth = Math.max(
          1,
          Math.min(mark.style === 'line' ? 2 : 4, metre * (mark.style === 'line' ? 0.08 : 0.2)),
        );
        ctx.stroke(path(mark.points, false));
      }
      ctx.globalAlpha = 1;

      const lit = court.id === on;
      ctx.lineWidth = lit || state === 'picked' ? 3 : 1.5;
      ctx.strokeStyle = lit ? c.lit : state === 'picked' ? c.pickedEdge : c.edge;
      ctx.stroke(p);
    }

    // The names last, on a pill of the page's colour, so they read on any fill.
    ctx.font = `600 12px ${c.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const court of g.courts) {
      const [x, y] = toScreen([court.frame.cx, court.frame.cy], fit, view);
      const w = ctx.measureText(court.name).width + 12;
      if (w > court.frame.length * metre && court.id !== on) continue;
      ctx.fillStyle = c.labelBg;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = c.label;
      ctx.fillText(court.name, x, y + 0.5);
    }

    // The perf harness times the plan's first paint by this (#625).
    wrapRef.current?.setAttribute('data-plan-ready', '');
  }, []);

  // Size: the wrapper's box (its height comes from CSS, so the server's HTML
  // already holds the space), in device pixels for a sharp drawing.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width, height };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      fitRef.current = fitPlan(latest.current.geometry.bounds, width, height, PAD);
      viewRef.current = clampView(viewRef.current, width, height);
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw, geometry]);

  // The theme: read the colours again when it changes, by the app's switch
  // (`data-theme` on <html>) or by the system's.
  useEffect(() => {
    const again = () => {
      colorsRef.current = null;
      draw();
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
  }, [draw]);

  // Every state change is a repaint, never a re-layout.
  useEffect(() => {
    draw();
  }, [draw, states, lit]);

  /** Apply a new view: repaint, and let React know only when "zoomed" flips. */
  const setView = useCallback(
    (view: View) => {
      viewRef.current = view;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.touchAction = view.k > 1 ? 'none' : 'pan-x pan-y';
      setZoomed(view.k > 1);
      draw();
    },
    [draw],
  );

  // Pointer and wheel, attached once: they read `latest` and the refs.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, PlanPoint>();
    let press: { at: PlanPoint; moved: boolean } | null = null;
    let pinch: number | null = null;

    const local = (e: MouseEvent): PlanPoint => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hit = (p: PlanPoint): string | null => {
      const fit = fitRef.current;
      if (!fit) return null;
      const q = toPlan(p, fit, viewRef.current);
      const courts = latest.current.geometry.courts;
      for (let i = courts.length - 1; i >= 0; i--) {
        if (pointInPolygon(q, courts[i]!.outline)) return courts[i]!.id;
      }
      return null;
    };
    const hover = (id: string | null) => {
      canvas.style.cursor = id ? 'pointer' : viewRef.current.k > 1 ? 'grab' : 'default';
      if (id === hoverRef.current) return;
      hoverRef.current = id;
      latest.current.lightAction(id);
    };
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
    };

    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, local(e));
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 1) {
        press = { at: local(e), moved: false };
      } else {
        press = null;
        pinch = spread();
      }
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') hover(hit(p));
        return;
      }
      pointers.set(e.pointerId, p);
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
      if (!press) return;
      if (!press.moved && Math.hypot(p[0] - press.at[0], p[1] - press.at[1]) > 4)
        press.moved = true;
      if (press.moved && viewRef.current.k > 1) {
        const v = viewRef.current;
        viewRef.current = clampView(
          { k: v.k, tx: v.tx + p[0] - prev[0], ty: v.ty + p[1] - prev[1] },
          width,
          height,
        );
        draw();
      }
    };
    const up = (e: PointerEvent) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (press && !press.moved && pointers.size === 0) latest.current.tap(hit(p));
      if (pointers.size === 0) {
        press = null;
        pinch = null;
      }
    };
    const cancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      press = null;
      pinch = null;
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') hover(null);
    };
    // A trackpad's pinch arrives as a wheel with ctrlKey. A plain wheel is the
    // page's scroll and is left alone.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { width, height } = sizeRef.current;
      setView(zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.01), local(e), width, height));
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [draw, setView]);

  const zoomBy = (factor: number) => {
    const { width, height } = sizeRef.current;
    setView(zoomAt(viewRef.current, factor, [width / 2, height / 2], width, height));
  };

  // ── What is around the canvas ────────────────────────────────────────────
  const [minX, minY, maxX, maxY] = geometry.bounds;
  // The plan's own proportions, within the wrapper's 200–420 px of height.
  const aspect = `${Math.max(maxX - minX, 1)} / ${Math.max(maxY - minY, 1)}`;
  const tappedCourt = tapped && states.get(tapped) === 'taken' ? rows.get(tapped) : undefined;
  const later = tappedCourt && length !== null ? laterOffers(tappedCourt, length, start, now) : [];

  return (
    <div className="flex flex-col gap-3">
      {lengths.length > 1 && length !== null && (
        <ToggleGroup
          size="sm"
          ariaLabel={t('plan.lengthLabel')}
          options={lengths.map((m) => ({
            value: String(m),
            label: t('slots.minutes', { minutes: m }),
          }))}
          selected={String(length)}
          selectAction={(value) => setMinutes(Number(value))}
        />
      )}
      {resources !== undefined && times.length === 0 ? (
        <Caption>{t('slots.none')}</Caption>
      ) : (
        <div className="overflow-x-auto pb-1">
          {start !== null && (
            <ToggleGroup
              size="sm"
              ariaLabel={t('plan.timeLabel')}
              options={times.map((iso) => ({ value: iso, label: clock(iso) }))}
              selected={start}
              selectAction={(value) => {
                setTime(value);
                setTapped(null);
              }}
              optionClassName="whitespace-nowrap tabular-nums"
            />
          )}
        </div>
      )}

      <div
        ref={wrapRef}
        className="border-border-subtle bg-bg-subtle relative max-h-[420px] min-h-[200px] w-full overflow-hidden rounded-lg border"
        style={{ aspectRatio: aspect }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('plan.label')}
          aria-describedby={listId}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: 'pan-x pan-y' }}
        />
        <div className="absolute right-2 bottom-2 flex gap-1">
          {zoomed && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              text={t('plan.fit')}
              onClick={() => setView({ k: 1, tx: 0, ty: 0 })}
            />
          )}
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label={t('plan.zoomOut')}
            icon={<Minus aria-hidden="true" />}
            disabled={!zoomed}
            onClick={() => zoomBy(1 / 1.5)}
          />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label={t('plan.zoomIn')}
            icon={<Plus aria-hidden="true" />}
            onClick={() => zoomBy(1.5)}
          />
        </div>
      </div>
      <ul id={listId} className="sr-only">
        {plan.courts.map((c) => {
          const state = states.get(c.resourceId);
          if (!start || state === 'unknown') return <li key={c.resourceId}>{c.name}</li>;
          const words = { court: c.name, time: clock(start) };
          return (
            <li key={c.resourceId}>
              {state === 'picked'
                ? t('plan.statePicked', words)
                : state === 'free'
                  ? t('plan.stateFree', words)
                  : t('plan.stateTaken', words)}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div
          className="text-content-muted flex flex-wrap gap-x-4 gap-y-1 text-xs"
          aria-hidden="true"
        >
          <span className="flex items-center gap-1.5">
            <span className="bg-bg-success-emphasis size-3 rounded-sm" />
            {t('plan.legendFree')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="border-border-strong size-3 rounded-sm border"
              style={{
                background:
                  'repeating-linear-gradient(45deg, var(--border-strong) 0 1px, transparent 1px 4px), var(--bg-muted)',
              }}
            />
            {t('plan.legendTaken')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-brand-default size-3 rounded-sm" />
            {t('plan.legendPicked')}
          </span>
        </div>
        {plan.attribution === 'OpenStreetMap' && (
          <Caption>
            <TextLink
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('plan.credit')}
            </TextLink>
          </Caption>
        )}
      </div>

      {tappedCourt && start && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Caption>{t('plan.takenAt', { court: tappedCourt.name, time: clock(start) })}</Caption>
          {later.length === 0 ? (
            <Caption>{t('plan.noneLater', { court: tappedCourt.name })}</Caption>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Caption>{t('plan.later')}</Caption>
              {later.map((o) => (
                <Button
                  key={o.startTs}
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="tabular-nums"
                  text={clock(o.startTs)}
                  onClick={() => pick(tappedCourt, o)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Diagonal lines across a taken court: taken is not told by colour alone. */
function hatch(ctx: CanvasRenderingContext2D, p: Path2D, screen: PlanPoint[], color: string) {
  const xs = screen.map((s) => s[0]);
  const ys = screen.map((s) => s[1]);
  const [left, right, top, bottom] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const h = bottom - top;
  ctx.save();
  ctx.clip(p);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = left - h; x < right; x += 7) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + h, top);
  }
  ctx.stroke();
  ctx.restore();
}
