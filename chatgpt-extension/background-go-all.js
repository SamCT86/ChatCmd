// A GO ALLA batch is explicitly started from the extension popup.
// Each target is a specific, existing ChatGPT conversation in this profile.
const GO_ALL_CONFIG_KEY = 'chatcmd-go-all-config';
const GO_ALL_RECEIPTS_KEY = 'chatcmd-go-all-receipts';
const GO_ALL_POPUP_URL = chrome.runtime.getURL('go-all.html');
const GO_ALL_LOAD_WINDOW_MS = 14_000;
const GO_ALL_SEND_WINDOW_MS = 10_000;
let goAllOperation = null;

const GO_ALL_SKIPPED = new Set(['busy', 'draft', 'approval', 'closed', 'unavailable', 'changed']);
const GO_ALL_RESULTS = new Set([
  'sent', 'busy', 'draft', 'approval', 'unavailable', 'changed', 'uncertain',
]);

function goAllChatLink(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password
        || url.searchParams.get('temporary-chat') === 'true') return null;
    const match = url.pathname.match(/^\/(?:g\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\/)?c\/([a-zA-Z0-9][a-zA-Z0-9-]{0,127})\/?$/);
    if (!match) return null;
    const group = match[1] || '';
    const project = group.match(/^(g-p-[0-9a-f]{32})(?:-|$)/i)?.[1];
    const projectName = project ? group.slice(project.length + 1).replace(/-/g, ' ') : '';
    return { id: match[2], group: project || group, projectName, url: url.origin + url.pathname.replace(/\/$/, '') };
  } catch {
    return null;
  }
}

function goAllMatchesTarget(rawUrl, target) {
  const actual = goAllChatLink(rawUrl);
  const saved = goAllChatLink(target.url);
  return actual?.id === target.id && (!saved || actual.group === saved.group);
}

function goAllTargetUrl(target) {
  return target.url || new URL('/c/' + target.id, CHATGPT_HOME).href;
}

function goAllWithTabLink(target, tabs) {
  if (target.url) return target;
  const urls = (tabs.get(target.id) || []).map((tab) => goAllChatLink(tab.url)).filter(Boolean);
  const projectLinks = urls.filter((link) => link.group);
  if (new Set(projectLinks.map((link) => link.group)).size > 1) return target;
  const link = projectLinks[0] || urls[0];
  return link ? { ...target, url: link.url, projectName: link.projectName } : target;
}

function goAllSleeping(tab) {
  return Boolean(tab.discarded || tab.frozen);
}

async function goAllTabs() {
  const tabs = new Map();
  for (const tab of await chatGptTabs()) {
    const id = goAllChatLink(tab.url)?.id;
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
    const link = goAllChatLink(target.url);
    targets.set(target.id, { id: target.id, title: String(target.title || 'ChatGPT').slice(0, 180),
      ...(link?.id === target.id ? { url: link.url, projectName: link.projectName } : {}) });
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
    settings: goAllSettingsWithLinks(stored[GO_ALL_CONFIG_KEY], tabs),
    tabs: [...tabs].map(([id, [tab]]) => ({
      ...goAllWithTabLink({ id, title: tab.title || 'ChatGPT' }, tabs), sleeping: goAllSleeping(tab),
    })),
    batch: receipts.batch,
    uncertain: receipts.uncertain,
    retryableIds: (receipts.batch?.rows || []).filter((row) => GO_ALL_SKIPPED.has(row.status)).map((row) => row.id),
  };
}

function goAllSettingsWithLinks(rawSettings, tabs) {
  const settings = goAllSettings(rawSettings);
  settings.targets = settings.targets.map((target) => goAllWithTabLink(target, tabs));
  return settings;
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

function goAllProbeTab(tab) {
  return chrome.tabs.sendMessage(tab.id, { type: 'chatcmd-chatgpt-ready', requireThread: true }, { frameId: 0 });
}

async function goAllPrepareTab(tab, target, deadline) {
  if (goAllSleeping(tab)) return { status: 'unavailable', detail: 'sleeping' };
  if (!goAllMatchesTarget(tab.url, target)) return { status: 'changed' };
  let timer;
  const prepare = async () => {
    let reply;
    try {
      reply = await goAllProbeTab(tab);
    } catch (error) {
      if (!isMissingReceiverError(error)) return { status: 'unavailable', detail: 'bridge' };
    }
    if (reply?.goAllProtocol !== 2) {
      const current = await safeTab(tab.id);
      if (!current) return { status: 'closed' };
      if (!goAllMatchesTarget(current.url, target)) return { status: 'changed' };
      if (goAllSleeping(current)) return { status: 'unavailable', detail: 'sleeping' };
      if (Date.now() >= deadline) return { status: 'unavailable', detail: 'timeout' };
      await injectChatGptScripts(tab.id);
      reply = await goAllProbeTab(tab);
    }
    if (reply?.goAllProtocol !== 2) return { status: 'unavailable', detail: 'bridge' };
    if (!goAllMatchesTarget(reply.conversationUrl, target)) return { status: 'changed' };
    if (reply.generating || reply.goAllBusy) return { status: 'busy' };
    if (!reply.threadReady) return { status: 'unavailable', detail: 'thread' };
    return reply.composerReady
      ? { status: 'ready', url: goAllChatLink(reply.conversationUrl).url }
      : { status: 'unavailable', detail: 'composer' };
  };
  try {
    return await Promise.race([
      prepare(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unavailable', detail: 'timeout' }),
          Math.min(4_000, Math.max(0, deadline - Date.now())));
      }),
    ]);
  } catch {
    return { status: 'unavailable', detail: 'bridge' };
  } finally {
    clearTimeout(timer);
  }
}

async function goAllWaitForTarget(tabId, target, deadline) {
  let result = { status: 'unavailable', detail: 'loading' };
  while (Date.now() < deadline) {
    const tab = await safeTab(tabId);
    if (!tab) return { status: 'closed' };
    if (tab.status === 'complete' && !tab.pendingUrl) {
      if (!goAllMatchesTarget(tab.url, target)) return { status: 'changed', detail: 'target' };
      result = await goAllPrepareTab(tab, target, deadline);
      if (result.status !== 'unavailable' || result.detail === 'sleeping') return result;
    }
    if (Date.now() < deadline) await delay(250);
  }
  return result;
}

async function goAllDispatch(tabId, prompt, row, ready) {
  const deadline = Date.now() + GO_ALL_SEND_WINDOW_MS;
  const target = { ...row, url: ready.url };
  let timer;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: 'chatcmd-go-all-dispatch', id: row.id, prompt, deadline, path: new URL(ready.url).pathname,
      }, { frameId: 0 }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()) + 1_000);
      }),
    ]);
    if (reply && GO_ALL_RESULTS.has(reply.status)) {
      return { ...target, status: reply.status, detail: reply.detail,
        messageId: typeof reply.messageId === 'string' ? reply.messageId : undefined };
    }
  } catch (error) {
    if (isMissingReceiverError(error)) return { ...target, status: 'unavailable', detail: 'bridge' };
  } finally {
    clearTimeout(timer);
  }
  // A lost acknowledgement may still have followed a real Send click.
  return { ...target, status: 'uncertain' };
}

async function goAllSendTarget(copies, prompt, row) {
  const matching = copies.filter((tab) => goAllMatchesTarget(tab.url, row));
  if (!row.url && new Set(matching.map((tab) => goAllChatLink(tab.url).group)).size > 1) {
    return { ...row, status: 'unavailable', detail: 'ambiguous_target' };
  }
  const deadline = Date.now() + GO_ALL_LOAD_WINDOW_MS;
  if (!matching.length) {
    let tab;
    try { tab = await chrome.tabs.create({ url: goAllTargetUrl(row), active: false }); }
    catch { return { ...row, status: 'unavailable', detail: 'open_failed' }; }
    if (!tab?.id) return { ...row, status: 'unavailable', detail: 'open_failed' };
    const ready = await goAllWaitForTarget(tab.id, row, deadline);
    return ready.status === 'ready' ? goAllDispatch(tab.id, prompt, row, ready) : { ...row, ...ready };
  }

  const probes = await Promise.all(matching.map((tab) => tab.status === 'loading' && !goAllSleeping(tab)
    ? goAllWaitForTarget(tab.id, row, deadline) : goAllPrepareTab(tab, row, deadline)));
  const blocked = probes.find((probe) => probe.status === 'busy')
    || probes.find((probe) => probe.status !== 'ready');
  return blocked ? { ...row, ...blocked } : goAllDispatch(matching[0].id, prompt, row, probes[0]);
}

async function runGoAll(rawSettings, retrySkipped = false, sourceBatchId) {
  const [tabs, previous] = await Promise.all([goAllTabs(), goAllReceipts()]);
  const settings = goAllSettingsWithLinks(rawSettings, tabs);
  if (!settings.prompt.trim() || !settings.targets.length) throw new Error('Spara en GO-prompt och välj minst en chatt.');
  const fingerprint = await goAllFingerprint(settings.prompt);
  if (retrySkipped && previous.batch?.id !== sourceBatchId) {
    throw new Error('Listan har ändrats. Uppdatera flikarna innan du fortsätter.');
  }
  if (retrySkipped && previous.batch?.fingerprint !== fingerprint) {
    throw new Error('GO-prompten har ändrats. Återställ den föregående prompten innan du startar återstående chattar.');
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
  const rows = targets.map((target) => ({
    ...target, status: uncertainIds.has(target.id) ? 'review' : justSent.has(target.id) ? 'recent' : 'pending',
  }));
  const batch = { id: crypto.randomUUID(), startedAt: Date.now(), fingerprint, rows };
  // Persist the intent first. A worker/browser restart leaves unsafely retriable targets fenced.
  await chrome.storage.local.set({
    [GO_ALL_CONFIG_KEY]: settings,
    [GO_ALL_RECEIPTS_KEY]: { batch, uncertain, recentTurns },
  });
  batch.rows = await Promise.all(rows.map((row) => row.status === 'pending'
    ? goAllSendTarget(tabs.get(row.id) || [], settings.prompt, row)
    : row));
  batch.finishedAt = Date.now();
  const sent = batch.rows.filter((row) => row.status === 'sent')
    .map((row) => ({ id: row.id, status: 'sent', messageId: row.messageId, fingerprint, sentAt: batch.finishedAt }));
  const learned = new Map(batch.rows.filter((row) => row.url).map((row) => [row.id, row.url]));
  settings.targets = goAllSettings({
    targets: settings.targets.map((target) => ({ ...target, url: learned.get(target.id) || target.url })),
  }).targets;
  await chrome.storage.local.set({
    [GO_ALL_CONFIG_KEY]: settings,
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

async function focusGoAllChat(id, selectedUrl) {
  const [tabs, stored, receipts] = await Promise.all([
    goAllTabs(), chrome.storage.local.get(GO_ALL_CONFIG_KEY), goAllReceipts(),
  ]);
  const supplied = goAllChatLink(selectedUrl);
  const target = (supplied?.id === id ? supplied : null)
    || goAllSettings(stored[GO_ALL_CONFIG_KEY]).targets.find((chat) => chat.id === id)
    || receipts.batch?.rows.find((row) => row.id === id)
    || (tabs.has(id) ? { id } : null);
  if (!target) throw new Error('Spara chattens länk och försök igen.');
  const existing = (tabs.get(id) || []).find((tab) => goAllMatchesTarget(tab.url, target));
  const current = existing && await safeTab(existing.id);
  if (current && goAllMatchesTarget(current.url, target)) {
    const active = await chrome.tabs.update(current.id, { active: true });
    if (active?.windowId !== undefined) await chrome.windows.update(active.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: goAllTargetUrl(target), active: true });
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
        await goAllExclusively(() => focusGoAllChat(message.id, message.url));
        return {};
      case 'chatcmd-go-all-target': {
        const link = goAllChatLink(message.url);
        if (!link) throw new Error('Ange länken till en befintlig chatt på chatgpt.com.');
        return { target: { ...link, title: link.projectName || 'ChatGPT-chatt' } };
      }
      case 'chatcmd-go-all-save':
        await goAllExclusively(async () => {
          const settings = goAllSettingsWithLinks(message.settings, await goAllTabs());
          await chrome.storage.local.set({ [GO_ALL_CONFIG_KEY]: settings });
        });
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
