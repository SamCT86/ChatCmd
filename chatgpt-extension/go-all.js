const promptInput = document.getElementById('prompt');
const chatList = document.getElementById('chats');
const empty = document.getElementById('empty');
const status = document.getElementById('status');
const refresh = document.getElementById('refresh');
const save = document.getElementById('save');
const run = document.getElementById('run');
const retry = document.getElementById('retry-skipped');
const clear = document.getElementById('clear-uncertain');

const labels = {
  pending: 'Skickstatus okänd',
  sent: 'Skickat',
  busy: 'Jobbar redan',
  closed: 'Fliken är stängd',
  draft: 'Skrivfältet har ett utkast eller en bilaga',
  approval: 'En dialog väntar på dig',
  changed: 'Fliken bytte konversation',
  unavailable: 'Fliken är inte redo. Öppna eller ladda om den.',
  uncertain: 'Okänt om GO skickades. Kontrollera chatten.',
  review: 'Pausad tills du kontrollerat föregående skick',
  reviewed: 'Kontrollerad manuellt',
  recent: 'Samma GO skickades nyss',
};

const unavailableDetails = {
  sleeping: 'Fliken vilar. Öppna den och försök igen.',
  bridge: 'Tillägget når inte fliken. Ladda om chatten.',
  composer: 'ChatGPTs skrivfält hittades inte. Öppna chatten och kontrollera att skrivfältet syns.',
  send_control: 'Skicka-knappen blev inte redo. Öppna chatten och kontrollera skrivfältet.',
  timeout: 'Fliken svarade för långsamt. Öppna den och försök igen.',
};

let tabs = [];
let chosen = new Map();
let batch = null;
let uncertain = [];
let running = false;
let working = true;
let retryableIds = new Set();

function settings() {
  return { prompt: promptInput.value, targets: [...chosen.values()] };
}

async function request(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'chatcmd-go-all-' + type, ...fields });
  if (!result?.ok) throw new Error(result?.error || 'ChatCMD kunde inte slutföra åtgärden.');
  return result;
}

function updateActions() {
  const locked = working || running;
  refresh.disabled = working;
  promptInput.disabled = locked;
  save.disabled = locked;
  run.disabled = locked || !chosen.size || !promptInput.value.trim();
  retry.hidden = ![...retryableIds].some((id) => chosen.has(id));
  retry.disabled = run.disabled;
  clear.disabled = locked;
  for (const control of chatList.querySelectorAll('input, button')) control.disabled = locked;
}

function render() {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const results = new Map((batch?.rows || []).map((row) => [row.id, row]));
  const uncertainIds = new Set(uncertain.map((row) => row.id));
  const ids = new Set([...byId.keys(), ...chosen.keys(), ...results.keys()]);
  chatList.replaceChildren();
  empty.hidden = ids.size > 0;

  for (const id of ids) {
    const tab = byId.get(id);
    const receipt = results.get(id);
    const title = tab?.title || chosen.get(id)?.title || receipt?.title || 'ChatGPT';
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = chosen.has(id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) chosen.set(id, { id, title });
      else chosen.delete(id);
      updateActions();
    });
    label.append(checkbox, document.createTextNode(title));
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.append(label);
    if (tab) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Öppna';
      open.setAttribute('aria-label', 'Öppna ' + title);
      open.addEventListener('click', () => void perform(() => request('focus', { id })));
      row.append(open);
    }
    item.append(row);
    const note = document.createElement('small');
    if (receipt?.status === 'pending' && running) note.textContent = 'Skickar…';
    else if (uncertainIds.has(id)) note.textContent = labels.uncertain;
    else if (receipt) note.textContent = unavailableDetails[receipt.detail] || labels[receipt.status];
    else if (!tab) note.textContent = labels.closed;
    else if (tab.sleeping) note.textContent = 'Vilande flik';
    if (receipt?.status === 'sent') note.dataset.sent = 'true';
    if (note.textContent) item.append(note);
    chatList.append(item);
  }
  clear.hidden = !uncertain.length && !batch?.rows.some((row) => ['pending', 'uncertain'].includes(row.status));
  updateActions();
}

function showBatch() {
  if (running) {
    status.textContent = 'GO ALLA skickar till de valda chattarna…';
    return;
  }
  if (!batch) return;
  const sent = batch.rows.filter((row) => row.status === 'sent').length;
  const needsCheck = batch.rows.filter((row) => ['uncertain', 'pending', 'review'].includes(row.status)).length;
  const skipped = batch.rows.length - sent - needsCheck;
  status.textContent = [sent + ' skickade', skipped + ' överhoppade', needsCheck + ' behöver kontrolleras'].join(' · ');
}

async function load({ restore = false } = {}) {
  const snapshot = await request('list');
  tabs = snapshot.tabs;
  batch = snapshot.batch;
  uncertain = snapshot.uncertain;
  retryableIds = new Set(snapshot.retryableIds);
  running = snapshot.running;
  if (restore) {
    promptInput.value = snapshot.settings.prompt;
    chosen = new Map(snapshot.settings.targets.map((target) => [target.id, target]));
  }
  render();
  showBatch();
}

async function perform(action) {
  if (working) return;
  working = true;
  updateActions();
  try { await action(); }
  catch (error) { status.textContent = error.message; }
  finally {
    working = false;
    updateActions();
  }
}

promptInput.addEventListener('input', updateActions);
refresh.addEventListener('click', () => void perform(load));
save.addEventListener('click', () => void perform(async () => {
  await request('save', { settings: settings() });
  status.textContent = 'Prompt och chattar sparade.';
}));
function start(retrySkipped = false) {
  return perform(async () => {
    status.textContent = retrySkipped ? 'Skickar till återstående chattar…' : 'GO ALLA skickar till de valda chattarna…';
    await request('start', { settings: settings(), retrySkipped, sourceBatchId: batch?.id });
    await load();
  });
}
run.addEventListener('click', () => void start());
retry.addEventListener('click', () => void start(true));
clear.addEventListener('click', () => {
  if (!window.confirm('Kontrollera först i varje berörd chatt om GO redan finns där. Markera alla osäkra skick som kontrollerade?')) return;
  void perform(async () => {
    await request('clear-uncertain', { sourceBatchId: batch?.id });
    await load();
    status.textContent = 'Osäkra skick markerade som kontrollerade.';
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['chatcmd-go-all-receipts'] && !working) void perform(load);
});
working = false;
void perform(() => load({ restore: true }));
