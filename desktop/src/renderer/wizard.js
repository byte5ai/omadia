/* Onboarding wizard renderer. Talks to the main process only through the
   `window.omadia` bridge exposed by preload.ts. No Node access here. */
'use strict';

// NB: do NOT name this `omadia`. contextBridge exposes `window.omadia` as a
// NON-CONFIGURABLE global property, and a top-level `const omadia` collides with
// it → "Identifier 'omadia' has already been declared", which aborts the whole
// script so no handlers bind and the wizard freezes. Use a distinct name.
const bridge = window.omadia;
// Locale overlay (wizard-i18n.js, loaded first). `wt(key, fallback)` returns
// the German string when the OS locale is German, else the fallback — so every
// call site keeps its English text readable inline.
const wt = window.wizardT || ((_k, fallback) => fallback);
if (window.applyWizardLocale) window.applyWizardLocale();
const LAST_STEP = 4;

const state = {
  step: 0,
  dataDir: null,
  /* True only after `testLlmKey` came back ok for the CURRENTLY entered
     provider+key. Reset on every edit below — a verdict about a previous key
     says nothing about this one. */
  keyVerified: false,
  /* Set when the user pressed Continue on the key step without a successful
     probe. The next press goes through. */
  unverifiedAcknowledged: false,
};

const $ = (sel) => document.querySelector(sel);
const stepSections = () => Array.from(document.querySelectorAll('.step[data-step]'));

/* If the preload bridge failed to load, `window.omadia` is undefined and every
   action would silently do nothing. Surface it loudly instead of hanging. */
function bridgeOk() {
  if (bridge) return true;
  const el = $('#testResult') || document.body;
  el.textContent = wt(
    'js.bridgeMissing',
    'Internal error: the app bridge did not load. Please reinstall or report this (tray → Open Logs).',
  );
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
  $('#next').textContent = state.step === LAST_STEP ? wt('nav.finish', 'Finish & start omadia') : wt('nav.continue', 'Continue');
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
    /* The wizard used to run the key probe and then throw the result away, so a
       typo'd or revoked key sailed through setup and resurfaced much later as an
       unexplained "invalid x-api-key" on every chat message. Consult the probe
       here instead. It is an acknowledgement, not a hard block: the probe also
       fails on an air-gapped or offline machine, and the wizard has to stay
       usable there — so the first Continue explains, the second proceeds. */
    if (!state.keyVerified && !state.unverifiedAcknowledged) {
      state.unverifiedAcknowledged = true;
      flashTest(
        wt('js.unverifiedHint', 'This key has not been verified yet. Press "Test key" to check it — or press Continue again to set it up unverified.'),
        false,
      );
      return false;
    }
  }
  return true;
}

/* Any edit to the provider or the key invalidates the previous probe result —
   otherwise "Test key" on a good key followed by pasting a bad one would still
   read as verified. */
function resetKeyVerification() {
  state.keyVerified = false;
  state.unverifiedAcknowledged = false;
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

  const unsubProgress = bridge.onBootProgress((p) => {
    const pct = PHASE_PCT[p.phase] ?? 10;
    $('#barFill').style.width = pct + '%';
    // Localized by PHASE (typed contract), supervisor message as fallback —
    // a new phase never renders blank, it just renders English.
    const phaseText = wt('boot.' + p.phase, p.message);
    $('#progressMsg').textContent = phaseText + (p.detail ? ' — ' + p.detail : '');
    if (p.phase === 'error') $('#barFill').style.background = 'var(--err)';
  });
  // Live, granular log (kernel migrations, plugin activation, DB readiness …).
  const unsubLog = bridge.onBootLog
    ? bridge.onBootLog((line) => appendBootLog(line.level, line.msg))
    : () => {};

  let res;
  try {
    res = await bridge.complete(collectConfig());
  } catch (err) {
    res = { ok: false, error: (err && err.message) || wt('js.setupCrashed', 'Setup crashed unexpectedly.') };
  } finally {
    clearInterval(ticker);
    unsubProgress();
    unsubLog();
  }

  if (!res.ok) {
    const err = $('#provisionError');
    err.textContent = res.error || wt('js.setupFailed', 'Setup failed. Check the logs (tray → Open Logs).');
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

$('#apiKey').addEventListener('input', resetKeyVerification);
$('#provider').addEventListener('change', resetKeyVerification);

$('#testKey').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  const provider = $('#provider').value;
  const apiKey = $('#apiKey').value.trim();
  if (apiKey.length < 8) {
    flashTest(wt('js.keyTooShort', 'Key looks too short.'), false);
    return;
  }
  const btn = $('#testKey');
  btn.disabled = true;
  flashTest(wt('js.testing', 'Testing…'), true);
  try {
    const res = await bridge.testLlmKey({ provider, apiKey });
    state.keyVerified = res.ok;
    flashTest(res.ok ? wt('js.keyWorks', 'Key works.') : res.error || wt('js.keyCheckFailed', 'Key check failed.'), res.ok);
  } catch (err) {
    // Never leave the user stuck on "Testing…" — surface the failure.
    state.keyVerified = false;
    flashTest((err && err.message) || wt('js.keyCheckFailedInternal', 'Key check failed (internal error).'), false);
  } finally {
    btn.disabled = false;
  }
});

$('#chooseDir').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  try {
    const dir = await bridge.chooseDataDir();
    if (dir) {
      state.dataDir = dir;
      $('#dataDir').value = dir;
      $('#dataDirHint').textContent = 'omadia will store everything in this folder.';
    }
  } catch (err) {
    $('#dataDirHint').textContent =
      wt(
        'js.pickerFailed',
        'Could not open the folder picker: {msg}. The default folder will be used.',
      ).replace('{msg}', (err && err.message) || 'internal error');
  }
});

$('#revealKey').addEventListener('click', async () => {
  if (!bridgeOk()) return;
  try {
    const key = await bridge.exportRecoveryKey();
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
if (!bridge) bridgeOk();
