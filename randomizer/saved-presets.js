// Saved presets (the Randomizer bar's first field): one list for every
// generator. A preset knows its generator (alttpr.com, Kara's branch or
// AVIANART) and that generator's settings, so picking one switches to the
// right site and sets everything up; Generate & Play rolls it.
//
// Built-in presets come first and can't be deleted. The player's own are kept
// in this browser, in the store the Customizer's presets always used (an entry
// with no `gen` is an alttpr.com one), and can be exported and imported.

const LS_PRESETS = 'unified-custom-presets';
const LS_CURRENT = 'unified-custom-preset';
const BUILTIN_PREFIX = 'builtin:';

export const BUILTIN = [
  {
    id: 'onlyadkdf', name: 'OnlyADKDF', gen: 'avianart',
    avian: { preset: 'jem041/onlyadkdf', race: false }, onlyadkd: true,
    note: 'AVIANART preset jem041/onlyadkdf: open, crossed entrances, pot and enemy key drops, random weapons, 7/6 crystals. Turns on the tracker\'s OnlyADKD mode.',
  },
];

export const GEN_LABEL = { alttpr: 'alttpr.com', kara: 'Kara', avianart: 'AVIANART' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

export const genOf = (p) => (p && p.gen) || 'alttpr';
/** The player's own presets: { name: preset }. */
export function own() { const p = lsGet(LS_PRESETS, {}); return p && typeof p === 'object' ? p : {}; }
function putAll(all) { return lsSet(LS_PRESETS, all); }
export const current = () => lsGet(LS_CURRENT, '');
function setCurrent(v) { lsSet(LS_CURRENT, v || ''); paint(); }
/** A setting was changed by hand: the bar no longer matches the preset exactly. */
export function edited() { if (current()) setCurrent(''); }

const usable = (p) => p && typeof p === 'object' && (p.gen || p.custom);

let hooks = null;   // { switchGen(gen), handlers: { gen: { snapshot, apply } }, status(msg, kind), fromSiteSave(json) }

export function paint() {
  const sel = $('r-saved');
  if (!sel) return;
  const cur = current();
  const mine = Object.keys(own()).filter((n) => usable(own()[n])).sort((a, b) => a.localeCompare(b));
  const all = own();
  sel.innerHTML = '<option value="">Choose a preset…</option>'
    + '<optgroup label="Built-in">'
    + BUILTIN.map((b) => `<option value="${BUILTIN_PREFIX}${esc(b.id)}" title="${esc(b.note || '')}">${esc(b.name)} · ${GEN_LABEL[b.gen]}</option>`).join('')
    + '</optgroup>'
    + (mine.length
      ? '<optgroup label="Your presets">' + mine.map((n) => `<option value="${esc(n)}">${esc(n)} · ${GEN_LABEL[genOf(all[n])] || 'alttpr.com'}</option>`).join('') + '</optgroup>'
      : '<optgroup label="Your presets"><option value="" disabled>None yet: set things up, then Save</option></optgroup>');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  const isOwn = !!sel.value && !sel.value.startsWith(BUILTIN_PREFIX);
  $('r-saved-del').disabled = !isOwn;
  const b = BUILTIN.find((x) => BUILTIN_PREFIX + x.id === sel.value);
  sel.title = b ? b.note : 'Presets: each one sets the generator (alttpr.com, Kara\'s branch or AVIANART) and its settings';
}

function lookup(value) {
  if (!value) return null;
  if (value.startsWith(BUILTIN_PREFIX)) {
    const b = BUILTIN.find((x) => BUILTIN_PREFIX + x.id === value);
    return b ? { name: b.name, p: b } : null;
  }
  const p = own()[value];
  return usable(p) ? { name: value, p } : null;
}

/** Switch to a preset's generator and put its settings in the bar. */
export async function apply(value, { quiet = false } = {}) {
  const hit = lookup(value);
  if (!hit) return false;
  const { name, p } = hit;
  const gen = genOf(p);
  hooks.switchGen(gen);
  const h = hooks.handlers[gen];
  if (h) await h.apply(p);
  if (typeof p.onlyadkd === 'boolean' && window.UnifiedOnlyAdkd && window.UnifiedOnlyAdkd.on() !== p.onlyadkd) {
    window.UnifiedOnlyAdkd.set(p.onlyadkd);
  }
  setCurrent(value);
  if (!quiet) hooks.status(`Preset "${name}" (${GEN_LABEL[gen]}) is set. Press Generate & Play to roll a seed with it.`, 'ok');
  return true;
}

async function save() {
  const gen = hooks.gen();
  const cur = current();
  const suggest = cur && !cur.startsWith(BUILTIN_PREFIX) ? cur : '';
  let name = window.prompt(`Save the current ${GEN_LABEL[gen]} settings as a preset. Name:`, suggest);
  if (name == null) return;
  name = name.trim().slice(0, 60);
  if (!name) { hooks.status('A preset needs a name.', 'bad'); return; }
  const all = own();
  const over = name in all;
  if (over && name !== suggest && !window.confirm(`Replace your preset "${name}"?`)) return;
  const h = hooks.handlers[gen];
  const snap = h ? await h.snapshot() : {};
  const entry = { v: 1, gen, savedAt: new Date().toISOString(), ...snap };
  if (window.UnifiedOnlyAdkd) entry.onlyadkd = !!window.UnifiedOnlyAdkd.on();
  all[name] = entry;
  if (!putAll(all)) { hooks.status('Couldn\'t save the preset: this browser\'s storage is full or blocked.', 'bad'); return; }
  setCurrent(name);
  hooks.status(`${over ? 'Updated' : 'Saved'} preset "${name}" (${GEN_LABEL[gen]}).`, 'ok');
}

function del() {
  const name = $('r-saved').value;
  if (!name || name.startsWith(BUILTIN_PREFIX)) return;
  if (!window.confirm(`Delete the preset "${name}"?`)) return;
  const all = own();
  delete all[name];
  putAll(all);
  setCurrent('');
  hooks.status(`Deleted preset "${name}".`, 'ok');
}

function downloadJson(obj, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportPresets() {
  const name = $('r-saved').value;
  const all = own();
  if (name && all[name]) {
    downloadJson({ alttprUnifiedPresets: 1, presets: { [name]: all[name] } }, `${name.replace(/[^\w\- ]+/g, '_')}-preset.json`);
  } else if (Object.keys(all).length) {
    downloadJson({ alttprUnifiedPresets: 1, presets: all }, 'alttpr-presets.json');
  } else {
    hooks.status('No presets of your own to export yet.', 'bad');
  }
}

async function importFile(file) {
  let json;
  try { json = JSON.parse(await file.text()); } catch (e) { hooks.status('That file isn\'t a presets file.', 'bad'); return; }
  const base = file.name.replace(/(-settings|-preset)?\.json$/i, '') || 'Imported';
  const all = own();
  if (json && json.alttprUnifiedPresets && json.presets && typeof json.presets === 'object') {
    const names = Object.keys(json.presets).filter((n) => usable(json.presets[n]));
    names.forEach((n) => { all[n] = json.presets[n]; });
    putAll(all);
    if (names.length === 1) await apply(names[0], { quiet: true });
    else paint();
    hooks.status(names.length ? `Imported ${names.length} preset${names.length === 1 ? '' : 's'}${names.length === 1 ? ` ("${names[0]}") and switched to it` : ''}.` : 'No presets in that file.', names.length ? 'ok' : 'bad');
    return;
  }
  // a Save file from alttpr.com's Customizer
  const fromSite = hooks.fromSiteSave ? await hooks.fromSiteSave(json) : null;
  if (fromSite) {
    let name = base, i = 2;
    while (all[name]) name = `${base} (${i++})`;
    all[name] = { v: 1, gen: 'alttpr', savedAt: new Date().toISOString(), useCustomizer: true, fields: fromSite.fields, custom: fromSite.custom };
    putAll(all);
    await apply(name, { quiet: true });
    hooks.status(`Imported alttpr.com customizer settings as the preset "${name}".`, 'ok');
    return;
  }
  hooks.status('That file isn\'t a presets file or an alttpr.com customizer save.', 'bad');
}

/** Wire up the Saved presets field. */
export function init(h) {
  hooks = h;
  $('r-saved').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (!v) { setCurrent(''); return; }
    await apply(v);
  });
  $('r-saved-save').addEventListener('click', save);
  $('r-saved-del').addEventListener('click', del);
  $('r-saved-export').addEventListener('click', exportPresets);
  $('r-saved-import').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await importFile(f);
  });
  paint();
}
