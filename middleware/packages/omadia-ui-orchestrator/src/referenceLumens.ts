/**
 * omadia-canvas-protocol/1.1 — vetted reference Lumens (Live Interactivity).
 *
 * Declarative DATA, not code: a deterministic, gas-bounded LX interpreter runs
 * each one Tier-1-fast (60fps, no per-frame server round-trip). These are the
 * "resolve-then-instantiate" presets the `canvas_publish_lumen` producer hands
 * to the canvas — each exercises a different slice of the implementation:
 *   - arcade — a tick simulation + pointer/key events + a `scene` draw-list
 *   - map    — interactive selection (tap → state → conditional highlight via
 *              `get`/`if`), `+`/`-` zoom (clamp), `map` over record markers
 *   - defrag — a tick-driven animation built by `map(range)` (compacting blocks)
 */
export interface ReferenceLumen {
  title: string;
  hint: string;
  lumen: Record<string, unknown>;
}

const ARCADE: Record<string, unknown> = {
  type: 'lumen',
  id: 'arcade-bounce',
  state: {
    x: { type: 'number', min: 0, max: 300, init: 20 },
    vx: { type: 'number', init: 6 },
    bounces: { type: 'int', min: 0, init: 0 },
  },
  transitions: {
    step: {
      let: { nx: { '+': [{ state: 'x' }, { state: 'vx' }] } },
      in: {
        let: { hitWall: { or: [{ '<=': [{ var: 'nx' }, { lit: 0 }] }, { '>=': [{ var: 'nx' }, { lit: 300 }] }] } },
        in: {
          set: {
            x: { call: 'clamp', args: [{ var: 'nx' }, { lit: 0 }, { lit: 300 }] },
            vx: { if: { var: 'hitWall' }, then: { '-': [{ lit: 0 }, { state: 'vx' }] }, else: { state: 'vx' } },
            bounces: { if: { var: 'hitWall' }, then: { '+': [{ state: 'bounces' }, { lit: 1 }] }, else: { state: 'bounces' } },
          },
        },
      },
    },
    reverse: { set: { vx: { '-': [{ lit: 0 }, { state: 'vx' }] } } },
  },
  view: {
    record: {
      type: { lit: 'scene' },
      width: { lit: 320 },
      height: { lit: 120 },
      draw: {
        list: [
          { record: { kind: { lit: 'rect' }, x: { lit: 0 }, y: { lit: 0 }, w: { lit: 320 }, h: { lit: 120 }, fill: { lit: 'surface-sunken' } } },
          { record: { kind: { lit: 'circle' }, cx: { state: 'x' }, cy: { lit: 60 }, r: { lit: 10 }, fill: { lit: 'accent' }, id: { lit: 'ball' } } },
          { record: { kind: { lit: 'text' }, x: { lit: 8 }, y: { lit: 16 }, text: { call: 'concat', args: [{ lit: 'bounces ' }, { call: 'fmt', args: [{ state: 'bounces' }] }] }, register: { lit: 'mono' }, fill: { lit: 'text' } } },
        ],
      },
    },
  },
  events: [
    { on: 'tick', rate: 60, run: 'step' },
    { on: 'tap', run: 'reverse' },
    { on: 'key', key: 'Space', run: 'reverse' },
  ],
  cadence: { tick: 60 },
};

const MAP: Record<string, unknown> = {
  type: 'lumen',
  id: 'map-explore',
  state: {
    zoom: { type: 'int', min: 1, max: 5, init: 2 },
    sel: { type: 'string', maxLength: 32, init: '' },
    markers: {
      type: 'list',
      of: { type: 'record', fields: { id: { type: 'string', maxLength: 8, init: '' }, x: { type: 'number', init: 0 }, y: { type: 'number', init: 0 } }, init: {} },
      maxLen: 32,
      init: [
        { id: 'a', x: 40, y: 40 },
        { id: 'b', x: 120, y: 80 },
        { id: 'c', x: 200, y: 50 },
      ],
    },
  },
  transitions: {
    select: { set: { sel: { event: 'id' } } },
    zoomIn: { set: { zoom: { call: 'clamp', args: [{ '+': [{ state: 'zoom' }, { lit: 1 }] }, { lit: 1 }, { lit: 5 }] } } },
    zoomOut: { set: { zoom: { call: 'clamp', args: [{ '-': [{ state: 'zoom' }, { lit: 1 }] }, { lit: 1 }, { lit: 5 }] } } },
  },
  view: {
    record: {
      type: { lit: 'scene' },
      width: { lit: 256 },
      height: { lit: 128 },
      draw: {
        call: 'concat',
        args: [
          { list: [{ record: { kind: { lit: 'rect' }, x: { lit: 0 }, y: { lit: 0 }, w: { lit: 256 }, h: { lit: 128 }, fill: { lit: 'surface-sunken' } } }] },
          {
            call: 'map',
            args: [
              { state: 'markers' },
              {
                record: {
                  kind: { lit: 'circle' },
                  cx: { get: { var: 'it' }, key: { lit: 'x' } },
                  cy: { get: { var: 'it' }, key: { lit: 'y' } },
                  r: { '+': [{ lit: 6 }, { state: 'zoom' }] },
                  fill: { if: { '==': [{ get: { var: 'it' }, key: { lit: 'id' } }, { state: 'sel' }] }, then: { lit: 'success' }, else: { lit: 'accent' } },
                  id: { get: { var: 'it' }, key: { lit: 'id' } },
                },
              },
            ],
          },
        ],
      },
    },
  },
  events: [
    { on: 'tap', run: 'select' },
    { on: 'key', key: '+', run: 'zoomIn' },
    { on: 'key', key: '-', run: 'zoomOut' },
  ],
  cadence: 'reactive',
  capabilities: [{ cap: 'tiles', effect: 'internal', scope: { provider: 'osm' } }],
};

const DEFRAG: Record<string, unknown> = {
  type: 'lumen',
  id: 'defrag-viz',
  state: { frame: { type: 'int', min: 0, init: 0 } },
  transitions: { step: { set: { frame: { '+': [{ state: 'frame' }, { lit: 1 }] } } } },
  view: {
    record: {
      type: { lit: 'scene' },
      width: { lit: 256 },
      height: { lit: 64 },
      draw: {
        call: 'map',
        args: [
          { call: 'range', args: [{ lit: 8 }] },
          {
            record: {
              kind: { lit: 'rect' },
              x: { call: 'max', args: [{ '*': [{ var: 'idx' }, { lit: 30 }] }, { '-': [{ lit: 220 }, { '*': [{ state: 'frame' }, { lit: 5 }] }] }] },
              y: { lit: 20 },
              w: { lit: 24 },
              h: { lit: 24 },
              r: { lit: 4 },
              fill: { if: { '==': [{ mod: [{ var: 'idx' }, { lit: 2 }] }, { lit: 0 }] }, then: { lit: 'accent' }, else: { lit: 'accent.glow' } },
              id: { call: 'concat', args: [{ lit: 'b' }, { call: 'fmt', args: [{ var: 'idx' }] }] },
            },
          },
        ],
      },
    },
  },
  events: [
    { on: 'tick', rate: 30, run: 'step' },
    { on: 'tap', run: 'step' },
  ],
  cadence: { tick: 30 },
};

export type ReferenceLumenVariant = 'arcade' | 'map' | 'defrag';

export const REFERENCE_LUMENS: Record<ReferenceLumenVariant, ReferenceLumen> = {
  arcade: {
    title: 'Live Interactivity — Arcade Lumen',
    hint: 'Tap the canvas (or press Space) to reverse the ball — it bounces off the walls at 60fps and counts, all interpreted locally with no per-frame server round-trip.',
    lumen: ARCADE,
  },
  map: {
    title: 'Live Interactivity — Interactive Map Lumen',
    hint: 'Tap a marker to select it (it highlights via a state-driven conditional); press + / - to zoom the markers. Pure Tier-1 interaction — selection and zoom are deterministic state transitions.',
    lumen: MAP,
  },
  defrag: {
    title: 'Live Interactivity — Defrag Visualisation Lumen',
    hint: 'A tick-driven animation: eight blocks compact leftward at 30fps, each frame recomputed by an LX map over a bounded range. Tap to step it manually.',
    lumen: DEFRAG,
  },
};

export function resolveReferenceLumen(variant: unknown): ReferenceLumen {
  return REFERENCE_LUMENS[variant === 'map' || variant === 'defrag' ? variant : 'arcade'];
}
