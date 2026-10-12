// Seeds from AVIANART (avianart.games), played here.
//
// AVIANART runs the Door Randomizer on its own server. It's asked the same
// way its Discord bot (PedChicken) and SahasrahBot ask it:
//   POST api.php?action=generate&preset=<preset>   body [{args:{race, namespace}}]
//        -> { status: 200, response: { hash, status: 'generating' } }
//   GET  api.php?action=permlink&hash=<hash>        (poll until it's done)
//        -> { status: 200, response: { status?, message?, bps_t0_p1 | patch, basepatch, spoiler } }
// A finished seed has no response.status (or 'finished'). Its ROM is either a
// BPS patch (base64, onto the Japanese 1.0 ROM) or, for older seeds, an
// alttpr.com-style byte patch onto the Door Randomizer base ROM (basepatch.bps).
//
// The browser tries AVIANART directly first. If AVIANART doesn't allow other
// sites to read it (CORS), it goes through a relay: relay/avianart-worker.js,
// a free Cloudflare Worker (see the README).

import { applyBps, crc32 } from './bps.js';

const API = 'https://avianart.games/api.php';
export const SITE = 'https://avianart.games';
const RELAY_KEY = 'unified-avianart-relay';
export const DEFAULT_RELAY = 'https://avianart-relay.hugecrankhank.workers.dev';

// Presets offered in the Randomizer bar. `id` is AVIANART's own preset name,
// "namespace/preset" for someone's preset (as PedChicken shows it).
export const PRESETS = [
  { id: 'jem041/onlyadkdf', label: 'OnlyADKDF (jem041)', onlyadkd: true,
    note: 'Open, crossed entrances, pot and enemy key drops, random weapons, 7/6 crystals' },
];

export function ownRelay() {
  try { return (localStorage.getItem(RELAY_KEY) || '').trim().replace(/\/+$/, ''); } catch (e) { return ''; }
}
export function setRelayUrl(u) {
  try {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (u) localStorage.setItem(RELAY_KEY, u); else localStorage.removeItem(RELAY_KEY);
  } catch (e) {}
}
const relayUrl = () => ownRelay() || DEFAULT_RELAY;

/** "https://avianart.games/perm/xsuXUdwND" (or without https://) -> the hash. */
export function avianId(text) {
  const m = String(text || '').trim().match(/avianart\.games\/perm\/([A-Za-z0-9]{4,32})\b/);
  return m ? m[1] : null;
}
export const permLink = (hash) => `${SITE}/perm/${hash}`;

/** "jem041/onlyadkdf" -> { namespace: 'jem041', preset: 'onlyadkdf' }. */
export function splitPreset(id) {
  const s = String(id || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  const i = s.indexOf('/');
  return i < 0 ? { namespace: '', preset: s } : { namespace: s.slice(0, i), preset: s.slice(i + 1) };
}
export const presetInfo = (id) => PRESETS.find((p) => p.id === String(id || '').toLowerCase()) || null;

// ── talking to AVIANART (directly, or through the relay) ─────────────────────
let direct = null;   // null = not tried yet, true/false once known

function abortError() { const x = new Error('Stopped.'); x.cancelled = true; return x; }

async function call(query, init = {}, signal) {
  const tries = direct === false ? ['relay'] : ['direct', 'relay'];
  let lastErr = null;
  for (const how of tries) {
    const url = how === 'direct' ? `${API}?${query}` : `${relayUrl()}/api.php?${query}`;
    let r;
    try {
      r = await fetch(url, { ...init, signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw abortError();
      if (how === 'direct') { direct = false; continue; }   // CORS (or offline): use the relay from now on
      lastErr = new Error('Couldn\'t reach AVIANART or its relay. If the relay isn\'t set up yet, see "AVIANART relay" in the README.');
      lastErr.needsRelay = true;
      break;
    }
    if (how === 'direct') direct = true;
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (!j) throw new Error(`AVIANART didn't answer with seed data (${r.status}).`);
    return j;
  }
  throw lastErr;
}

/** Ask AVIANART to roll a preset: the new seed's hash. */
export async function generate(presetId, { race = false, signal } = {}) {
  const { namespace, preset } = splitPreset(presetId);
  if (!/^[a-z0-9_.-]+$/.test(preset) || (namespace && !/^[a-z0-9_.-]+$/.test(namespace))) {
    throw new Error('That isn\'t an AVIANART preset name (like jem041/onlyadkdf).');
  }
  const args = { race: !!race };
  if (namespace) args.namespace = namespace;
  const j = await call(`action=generate&preset=${encodeURIComponent(preset)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ args }]),
  }, signal);
  const hash = j && j.response && j.response.hash;
  if (j.status !== 200 || !hash) {
    throw new Error('AVIANART didn\'t roll that preset' + (j.response && j.response.message ? `: ${j.response.message}` : '.'));
  }
  return String(hash);
}

/** A seed by its hash, waiting while AVIANART is still making it: the response. */
export async function seed(hash, { signal, onWait } = {}) {
  const started = Date.now();
  for (;;) {
    const j = await call(`action=permlink&hash=${encodeURIComponent(hash)}`, {}, signal);
    const r = (j && j.response) || null;
    if (!r) throw new Error('AVIANART has no seed with that link.');
    const st = r.status;
    if (!st || st === 'finished') {
      if (r.bps_t0_p1 || r.patch) return r;
      throw new Error('AVIANART sent this seed without its ROM patch.');
    }
    if (st === 'failure') throw new Error('AVIANART couldn\'t make this seed' + (r.message ? `: ${String(r.message).trim()}` : '.'));
    if (Date.now() - started > 6 * 60 * 1000) throw new Error('AVIANART is taking too long with this seed. Try its link again later.');
    if (onWait) onWait(st, r.attempts, r.message);
    await new Promise((res, rej) => {
      const t = setTimeout(res, 4000);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
    });
  }
}

// ── the ROM ──────────────────────────────────────────────────────────────────
function b64(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const bpsSourceCrc = (p) => new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(p.length - 12, true);

async function basePatchFor(r, kv) {
  const url = r.basepatch && r.basepatch.bps;
  if (!url) throw new Error('AVIANART didn\'t say which base ROM this seed needs.');
  const name = String(url).split('/').pop();
  const key = 'avian-bps-' + name;
  let bps = await kv.get(key).catch(() => null);
  if (bps) return bps;
  const full = /^https?:\/\//.test(url) ? url : `https://${String(url).replace(/^\/+/, '')}`;
  let res = null;
  try { res = await fetch(full); } catch (e) {}
  if (!res || !res.ok) {
    try { res = await fetch(`${relayUrl()}/file?u=${encodeURIComponent(full)}`); } catch (e) { res = null; }
  }
  if (!res || !res.ok) throw new Error('Couldn\'t download the base patch for this AVIANART seed.');
  bps = new Uint8Array(await res.arrayBuffer());
  await kv.set(key, bps).catch(() => {});
  return bps;
}

/** The seed's ROM from the player's Japanese 1.0 ROM (cosmetics and checksum are the caller's). */
export async function buildRom(jp, r, kv) {
  jp = jp.subarray(0, 0x100000);
  if (r.bps_t0_p1) {
    const p = b64(r.bps_t0_p1);
    if (bpsSourceCrc(p) === crc32(jp)) return applyBps(jp, p);
    // a patch onto the Door Randomizer base ROM instead
    return applyBps(applyBps(jp, await basePatchFor(r, kv)), p);
  }
  // older seeds: byte patches onto the base ROM
  const base = applyBps(jp, await basePatchFor(r, kv));
  let size = Math.max(0x200000, base.length, (r.size || 2) * 1024 * 1024);
  const writes = Array.isArray(r.patch) ? r.patch : [r.patch];
  for (const w of writes) for (const [off, bytes] of Object.entries(w)) size = Math.max(size, Number(off) + bytes.length);
  const rom = new Uint8Array(size);
  rom.set(base);
  for (const w of writes) for (const [off, bytes] of Object.entries(w)) rom.set(bytes, Number(off));
  return rom;
}

// ── what the seed is ─────────────────────────────────────────────────────────
// The Door Randomizer's spoiler settings (spoiler.meta), as AVIANART sends
// them: one value per setting. Key names differ a little between DR versions.
export function meta(r) { return (r && r.spoiler && r.spoiler.meta) || {}; }

const pick = (m, ...keys) => { for (const k of keys) if (m[k] !== undefined && m[k] !== null) return m[k]; return undefined; };
const on = (v) => v === true || v === 1 || /^(true|yes|on|1|wild)$/i.test(String(v));
const notVanilla = (v) => v !== undefined && !/^(none|vanilla|false|no|off|0|original)$/i.test(String(v));

/** What Hutch's tracker should be told about this seed. */
export function trackerFor(m) {
  const yes = (b) => (b ? 'yes' : 'no');
  const ks = pick(m, 'keyshuffle', 'keysanity');
  const keys = on(ks) || /universal/i.test(String(ks));
  const bks = on(pick(m, 'bigkeyshuffle'));
  const maps = on(pick(m, 'mapshuffle')), comps = on(pick(m, 'compassshuffle'));
  const flags = (maps ? 'm' : '') + (comps ? 'c' : '') + (bks ? 'b' : '') + (keys ? 'k' : '');
  const di = bks && keys ? 'keysanity' : keys ? 'mapcompasskeys' : (maps || comps) ? 'mapcompass' : 'standard';
  const mode = String(pick(m, 'mode') || 'open').toLowerCase();
  const pottery = String(pick(m, 'pottery') || 'none').toLowerCase();
  const drops = String(pick(m, 'dropshuffle', 'keydropshuffle') || 'none').toLowerCase();
  const gt = String(pick(m, 'gt_crystals', 'crystals_gt', 'entry_crystals_tower') ?? '7');
  return {
    gamemode: ['open', 'standard', 'inverted', 'retro'].includes(mode) ? mode : 'open',
    dungeonitems: di,
    swordless: yes(/swordless/i.test(String(pick(m, 'weapons') || ''))),
    gtcrystals: /^\d$/.test(gt) ? gt : '7',
    bossshuffle: yes(notVanilla(pick(m, 'boss_shuffle', 'shufflebosses'))),
    enemizer: yes(notVanilla(pick(m, 'enemy_shuffle', 'shuffleenemies'))),
    more: {
      dungeonshuffle: flags,
      universalkeys: yes(/universal/i.test(String(ks))),
      entranceshuffle: yes(notVanilla(pick(m, 'shuffle', 'entrance_shuffle'))),
      shopsanity: yes(on(pick(m, 'shopsanity'))),
      pottery: pottery === 'none' ? 'none' : pottery.replace(/_/g, ''),
      enemykeydrop: yes(notVanilla(drops) || on(pick(m, 'keydropshuffle'))),
      enemydrops: yes(drops === 'underworld'),
      pseudoboots: yes(on(pick(m, 'pseudoboots'))),
      mirrorscroll: yes(on(pick(m, 'mirrorscroll'))),
    },
  };
}

/** Parts of the seed the tracker can't follow (shown as a note). */
export function trackerGaps(m) {
  const out = [];
  if (notVanilla(pick(m, 'door_shuffle'))) out.push('door shuffle');
  if (notVanilla(pick(m, 'ow_shuffle', 'overworld_shuffle')) || on(pick(m, 'ow_swap', 'ow_mixed'))) out.push('overworld shuffle');
  return out;
}

/** The race flag as AVIANART reports it. */
export function isRace(m) {
  const v = m.race;
  return v !== undefined && v !== false && v !== 0 && v !== 'No' && v !== 'no';
}
