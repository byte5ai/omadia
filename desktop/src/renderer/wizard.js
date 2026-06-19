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
  show('provision');
  document.querySelector('.nav').style.display = 'none';
  document.querySelectorAll('#steps li').forEach((li) => li.classList.add('done'));

  const unsub = omadia.onBootProgress((p) => {
    const pct = PHASE_PCT[p.phase] ?? 10;
    $('#barFill').style.width = pct + '%';
    $('#progressMsg').textContent = p.message + (p.detail ? ' — ' + p.detail : '');
    if (p.phase === 'error') $('#barFill').style.background = 'var(--err)';
  });

  const res = await omadia.complete(collectConfig());
  unsub();

  if (!res.ok) {
    const err = $('#provisionError');
    err.textContent = res.error || 'Setup failed. Check the logs (tray → Open Logs).';
    err.classList.remove('hidden');
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
  const provider = $('#provider').value;
  const apiKey = $('#apiKey').value.trim();
  if (apiKey.length < 8) {
    flashTest('Key looks too short.', false);
    return;
  }
  flashTest('Testing…', true);
  const res = await omadia.testLlmKey({ provider, apiKey });
  state.keyVerified = res.ok;
  flashTest(res.ok ? 'Key works.' : res.error || 'Key check failed.', res.ok);
});

$('#chooseDir').addEventListener('click', async () => {
  const dir = await omadia.chooseDataDir();
  if (dir) {
    state.dataDir = dir;
    $('#dataDir').value = dir;
    $('#dataDirHint').textContent = 'omadia will store everything in this folder.';
  }
});

$('#revealKey').addEventListener('click', async () => {
  const key = await omadia.exportRecoveryKey();
  $('#recoveryKey').textContent = key;
  $('#revealKey').textContent = 'Copy';
  $('#revealKey').onclick = async () => {
    await navigator.clipboard.writeText(key);
    $('#revealKey').textContent = 'Copied';
  };
});

goto(0);
