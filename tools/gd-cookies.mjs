#!/usr/bin/env node
/**
 * Inspect (and optionally clear) bot-management storage for a domain in a
 * live Chrome, over raw CDP.
 *
 * Nothing here is GoDaddy-specific despite the name and the default needle —
 * any domain substring works. `clear` is the fix when a site that used to work
 * starts returning bot-management challenges: its cookies are bound to the
 * fingerprint of whatever minted them, and once marked bad they stay bad until
 * the site is allowed to mint fresh ones.
 *
 * Usage:
 *   node gd-cookies.mjs list  [domainSubstring]
 *   node gd-cookies.mjs clear [domainSubstring]
 *
 * Targets port 9333 (the automation Chrome) by default. To operate on the
 * stealth Chrome instead:
 *   AUTOMATION_CHROME_DEBUG_PORT=9334 node gd-cookies.mjs list godaddy
 */

const PORT = Number(process.env.AUTOMATION_CHROME_DEBUG_PORT || 9333);
const MODE = process.argv[2] || 'list';
const NEEDLE = process.argv[3] || 'godaddy';

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});
const send = (method, params = {}, sessionId) => {
  const mid = ++id;
  const payload = { id: mid, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
};

const { cookies } = await send('Storage.getCookies');
const hits = cookies.filter((c) => c.domain.includes(NEEDLE));

// Cookie names that belong to bot-management vendors. These are bound to a
// device fingerprint at mint time, so copying them between browser profiles
// makes them invalid in a way that reads as "spoofed client" to the vendor.
const BOT_COOKIES = /^(_abck|bm_sz|bm_sv|bm_mi|bm_so|bm_sc|bm_s|ak_bmsc|AKA_A2|akm_lmprb|akm_lmprb-ssn|reese84|datadome|__cf_bm|KP_UIDz|x-kpsdk)/i;

console.log(`Cookies matching "${NEEDLE}": ${hits.length}\n`);
for (const c of hits) {
  const tag = BOT_COOKIES.test(c.name) ? '  [BOT-MGMT]' : '';
  const age = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session';
  console.log(
    `${c.domain.padEnd(24)} ${c.name.padEnd(24)} len=${String(c.value.length).padEnd(6)} exp=${age}${tag}`,
  );
}

if (MODE === 'clear') {
  const origins = [
    ...new Set(hits.map((c) => `https://${c.domain.replace(/^\./, '')}`)),
  ];

  for (const origin of origins) {
    await send('Storage.clearDataForOrigin', {
      origin,
      storageTypes:
        'cookies,local_storage,indexeddb,service_workers,cache_storage,websql,shader_cache',
    }).catch((e) => console.log(`  (clearDataForOrigin ${origin} failed: ${e.message})`));
  }

  // Origin-scoped clearing leaves domain cookies (".godaddy.com") behind, and
  // Network.deleteCookies only exists on a page session — so borrow one.
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  if (page) {
    const { sessionId } = await send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    for (const c of hits) {
      await send(
        'Network.deleteCookies',
        { name: c.name, domain: c.domain, path: c.path },
        sessionId,
      ).catch(() => {});
    }
    await send('Target.detachFromTarget', { sessionId });
  }

  const { cookies: after } = await send('Storage.getCookies');
  const left = after.filter((c) => c.domain.includes(NEEDLE));
  console.log(`\nCleared storage for ${origins.length} origins.`);
  console.log(`Cookies before: ${hits.length}  after: ${left.length}`);
  if (left.length) {
    console.log('Remaining:');
    for (const c of left) console.log(`  ${c.domain} ${c.name}`);
  }
}

ws.close();
