'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { getVersion, setWorkerUrl } from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';
import Map, { Marker, NavigationControl, type MapRef } from 'react-map-gl/maplibre';

import { useTheme } from '@/components/theme/ThemeProvider';
import { BULGARIA_VIEW, pinBounds, type MapPin } from '@/lib/venues/near';

/**
 * The basemap: OpenFreeMap's vector tiles (free, no key, no account, no
 * request limit), in the page's theme. Their styles carry the OpenStreetMap
 * and OpenMapTiles credits, which the map's own attribution control shows.
 */
const STYLE = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

/**
 * maplibre's tile worker, served from our own origin: bundled, maplibre looks
 * for it beside its own chunk, where there is none. Copied there from the
 * installed package by scripts/copy-maplibre-worker.mjs; the version busts a
 * browser's cached copy of an older one.
 */
setWorkerUrl(`/maplibre/maplibre-gl-worker.mjs?v=${getVersion()}`);

/** Room around the pins when the map frames them, and how close it may come. */
const FRAME = { padding: 48, maxZoom: 13 } as const;

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The clubs on a map (#697, owner 2026-11-13: "a map with all the clubs in
 * Bulgaria who are bookable in playerz"), as the phone's ClubsMapView: a pin
 * per club, and a tapped pin is the chosen club, whose card the list shows
 * under the map. The pins in view once they arrive; the whole country while
 * there are none.
 *
 * Loaded on its own (`next/dynamic`, no SSR) when the map is switched on:
 * maplibre is a large library, and the list must not carry it.
 *
 * Each pin is a button named after its club, so a keyboard reaches every club
 * on the map; the list view stays the complete way to every club.
 */
export default function ClubsMap({
  pins,
  selectedId,
  selectAction,
  label,
}: {
  pins: readonly MapPin[];
  selectedId: string | null;
  selectAction: (id: string) => void;
  /** What the map is called to a screen reader: how many clubs it shows. */
  label: string;
}) {
  const { theme } = useTheme();
  const ref = useRef<MapRef>(null);
  const bounds = useMemo(() => pinBounds(pins), [pins]);
  // The box as a string, so a new array with the same pins does not move the map.
  const frame = bounds ? bounds.flat().join(',') : '';
  const first = useRef(true);

  useEffect(() => {
    // The first frame comes from `initialViewState`.
    if (first.current) {
      first.current = false;
      return;
    }
    const map = ref.current;
    if (!map) return;
    const duration = reducedMotion() ? 0 : 400;
    if (bounds) map.fitBounds(bounds, { ...FRAME, duration });
    else
      map.flyTo({
        center: [BULGARIA_VIEW.longitude, BULGARIA_VIEW.latitude],
        zoom: BULGARIA_VIEW.zoom,
        duration,
      });
    // `frame` stands for `bounds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  return (
    <div
      role="region"
      aria-label={label}
      data-testid="clubs-map"
      className="border-border-default bg-bg-muted relative h-[420px] overflow-hidden rounded-lg border"
    >
      <Map
        ref={ref}
        initialViewState={bounds ? { bounds, fitBoundsOptions: FRAME } : BULGARIA_VIEW}
        mapStyle={STYLE[theme === 'light' ? 'light' : 'dark']}
        style={{ width: '100%', height: '100%' }}
        attributionControl={{ compact: true }}
        dragRotate={false}
        touchPitch={false}
        pitchWithRotate={false}
      >
        <NavigationControl position="top-right" showCompass={false} />
        {pins.map((p) => (
          <Marker
            key={p.id}
            longitude={p.lng}
            latitude={p.lat}
            anchor="bottom"
            onClick={(e) => {
              // The map's own click must not see it.
              e.originalEvent.stopPropagation();
              selectAction(p.id);
            }}
          >
            <button
              type="button"
              className="club-pin"
              aria-label={p.name}
              aria-pressed={p.id === selectedId}
              data-venue-id={p.id}
            >
              <svg viewBox="0 0 24 32" aria-hidden="true">
                <path
                  d="M12 1C6 1 1.5 5.4 1.5 11.2 1.5 18.6 12 31 12 31s10.5-12.4 10.5-19.8C22.5 5.4 18 1 12 1Z"
                  className="club-pin-body"
                />
                <circle cx="12" cy="11.5" r="4" className="club-pin-dot" />
              </svg>
            </button>
          </Marker>
        ))}
      </Map>
    </div>
  );
}
