/* Onboarding wizard renderer. Talks to the main process only through the
   `window.omadia` bridge exposed by preload.ts. No Node access here. */
'use strict';

const omadia = window.omadia;
const LAST_STEP = 4;

const state = {
  step: 0,
  dataDir: null,
  keyVerified: false,
};

const $ = (sel) => document.querySelector(sel);
const stepSections = () => Array.from(document.querySelectorAll('.step[data-step]'));

/* If the preload bridge failed to load, `window.omadia` is undefined and every
   action would silently do nothing. Surface it loudly instead of hanging. */
function bridgeOk() {
  if (omadia) return true;
  const el = $('#testResult') || document.body;
  el.textContent =
    'Internal error: the app bridge did not load. Please reinstall or report this (tray → Open Logs).';
  if (el.className !== undefined) el.className = 'test-result err';
  return false;
}

/* Append a line to the live install log (verbosity during provisioning). */
function appendBootLog(level, msg) {
  const el = $('#bootLog');
  if (!el) return;
  const line = document.createElement('div');
  const cls = level === 'ERROR' ? 'l-err' : level === 'WARN' ? 'l-warn' : '';
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  // Cap to keep the DOM light on a chatty boot.
  while (el.childElementCount > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function show(stepKey) {
  stepSections().forEach((el) => {
    el.classList.toggle('hidden', el.dataset.step !== String(stepKey));
  });
}

function renderRail() {
  document.querySelectorAll('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === state.step);
    li.classList.toggle('done', n < state.step);
  });
}

function renderNav() {
  $('#back').disabled = state.step === 0;
  $('#next').textContent = state.step === LAST_STEP ? 'Finish & start omadia' : 'Continue';
}

function goto(step) {
  state.step = step;
  show(step);
  renderRail();
  renderNav();
}

function validateCurrent() {
  if (state.step === 1) {
    const key = $('#apiKey').value.trim();
    if (key.length < 8) {
      flashTest('Please enter your API key first.', false);
      return false;
    }
  }
  return true;
}

function flashTest(msg, ok) {
  const el = $('#testResult');
  el.textContent = msg;
  el.className = 'test-result ' + (ok ? 'ok' : 'err');
}

function collectConfig() {
  return {
    provider: $('#provider').value,
    apiKey: $('#apiKey').value.trim(),
    capabilities: {
      attachments: $('#capAttachments').checked,
      embeddings: $('#capEmbeddings').checked,
      diagrams: $('#capDiagrams').checked,
    },
    dataDir: state.dataDir,
  };
}

const PHASE_PCT = {
  'starting-db': 15,
  'starting-kernel': 35,
  'waiting-kernel': 60,
  'starting-ui': 85,
  ready: 100,
  error: 100,
};

async function provision() {
  if (!bridgeOk()) return;
  show('provision');
  document.querySelector('.nav').style.display = 'none';
  document.querySelectorAll('#steps li').forEach((li) => li.classList.add('done'));
  $('#provisionError').classList.add('hidden');
  $('#bootLog').textContent = '';

  // Elapsed timer so a long first-boot (migrations) clearly looks alive.
  const started = Date.now();
  const elapsedEl = $('#elapsed');
  const ticker = setInterval(() => {
    if (elapsedEl) elapsedEl.textContent = `(${Math.round((Date.now() - started) / 1000)}s)`;
  }, 1000);

  const unsubProgress = omadia.onBootProgress((p) => {
    const pct = PHASE_PCT[p.phase] ?? 10;
    $('#barFill').style.width = pct + '%';
    $('#progressMsg').textContent = p.message + (p.detail ? ' — ' + p.detail : '');
    if (p.phase === 'error') $('#barFill').style.background = 'var(--err)';
  });
  // Live, granular log (kernel migrations, plugin activation, DB readiness …).
  const unsubLog = omadia.onBootLog
    ? omadia.onBootLog((line) => appendBootLog(line.level, line.msg))
    : () => {};

  let res;
  try {
    res = await omadia.complete(collectConfig());
  } catch (err) {
    res = { ok: false, error: (err && err.message) || 'Setup crashed unexpectedly.' };
  } finally {
    clearInterval(ticker);
    unsubProgress();
    unsubLog();
  }

  if (!res.ok) {
    const err = $('#provisionError');
    err.textContent = res.error || 'Setup failed. Check the logs (tray → Open Logs).';
    err.classList.remove('hidden');
    appendBootLog('ERROR', res.error || 'Setup failed.');
    // Allow another attempt.
    document.querySelector('.nav').style.display = 'flex';
    $('#next').textContent = 'Retry';
    $('#next').onclick = () => provision();
  }
  // On success, the main process swaps this window to the admin UI — nothing to do.
}

/* --- wiring --- */
$('#next').addEventListener('click', () => {
  if (!validateCurrent()) return;
  if (state.step === LAST_STEP) {
    void provision();
  } else {
    goto(state.step + 1);
  }
});

$('#back').addEventListener('click', () => {
  if (state.step > 0) goto(state.step - 1);
});

$('#testKey').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  const provider = $('#provider').value;
  const apiKey = $('#apiKey').value.trim();
  if (apiKey.length < 8) {
    flashTest('Key looks too short.', false);
    return;
  }
  const btn = $('#testKey');
  btn.disabled = true;
  flashTest('Testing…', true);
  try {
    const res = await omadia.testLlmKey({ provider, apiKey });
    state.keyVerified = res.ok;
    flashTest(res.ok ? 'Key works.' : res.error || 'Key check failed.', res.ok);
  } catch (err) {
    // Never leave the user stuck on "Testing…" — surface the failure.
    state.keyVerified = false;
    flashTest((err && err.message) || 'Key check failed (internal error).', false);
  } finally {
    btn.disabled = false;
  }
});

$('#chooseDir').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  try {
    const dir = await omadia.chooseDataDir();
    if (dir) {
      state.dataDir = dir;
      $('#dataDir').value = dir;
      $('#dataDirHint').textContent = 'omadia will store everything in this folder.';
    }
  } catch (err) {
    $('#dataDirHint').textContent =
      'Could not open the folder picker: ' + ((err && err.message) || 'internal error') + '. The default folder will be used.';
  }
});

$('#revealKey').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  try {
    const key = await omadia.exportRecoveryKey();
    $('#recoveryKey').textContent = key;
    $('#revealKey').textContent = 'Copy';
    $('#revealKey').onclick = async () => {
      await navigator.clipboard.writeText(key);
      $('#revealKey').textContent = 'Copied';
    };
  } catch (err) {
    $('#recoveryKey').textContent = 'unavailable — ' + ((err && err.message) || 'internal error');
  }
});

goto(0);
// Fail loud, not silent, if the preload bridge is missing.
if (!omadia) bridgeOk();
