// Throwaway proof bundle for epic #470 C8 — hand-written in the shape a Vite
// build emits (hashed basename, ESM, class names surviving as string
// literals), so the ingest scanner and the static server are exercised
// against realistic input rather than a convenient one.
//
// Every class below is in the documented vocabulary
// (plugin-ui-vocabulary.md, in the epic #470 spec directory). Not one arbitrary
// value appears, which is the whole point: put a bracketed pixel width in
// here and `packageUploadService` rejects the package at ingest. (This
// comment used to spell one out, and the scanner rejected the fixture — the
// documented prose false positive, caught by its own proof.)

const CARD = 'rounded-md border border-border bg-bg-elevated p-4 shadow-sm';
const HEADING = 'text-lg font-semibold text-fg-strong';
const MUTED = 'text-sm text-fg-muted';
const ROW = 'flex items-center justify-between gap-4 py-2';
const BADGE_OK = 'rounded-full bg-success px-2 text-xs text-bg';
const BADGE_WARN = 'rounded-full bg-warning px-2 text-xs text-bg';
const BUTTON =
  'rounded-sm border border-accent bg-accent px-4 py-2 text-bg transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed';

const STATUS = [
  { label: 'Stylesheet', ok: true },
  { label: 'Theme bridge', ok: true },
  { label: 'Arbitrary values', ok: false },
];

function row(item) {
  const el = document.createElement('div');
  el.className = ROW;
  const label = document.createElement('span');
  label.className = MUTED;
  label.textContent = item.label;
  const badge = document.createElement('span');
  badge.className = item.ok ? BADGE_OK : BADGE_WARN;
  badge.textContent = item.ok ? 'ok' : 'none';
  el.append(label, badge);
  return el;
}

function render(root) {
  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-1 gap-4 md:grid-cols-2 max-w-4xl mx-auto';

  const card = document.createElement('section');
  card.className = CARD;
  const h = document.createElement('h2');
  h.className = HEADING;
  h.textContent = 'Plugin UI proof';
  const p = document.createElement('p');
  p.className = MUTED;
  p.textContent =
    'Styled entirely by the stylesheet core serves. No CSS shipped in this package.';
  card.append(h, p);
  STATUS.forEach((item) => card.append(row(item)));

  const actions = document.createElement('div');
  actions.className = CARD;
  const button = document.createElement('button');
  button.className = BUTTON;
  button.textContent = 'Does nothing';
  button.disabled = true;
  actions.append(button);

  grid.append(card, actions);
  root.replaceChildren(grid);
}

const root = document.getElementById('root');
if (root) render(root);

export { render };
