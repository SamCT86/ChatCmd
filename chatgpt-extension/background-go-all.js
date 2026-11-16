// A GO ALLA batch is explicitly started from the extension popup.
// Each target is a specific, existing ChatGPT conversation in this profile.
const GO_ALL_CONFIG_KEY = 'chatcmd-go-all-config';
const GO_ALL_RECEIPTS_KEY = 'chatcmd-go-all-receipts';
const GO_ALL_POPUP_URL = chrome.runtime.getURL('go-all.html');
const GO_ALL_SEND_WINDOW_MS = 10_000;
let goAllOperation = null;

const GO_ALL_SKIPPED = new Set(['busy', 'draft', 'approval', 'closed', 'unavailable', 'changed']);
const GO_ALL_RESULTS = new Set([
  'sent', 'busy', 'draft', 'approval', 'unavailable', 'changed', 'uncertain',
]);

function goAllConversationId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== 'https://chatgpt.com' || url.searchParams.get('temporary-chat') === 'true') return null;
    return url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9][a-zA-Z0-9-]{0,127})\/?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function goAllSleeping(tab) {
  return Boolean(tab.discarded || tab.frozen);
}

async function goAllTabs() {
  const tabs = new Map();
  for (const tab of await chatGptTabs()) {
    const id = goAllConversationId(tab.url);
    if (!id || !tab.id) continue;
    const copies = tabs.get(id) || [];
    copies.push(tab);
    tabs.set(id, copies);
  }
  for (const copies of tabs.values()) {
    copies.sort((first, second) => Number(goAllSleeping(first)) - Number(goAllSleeping(second))
      || (second.lastAccessed || 0) - (first.lastAccessed || 0));
  }
  return tabs;
}

function goAllSettings(raw) {
  const targets = new Map();
  for (const target of Array.isArray(raw?.targets) ? raw.targets : []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(target?.id || '')) continue;
    targets.set(target.id, { id: target.id, title: String(target.title || 'ChatGPT').slice(0, 180) });
  }
  return { prompt: typeof raw?.prompt === 'string' ? raw.prompt : '', targets: [...targets.values()] };
}

async function goAllReceipts() {
  const data = await chrome.storage.local.get(GO_ALL_RECEIPTS_KEY);
  return data[GO_ALL_RECEIPTS_KEY] || { batch: null, uncertain: [], recentTurns: [] };
}

async function goAllSnapshot() {
  const [tabs, stored, receipts] = await Promise.all([
    goAllTabs(), chrome.storage.local.get(GO_ALL_CONFIG_KEY), goAllReceipts(),
  ]);
  return {
    running: goAllOperation !== null && Boolean(receipts.batch?.rows.some((row) => row.status === 'pending')),
    settings: goAllSettings(stored[GO_ALL_CONFIG_KEY]),
    tabs: [...tabs].map(([id, [tab]]) => ({ id, title: tab.title || 'ChatGPT', sleeping: goAllSleeping(tab) })),
    batch: receipts.batch,
    uncertain: receipts.uncertain,
    retryableIds: (receipts.batch?.rows || []).filter((row) => GO_ALL_SKIPPED.has(row.status)).map((row) => row.id),
  };
}

function goAllNormalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function goAllFingerprint(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(goAllNormalizeText(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function shouldSkipGoAllNativeCapture(id, message) {
  const receipts = await goAllReceipts();
  const entries = [receipts.batch, ...receipts.uncertain, ...receipts.recentTurns];
  const candidates = entries.filter(Boolean).flatMap((record) => {
    const rows = record.rows || [record];
    return rows.filter((row) => row.id === id && ['pending', 'uncertain', 'sent'].includes(row.status))
      .map((row) => ({ row, fingerprint: record.fingerprint }));
  });
  if (!candidates.length) return false;
  if (candidates.some(({ row }) => row.messageId && row.messageId === message.userMessageId)) return true;
  const fingerprint = await goAllFingerprint(message.content);
  return candidates.some(({ row, fingerprint: expected }) =>
    expected === fingerprint && (!row.messageId || row.messageId === message.userMessageId));
}

function goAllUnknown(row) {
  return row.status === 'pending' || row.status === 'uncertain';
}

function goAllMergeUncertain(...groups) {
  const entries = new Map();
  for (const group of groups) {
    for (const item of group) if (goAllUnknown(item)) entries.set(item.id, item);
  }
  return [...entries.values()];
}

async function goAllProbeDuplicate(tab, id) {
  if (goAllSleeping(tab)) return 'unavailable';
  let timer;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'chatcmd-chatgpt-ready' }, { frameId: 0 }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2_000); }),
    ]);
    if (reply?.conversationId !== id) return 'unavailable';
    if (reply.generating || reply.goAllBusy) return 'busy';
    return reply.composerReady ? 'ready' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

async function goAllSendToTab(copies, prompt, row, deadline) {
  if (copies.length > 1) {
    const probes = await Promise.all(copies.map((tab) => goAllProbeDuplicate(tab, row.id)));
    if (probes.includes('busy')) return { ...row, status: 'busy' };
    if (probes.includes('unavailable')) return { ...row, status: 'unavailable' };
  }
  const [tab] = copies;
  let timer;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, {
        type: 'chatcmd-go-all-dispatch', id: row.id, prompt, deadline,
      }, { frameId: 0 }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()) + 1_000);
      }),
    ]);
    if (reply && GO_ALL_RESULTS.has(reply.status)) {
      return { ...row, status: reply.status, messageId: typeof reply.messageId === 'string' ? reply.messageId : undefined };
    }
  } catch (error) {
    if (isMissingReceiverError(error)) return { ...row, status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
  // A lost acknowledgement may still have followed a real Send click.
  return { ...row, status: 'uncertain' };
}

async function runGoAll(rawSettings, retrySkipped = false, sourceBatchId) {
  const settings = goAllSettings(rawSettings);
  if (!settings.prompt.trim() || !settings.targets.length) throw new Error('Spara en GO-prompt och välj minst en chatt.');
  const [tabs, previous, fingerprint] = await Promise.all([
    goAllTabs(), goAllReceipts(), goAllFingerprint(settings.prompt),
  ]);
  if (retrySkipped && previous.batch?.id !== sourceBatchId) {
    throw new Error('Listan har ändrats. Uppdatera flikarna innan du fortsätter.');
  }
  const skipIds = retrySkipped
    ? new Set((previous.batch?.rows || []).filter((row) => GO_ALL_SKIPPED.has(row.status)).map((row) => row.id))
    : null;
  const targets = skipIds ? settings.targets.filter((target) => skipIds.has(target.id)) : settings.targets;
  if (!targets.length) throw new Error('Inga valda chattar återstår att skicka till.');
  const previousTargets = new Set(previous.batch?.rows.map((row) => row.id) || []);
  if (previous.batch?.fingerprint === fingerprint
      && Date.now() - previous.batch.startedAt < 3_000
      && previousTargets.size === targets.length
      && targets.every((target) => previousTargets.has(target.id)) && !retrySkipped) return previous.batch;

  const interrupted = (previous.batch?.rows || []).filter(goAllUnknown)
    .map((row) => ({ ...row, fingerprint: previous.batch.fingerprint }));
  const uncertain = goAllMergeUncertain(previous.uncertain, interrupted);
  const uncertainIds = new Set(uncertain.map((row) => row.id));
  const recentTurns = previous.recentTurns || [];
  const justSent = new Set(recentTurns.filter((row) =>
    row.fingerprint === fingerprint && Date.now() - row.sentAt < 3_000).map((row) => row.id));
  const rows = targets.map(({ id, title }) => {
    const tab = tabs.get(id)?.[0];
    let status = 'pending';
    if (uncertainIds.has(id)) status = 'review';
    else if (justSent.has(id)) status = 'recent';
    else if (!tab) status = 'closed';
    else if (goAllSleeping(tab)) status = 'unavailable';
    return { id, title: tab?.title || title, status };
  });
  const batch = { id: crypto.randomUUID(), startedAt: Date.now(), fingerprint, rows };
  // Persist the intent first. A worker/browser restart leaves unsafely retriable targets fenced.
  await chrome.storage.local.set({
    [GO_ALL_CONFIG_KEY]: settings,
    [GO_ALL_RECEIPTS_KEY]: { batch, uncertain, recentTurns },
  });
  const deadline = Date.now() + GO_ALL_SEND_WINDOW_MS;
  batch.rows = await Promise.all(rows.map((row) => row.status === 'pending'
    ? goAllSendToTab(tabs.get(row.id), settings.prompt, row, deadline)
    : row));
  batch.finishedAt = Date.now();
  const sent = batch.rows.filter((row) => row.status === 'sent')
    .map((row) => ({ id: row.id, status: 'sent', messageId: row.messageId, fingerprint, sentAt: batch.finishedAt }));
  await chrome.storage.local.set({
    [GO_ALL_RECEIPTS_KEY]: {
      batch,
      uncertain: goAllMergeUncertain(uncertain, batch.rows.map((row) => ({ ...row, fingerprint }))),
      recentTurns: [...recentTurns, ...sent].slice(-100),
    },
  });
  return batch;
}

async function clearGoAllUncertain(sourceBatchId) {
  const receipts = await goAllReceipts();
  const batch = receipts.batch;
  if (batch?.id !== sourceBatchId) throw new Error('Kvittot har ändrats. Uppdatera listan och kontrollera det nya kvittot.');
  if (batch) batch.rows = batch.rows.map((row) => goAllUnknown(row) || row.status === 'review'
    ? { ...row, status: 'reviewed' }
    : row);
  await chrome.storage.local.set({ [GO_ALL_RECEIPTS_KEY]: { ...receipts, batch, uncertain: [] } });
}

async function focusGoAllChat(id) {
  const tabs = await goAllTabs();
  const tab = tabs.get(id)?.[0];
  if (!tab) throw new Error('ChatGPT-fliken är stängd.');
  const current = await chrome.tabs.get(tab.id);
  if (goAllConversationId(current.url) !== id) throw new Error('Fliken bytte konversation.');
  const active = await chrome.tabs.update(current.id, { active: true });
  await chrome.windows.update(active.windowId, { focused: true });
}

function goAllExclusively(operation) {
  if (goAllOperation) throw new Error('En GO ALLA-åtgärd pågår redan.');
  goAllOperation = Promise.resolve().then(operation).finally(() => { goAllOperation = null; });
  return goAllOperation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== GO_ALL_POPUP_URL
      || typeof message?.type !== 'string' || !message.type.startsWith('chatcmd-go-all-')) return false;
  const reply = async () => {
    switch (message?.type) {
      case 'chatcmd-go-all-list': return await goAllSnapshot();
      case 'chatcmd-go-all-focus':
        await focusGoAllChat(message.id);
        return {};
      case 'chatcmd-go-all-save':
        await goAllExclusively(() => chrome.storage.local.set({ [GO_ALL_CONFIG_KEY]: goAllSettings(message.settings) }));
        return {};
      case 'chatcmd-go-all-start':
        return {
          batch: await goAllExclusively(() => runGoAll(message.settings, message.retrySkipped === true, message.sourceBatchId)),
        };
      case 'chatcmd-go-all-clear-uncertain':
        await goAllExclusively(() => clearGoAllUncertain(message.sourceBatchId));
        return {};
      default: return {};
    }
  };
  void reply().then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});
