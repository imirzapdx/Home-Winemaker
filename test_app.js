/* Headless harness: run the app's script block in a VM with DOM stubs, then
   exercise the protocol engine, secondary derivation, compatibility checks,
   the shopping list, and every render path. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// The app declares everything with let/const, which stay in the script's
// lexical scope inside a VM. build_harness.py appends an export epilogue.
const src = fs.readFileSync(path.join(__dirname, 'app_exported.js'), 'utf8');

function makeEl() {
  const el = {
    innerHTML: '', value: '', checked: false, id: '', dataset: {}, style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    focus(){}, click(){}, setSelectionRange(){}, appendChild(){}, removeChild(){},
    querySelector(){ return null }, querySelectorAll(){ return [] },
    addEventListener(){}, selectionStart: null,
  };
  return el;
}
const content = makeEl(); content.id = 'content';
// Form fields the app reads back with getElementById — tests fill these in.
const FIELDS = {};
const withFields = (vals, fn) => {
  Object.keys(FIELDS).forEach(k => delete FIELDS[k]);
  Object.assign(FIELDS, vals);
  try { return fn(); } finally { Object.keys(FIELDS).forEach(k => delete FIELDS[k]); }
};
const store = {};
const sandbox = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  document: {
    activeElement: null,
    getElementById: id => {
      if (id === 'content') return content;
      const el = makeEl();
      if (Object.prototype.hasOwnProperty.call(FIELDS, id)) el.value = FIELDS[id];
      return el;
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
  },
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  Blob: function () {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  setTimeout, clearTimeout, JSON, Math, Date, Object, Array, String, Number,
  Boolean, Map, Set, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app.js' });
const A = sandbox.__app;

/* ── mini test runner ── */
let pass = 0, fail = 0; const failures = [];
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name + ' — ' + e.message); }
};
const eq = (a, b, m) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((m ? m + ': ' : '') + `got ${sa}, want ${sb}`);
};
const near = (a, b, tol, m) => {
  if (Math.abs(a - b) > (tol == null ? 0.01 : tol))
    throw new Error((m ? m + ': ' : '') + `got ${a}, want ~${b}`);
};
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const S = () => A.S;
A.S.ui = A.S.ui || {};

// Snapshot the shipped cellar so tests that load a legacy profile don't
// contaminate everything that runs after them.
const PRISTINE = JSON.stringify({
  equipment: A.S.equipment, grapes: A.S.grapes, wines: A.S.wines,
  customYeasts: A.S.customYeasts, svEquipment: A.S.svEquipment,
});
const reset = () => {
  A.S.customProducts = {}; A.S.ui.calc = {};
  const p = JSON.parse(PRISTINE);
  A.S.equipment = p.equipment; A.S.grapes = p.grapes; A.S.wines = p.wines;
  A.S.customYeasts = p.customYeasts; A.S.svEquipment = p.svEquipment;
  A.S.protocols = []; A.S.protocolEdits = {}; A.S.purchased = {};
  A.S.tracking = {}; A.S.yeastEdits = {};
  A.S.ui.protocolId = null; A.S.ui.trackKey = null; A.S.ui.wineId = 'w1';
  A.S.ui.shopOptional = false; A.S.ui.shopMargin = 10;
  A.migrateState();
};
reset();

/* ══════════════════════════════════════════════════════════
   Baseline — the app still works
   ══════════════════════════════════════════════════════════ */
t('app boots with default state', () => { ok(S().wines.length === 2); ok(S().grapes.length === 3); });
t('migrateState is idempotent', () => { A.migrateState(); A.migrateState(); eq(S().protocols, []); });
t('every tab renders without throwing', () => {
  ['wines', 'grapes', 'protocols', 'tracking', 'calculators', 'supplies', 'flowchart'].forEach(tab => {
    A.S.ui.tab = tab;
    const html = A.renderTab();
    ok(typeof html === 'string' && html.length > 50, tab + ' produced no markup');
  });
  A.S.ui.tab = 'wines';
});
t('flowchart SVG still builds', () => ok(A.buildSVG().indexOf('<svg') === 0 || A.buildSVG().includes('<svg')));
t('calcWine works for single and blend', () => {
  ok(A.calcWine(S().wines[0]).isBlend);
  ok(A.calcWine(S().wines[1]).isSingle);
});

/* ══════════════════════════════════════════════════════════
   FEATURE 1 — Protocol library
   ══════════════════════════════════════════════════════════ */
t('11 presets ship', () => eq(A.PROTOCOL_PRESETS.length, 11));
t('library returns builtins', () => eq(A.protocolLibrary().length, 11));
t('every preset is structurally complete', () => A.PROTOCOL_PRESETS.forEach(p => {
  ok(p.id && p.name && p.color && p.desc, p.id + ': missing header fields');
  ok(p.ferment && p.mlf && p.post, p.id + ': missing method blocks');
  ok(Array.isArray(p.additions) && p.additions.length, p.id + ': no additions');
  ok(Array.isArray(p.steps) && p.steps.length, p.id + ': no steps');
}));
t('every addition names a catalogued product', () => A.PROTOCOL_PRESETS.forEach(p =>
  p.additions.forEach(a => ok(A.CHEM_CATALOG[a.product], `${p.id}: unknown product "${a.product}"`))));
t('every addition uses a valid stage and basis', () => A.PROTOCOL_PRESETS.forEach(p =>
  p.additions.forEach(a => {
    ok(A.PROTO_STAGE_LABEL[a.stage], `${p.id}/${a.product}: bad stage ${a.stage}`);
    ok(A.PROTO_BASIS[a.basis], `${p.id}/${a.product}: bad basis ${a.basis}`);
    ok(typeof a.rate === 'number' && a.rate >= 0, `${p.id}/${a.product}: bad rate`);
  })));
t('preset ids are unique', () => {
  const ids = A.PROTOCOL_PRESETS.map(p => p.id);
  eq(ids.length, new Set(ids).size);
});
t('the two PDF checklists are reproduced faithfully', () => {
  const red = A.getProtocol('red-classic-ml');
  const so2 = red.additions.find(a => a.stage === 'crush' && a.product === 'Potassium Metabisulfite (KMS)');
  eq(so2.rate, 0.33, 'red crush SO2');                        // 1.6 g / 5 gal
  eq(red.additions.find(a => a.product === 'Lallzyme EX').rate, 0.10);
  eq(red.additions.find(a => a.product === 'Opti-Red').rate, 1.00);
  const ft = red.additions.find(a => a.product === 'FT Rouge');
  eq(ft.rate, 1.30); eq(ft.min, 0.8); eq(ft.max, 1.9);
  const white = A.getProtocol('white-aromatic-noml');
  eq(white.additions.find(a => a.product === 'Opti-White').rate, 1.00);
  const ftb = white.additions.find(a => a.product === 'FT Blanc Soft');
  eq(ftb.rate, 0.50); eq(ftb.min, 0.2); eq(ftb.max, 0.6);
});
t("Ken's oak note is carried as an optional addition", () => {
  const oak = A.getProtocol('red-classic-ml').additions.find(a => /Oak chips/.test(a.product));
  eq(oak.rate, 7.0); eq(oak.optional, true); eq(oak.stage, 'crush');
  ok(/American, untoasted/.test(oak.product), 'first choice should be American untoasted');
});
t('enzyme always precedes tannin by a stage', () => A.PROTOCOL_PRESETS.forEach(p => {
  const order = A.PROTO_STAGES.map(s => s[0]);
  p.additions.filter(a => /zyme/i.test(a.product)).forEach(e =>
    p.additions.filter(a => (A.CHEM_CATALOG[a.product] || {}).cat === 'Tannin').forEach(tn =>
      ok(order.indexOf(tn.stage) > order.indexOf(e.stage), `${p.id}: tannin not after enzyme`)));
}));

t('edit layer overrides and reset restores', () => {
  reset();
  const p = A.protoEditable('red-classic-ml');
  p.name = 'House Red';
  eq(A.getProtocol('red-classic-ml').name, 'House Red');
  ok(A.getProtocol('red-classic-ml').edited);
  eq(A.PROTOCOL_PRESETS.find(x => x.id === 'red-classic-ml').name, 'Red — Classic, consecutive MLF', 'builtin mutated');
  A.resetProtocolEdit('red-classic-ml');
  eq(A.getProtocol('red-classic-ml').name, 'Red — Classic, consecutive MLF');
});
t('setProtoField writes nested paths', () => {
  reset();
  A.setProtoField('red-classic-ml', 'mlf.mode', 'none');
  eq(A.getProtocol('red-classic-ml').mlf.mode, 'none');
  eq(A.getProtocol('red-classic-ml').mlf.culture, null, 'culture should clear with mode none');
  A.resetProtocolEdit('red-classic-ml');
});
t('duplicate makes an independent custom copy', () => {
  reset();
  A.dupProtocol('red-native');
  const copy = S().protocols[0];
  ok(/copy/.test(copy.name)); eq(copy.builtin, false);
  copy.additions[0].rate = 9.9;
  eq(A.getProtocol('red-native').additions[0].rate, 0.13, 'source mutated by copy');
  reset();
});
t('new + delete protocol round-trips', () => {
  reset();
  A.newProtocol();
  const id = S().protocols[0].id;
  S().grapes[0].protocolId = id;
  eq(A.grapeProtocolId(S().grapes[0]), id);
  A.delProtocol(id);
  eq(S().protocols.length, 0);
  eq(S().grapes[0].protocolId, null, 'grape should fall back');
  eq(A.grapeProtocolId(S().grapes[0]), 'red-classic-ml');
  reset();
});
t('grapes default by color', () => {
  reset();
  eq(A.grapeProtocolId(S().grapes.find(g => g.type === 'red')), 'red-classic-ml');
  eq(A.grapeProtocolId(S().grapes.find(g => g.type === 'white')), 'white-aromatic-noml');
  eq(A.roseProtocolIdFor(S().grapes[0].id), 'rose-saignee');
});
t('addition rows can be added, edited and removed', () => {
  reset();
  const before = A.getProtocol('red-native').additions.length;
  A.addProtoAddition('red-native');
  eq(A.getProtocol('red-native').additions.length, before + 1);
  A.setProtoAdd('red-native', before, 'rate', '2.5');
  eq(A.getProtocol('red-native').additions[before].rate, 2.5);
  A.setProtoAdd('red-native', before, 'rate', '-4');
  eq(A.getProtocol('red-native').additions[before].rate, 0, 'negative rate should clamp');
  A.delProtoAddition('red-native', before);
  eq(A.getProtocol('red-native').additions.length, before);
  reset();
});
t('steps can be added, edited and removed', () => {
  reset();
  const n = A.getProtocol('red-native').steps.length;
  A.addProtoStep('red-native');
  A.setProtoStep('red-native', n, 'Wait.');
  eq(A.getProtocol('red-native').steps[n], 'Wait.');
  A.delProtoStep('red-native', n);
  eq(A.getProtocol('red-native').steps.length, n);
  reset();
});

/* ══════════════════════════════════════════════════════════
   FEATURE 2 — Secondary is optional
   ══════════════════════════════════════════════════════════ */
t('consecutive MLF requires a secondary', () =>
  eq(A.needsSecondary(A.getProtocol('red-classic-ml')).required, true));
t('co-inoculated MLF does not', () =>
  eq(A.needsSecondary(A.getProtocol('red-coinoc-ml')).required, false));
t('no MLF does not', () =>
  eq(A.needsSecondary(A.getProtocol('white-aromatic-noml')).required, false));
t('rosé does not', () => {
  eq(A.needsSecondary(A.getProtocol('rose-saignee')).required, false);
  eq(A.needsSecondary(A.getProtocol('rose-direct-press')).required, false);
});
t('barrel-fermented white with full MLF does', () =>
  eq(A.needsSecondary(A.getProtocol('white-barrel-ml')).required, true));
t('missing protocol keeps the secondary', () => eq(A.needsSecondary(null).required, true));
t('every derivation carries a reason', () => A.PROTOCOL_PRESETS.forEach(p =>
  ok(A.needsSecondary(p).reason && A.needsSecondary(p).reason.length > 10, p.id)));
t('protocol-level override forces on and off', () => {
  reset();
  A.setProtoSecondary('rose-saignee', 'on');
  eq(A.needsSecondary(A.getProtocol('rose-saignee')).required, true);
  A.setProtoSecondary('red-classic-ml', 'off');
  eq(A.needsSecondary(A.getProtocol('red-classic-ml')).required, false);
  A.setProtoSecondary('rose-saignee', 'auto');
  eq(A.needsSecondary(A.getProtocol('rose-saignee')).required, false);
  reset();
});
t('blend split stage follows MLF timing', () => {
  reset();
  const g = S().grapes[0];
  g.protocolId = 'red-classic-ml';
  eq(A.blendSplitStage(g.id).stage, 'secondary');
  g.protocolId = 'red-coinoc-ml';
  eq(A.blendSplitStage(g.id).stage, 'primary');
  reset();
});

t('chainFor drops the racking loss when there is no secondary', () => {
  reset();
  const g = S().grapes[0];
  g.protocolId = 'red-classic-ml';
  eq(A.chainFor(g.id).sToA, A.LOSS.sToA);
  g.protocolId = 'red-coinoc-ml';
  eq(A.chainFor(g.id).sToA, 1);
  reset();
});
t('stageVolumes skips the racking loss when asked', () => {
  const withSec = A.stageVolumes(100, true), without = A.stageVolumes(100, false);
  near(withSec.aging, 100 * 0.85 * 0.95);
  near(without.aging, 100 * 0.85);
  near(without.primary, 100);
  near(without.secondary, 85, 0.01, 'post-press volume is the same either way');
  ok(without.aging > withSec.aging, 'skipping a racking should not lose more wine');
});
t('a no-secondary single wine needs less fruit for the same aging volume', () => {
  reset();
  const w = S().wines[1];               // Chardonnay Reserve, single, white
  const g = A.grapeById(w.grapeId);
  g.protocolId = 'white-barrel-ml';     // consecutive MLF → secondary
  const withSec = A.calcWine(w).grapsNeeded;
  g.protocolId = 'white-aromatic-noml'; // no MLF → no secondary
  const without = A.calcWine(w).grapsNeeded;
  ok(without < withSec, `expected less fruit without a secondary (${without} vs ${withSec})`);
  near(without / withSec, A.LOSS.sToA, 0.001, 'the difference should be exactly one racking');
  reset();
});
t('calc results expose hasSecondary', () => {
  reset();
  const w = S().wines[1];
  A.grapeById(w.grapeId).protocolId = 'white-aromatic-noml';
  eq(A.calcWine(w).hasSecondary, false);
  A.grapeById(w.grapeId).protocolId = 'white-barrel-ml';
  eq(A.calcWine(w).hasSecondary, true);
  reset();
});
t('blend components carry their own secondary flag', () => {
  reset();
  const w = S().wines[0];
  A.grapeById(w.components[0].grapeId).protocolId = 'red-coinoc-ml';
  A.grapeById(w.components[1].grapeId).protocolId = 'red-classic-ml';
  const c = A.calcWine(w).components;
  eq(c[0].hasSecondary, false);
  eq(c[1].hasSecondary, true);
  reset();
});
t('mixed-protocol blend still allocates without overcommitting', () => {
  reset();
  const w = S().wines[0];
  A.grapeById(w.components[0].grapeId).protocolId = 'red-coinoc-ml';
  const map = A.calcGrapeAllocations();
  map.forEach((e, id) => {
    ok(e.usedLbs <= e.totalLbs + 0.01, 'grape ' + id + ' overallocated');
    ok(e.remainingLbs >= -0.01);
  });
  reset();
});
t('tracking stages drop the secondary for a co-inoculated batch', () => {
  reset();
  const lines = A.getTrackingLines();
  const line = lines.find(l => !l.isRose);
  A.grapeById(line.grapeId).protocolId = 'red-coinoc-ml';
  const rec = A.trackingRec(line.key);
  eq(A.trackStages(rec, line.key).indexOf('secondary'), -1);
  ok(A.trackStages(rec, line.key)[0] === 'primary');
  reset();
});
t('tracking stages keep the secondary for a consecutive batch', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose);
  A.grapeById(line.grapeId).protocolId = 'red-classic-ml';
  const rec = A.trackingRec(line.key);
  const st = A.trackStages(rec, line.key);
  ok(st.includes('secondary'));
  ok(st.includes('ml'), 'consecutive MLF should get its own ML stage');
});
t('ML settings follow the protocol until manually overridden', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose);
  A.grapeById(line.grapeId).protocolId = 'white-aromatic-noml';
  eq(A.trackingRec(line.key).ml.enabled, false);
  A.grapeById(line.grapeId).protocolId = 'red-coinoc-ml';
  eq(A.trackingRec(line.key).ml.enabled, true);
  eq(A.trackingRec(line.key).ml.timing, 'simultaneous');
  A.setTrackML(line.key, false);
  eq(A.trackingRec(line.key).mlManual, true);
  A.grapeById(line.grapeId).protocolId = 'red-classic-ml';
  eq(A.trackingRec(line.key).ml.enabled, false, 'manual override should stick');
  A.resetTrackML(line.key);
  eq(A.trackingRec(line.key).ml.enabled, true, 'reset should hand control back');
  reset();
});
t('advancing through a no-secondary batch goes primary → aging', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose);
  A.grapeById(line.grapeId).protocolId = 'red-coinoc-ml';
  A.startTracking(line.key);
  const rec = A.trackingRec(line.key);
  eq(rec.stage, 'primary');
  A.advanceStage(line.key);
  eq(rec.stage, 'aging');
  A.undoStage(line.key);
  eq(rec.stage, 'primary');
  reset();
});
t('keyGrape parses both key shapes', () => {
  eq(A.keyGrape('g1::mj-vr21'), { grapeId: 'g1', isRose: false });
  eq(A.keyGrape('g1::rose::71b'), { grapeId: 'g1', isRose: true });
});
t('blend records always keep a secondary', () => eq(A.recNeedsSecondary({ ml: {} }, 'blend::w1'), true));

/* ══════════════════════════════════════════════════════════
   FEATURE 3 — Compatibility
   ══════════════════════════════════════════════════════════ */
const codes = iss => iss.map(i => i.code);
t('no preset ships with a conflict', () => A.PROTOCOL_PRESETS.forEach(p => {
  const errs = A.checkProtocol(p, {}).filter(i => i.level === 'error');
  ok(!errs.length, `${p.id} ships with: ${errs.map(e => e.code).join(', ')}`);
}));
t('every issue carries a message and a fix', () => {
  const p = JSON.parse(JSON.stringify(A.getProtocol('red-classic-ml')));
  p.additions.push({ stage: 'aging', product: 'Lysozyme', rate: 1, basis: 'gal_wine' });
  A.checkProtocol(p, {}).forEach(i => {
    ok(i.msg && i.msg.length > 15, i.code + ': thin message');
    ok(i.fix && i.fix.length > 10, i.code + ': no fix offered');
    ok(['error', 'warn', 'info'].includes(i.level));
  });
});
const mutate = (id, fn) => { const p = JSON.parse(JSON.stringify(A.getProtocol(id))); fn(p); return p; };

t('native ferment flags heavy crush SO2', () =>
  ok(codes(A.checkProtocol(mutate('red-native', p => { p.additions[0].rate = 0.33; p.additions[0].optional = false; }), {})).includes('SO2_NATIVE')));
t('bioprotection plus SO2 is a hard conflict', () =>
  ok(codes(A.checkProtocol(mutate('red-biodiva', p => p.additions.unshift({ stage: 'crush', product: 'Potassium Metabisulfite (KMS)', rate: 0.33, basis: 'gal_must' })), {})).includes('SO2_BIOPROTECT')));
t('co-inoculation flags high crush SO2', () =>
  ok(codes(A.checkProtocol(mutate('red-coinoc-ml', p => { p.additions[0].rate = 0.33; }), {})).includes('SO2_COINOC')));
t('bioprotection with no Sacch to follow is a hard conflict', () =>
  ok(codes(A.checkProtocol(mutate('red-biodiva', p => { p.ferment.yeastStrategy = 'native'; }), {})).includes('BIOPROTECT_NO_SACCH')));
t('Biodiva plus co-inoculated ML is flagged', () =>
  ok(codes(A.checkProtocol(mutate('red-biodiva', p => { p.mlf.mode = 'simultaneous'; }), {})).includes('BIODIVA_COINOC')));
t('killer yeast destroys the bioprotection strain', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-biodiva'), { yeast: { name: 'EC-1118' }, traits: A.yeastTraits('ec1118') })).includes('KILLER_VS_BIOPROTECT')));
t('killer yeast undermines a native ferment', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-native'), { yeast: { name: 'K1-V1116' }, traits: A.yeastTraits('k1v1116') })).includes('KILLER_VS_NATIVE')));
t('lysozyme blocks MLF', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => p.additions.push({ stage: 'aging', product: 'Lysozyme', rate: 1, basis: 'gal_wine' })), {})).includes('LYSOZYME_MLF')));
t('sorbate plus MLF is a hard conflict', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => p.additions.push({ stage: 'prebottle', product: 'Potassium Sorbate', rate: 0.75, basis: 'gal_wine' })), {})).includes('SORBATE_MLF')));
t('enzyme and tannin in the same stage is a hard conflict', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => { p.additions.find(a => a.product === 'FT Rouge').stage = 'crush'; }), {})).includes('ENZYME_TANNIN_STAGE')));
t('bentonite alongside an enzyme is flagged', () =>
  ok(codes(A.checkProtocol(mutate('white-barrel-ml', p => { p.additions.push({ stage: 'crush', product: 'Bentonite', rate: 2, basis: 'gal_wine' }); p.additions.find(a => /Cuvée/.test(a.product)).optional = false; }), {})).includes('BENTONITE_ENZYME')));
t('cold stabilizing a pending MLF is flagged', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => { p.post.coldStabilize = true; }), {})).includes('COLDSTAB_MLF')));
t('low pH warns for MLF', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-classic-ml'), { pH: 3.0 })).includes('MLF_LOW_PH')));
t('high potential alcohol warns for MLF', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-classic-ml'), { potentialAlc: 16.2 })).includes('MLF_HIGH_ALC')));
t('yeast alcohol tolerance is a hard conflict', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-classic-ml'), { yeast: { name: '71B', alc: 14 }, traits: A.yeastTraits('71b'), potentialAlc: 15.5 })).includes('YEAST_ALC')));
t('SO2-producing yeast warns on co-inoculation', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-coinoc-ml'), { yeast: { name: 'EC-1118' }, traits: A.yeastTraits('ec1118') })).includes('YEAST_SO2_MLF')));
t('71B is flagged as a malic consumer when MLF is planned', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-classic-ml'), { yeast: { name: '71B' }, traits: A.yeastTraits('71b') })).includes('YEAST_EATS_MALIC')));
t('a red with no MLF is flagged for bottle refermentation', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => { p.mlf.mode = 'none'; }), {})).includes('RED_NO_MLF')));
t('missing nutrient is flagged', () =>
  ok(codes(A.checkProtocol(mutate('red-classic-ml', p => { p.additions = p.additions.filter(a => !/Fermaid/.test(a.product)); }), {})).includes('NO_NUTRIENT')));
t('DAP on a native ferment is flagged', () =>
  ok(codes(A.checkProtocol(mutate('red-native', p => p.additions.push({ stage: 'ferment', product: 'DAP', rate: 1, basis: 'gal_must' })), {})).includes('NATIVE_DAP')));
t('DAP on a co-inoculated ferment is flagged', () =>
  ok(codes(A.checkProtocol(mutate('red-coinoc-ml', p => p.additions.push({ stage: 'ferment', product: 'DAP', rate: 1, basis: 'gal_must' })), {})).includes('COINOC_DAP')));
t('rosé with MLF is flagged', () =>
  ok(codes(A.checkProtocol(mutate('rose-saignee', p => { p.mlf = { mode: 'consecutive', culture: 'VP41', nutrient: 'ML nutrient (Opti-Malo)' }; }), {})).includes('ROSE_MLF')));
t('filtering without cold stabilizing is flagged', () =>
  ok(codes(A.checkProtocol(mutate('white-aromatic-noml', p => { p.post.coldStabilize = false; }), {})).includes('FILTER_NO_COLDSTAB')));
t('a cultured yeast on a native protocol is noted', () =>
  ok(codes(A.checkProtocol(A.getProtocol('red-native'), { yeast: { name: 'RC-212' }, traits: A.yeastTraits('rc212') })).includes('NATIVE_HAS_YEAST')));
t('worstLevel ranks error over warn over info', () => {
  eq(A.worstLevel([{ level: 'info' }, { level: 'error' }, { level: 'warn' }]), 'error');
  eq(A.worstLevel([{ level: 'info' }, { level: 'warn' }]), 'warn');
  eq(A.worstLevel([{ level: 'info' }]), 'info');
  eq(A.worstLevel([]), 'ok');
});
t('checkLine builds context from the grape and yeast', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose && l.yeastId);
  ok(Array.isArray(A.checkLine(line)));
  const ctx = A.protoCtxForLine(line);
  ok(ctx.potentialAlc > 10 && ctx.potentialAlc < 20, 'potential alcohol from target Brix');
  ok(ctx.traits && typeof ctx.traits.killer === 'boolean');
});
t('wineProtocolIssues covers every component and rosé bleed', () => {
  reset();
  A.grapeById('g1').protocolId = 'red-biodiva';
  A.grapeById('g1').roseProtocolId = 'rose-saignee';
  S().wines[0].components[0].yeastId = 'ec1118';   // killer, versus Biodiva
  const groups = A.wineProtocolIssues(S().wines[0]);
  const all = [].concat(...groups.map(g => g.issues));
  ok(codes(all).includes('KILLER_VS_BIOPROTECT'), 'killer-vs-Biodiva not surfaced on the wine');
  S().wines[0].components[0].yeastId = 'mj-vr21';
  reset();
});

/* ══════════════════════════════════════════════════════════
   FEATURE 4 — Shopping list
   ══════════════════════════════════════════════════════════ */
t('protocol chemicals scale with must volume', () => {
  reset();
  const lines = A.getTrackingLines();
  const totalMust = lines.reduce((s, l) => s + l.mustGal, 0);
  const rows = A.calcProtocolChemicals();
  const so2 = rows.find(r => r.product === 'Potassium Metabisulfite (KMS)');
  ok(so2 && so2.total > 0, 'no SO2 row');
  // every red line contributes 0.33 g/gal at crush alone
  ok(so2.total > totalMust * 0.2, 'SO2 total looks too small');
});
t('doubling the fruit doubles the chemical need', () => {
  reset();
  const before = A.calcProtocolChemicals().find(r => r.product === 'Opti-Red').total;
  S().grapes.forEach(g => { g.pounds *= 2; });
  S().wines.forEach(w => { if (w.agingVolumeGal) w.agingVolumeGal *= 2; });
  const after = A.calcProtocolChemicals().find(r => r.product === 'Opti-Red').total;
  S().grapes.forEach(g => { g.pounds /= 2; });
  S().wines.forEach(w => { if (w.agingVolumeGal) w.agingVolumeGal /= 2; });
  near(after / before, 2, 0.05);
  reset();
});
t('optional additions are excluded by default and included on request', () => {
  reset();
  ok(!A.calcProtocolChemicals().find(r => /Oak chips/.test(r.product)));
  ok(A.calcProtocolChemicals({ includeOptional: true }).find(r => /Oak chips/.test(r.product)));
});
t('safety margin is applied to the buy quantity', () => {
  reset();
  const r = A.calcProtocolChemicals({ margin: 0.5 }).find(x => x.product === 'Opti-Red');
  near(r.buy, r.total * 1.5, 0.02);
  const z = A.calcProtocolChemicals({ margin: 0 }).find(x => x.product === 'Opti-Red');
  near(z.buy, z.total, 0.01);
});
t('pack suggestion picks the smallest that fits, or multiples', () => {
  eq(A.suggestPack('Lallzyme EX', 8), '1 × 10 g');
  eq(A.suggestPack('Lallzyme EX', 40), '1 × 100 g');
  eq(A.suggestPack('Lallzyme EX', 250), '3 × 100 g');
  eq(A.suggestPack('Nonexistent Product', 5), '');
});
t('ML cultures and bioprotection strains appear as biologicals', () => {
  reset();
  A.grapeById('g1').protocolId = 'red-biodiva';
  const bio = A.calcProtocolBiologicals();
  ok(bio.find(b => b.product === 'Biodiva' && b.cat === 'Bioprotection'), 'no Biodiva row');
  ok(bio.find(b => b.product === 'VP41' && b.cat === 'ML Culture'), 'no ML culture row');
  ok(/sachet/.test(bio.find(b => b.cat === 'ML Culture').pack));
  reset();
});
t('ML culture is bought for co-inoculation but not for a no-MLF season', () => {
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-ml'; g.roseProtocolId = 'red-coinoc-ml'; });
  ok(A.calcProtocolBiologicals().find(b => b.cat === 'ML Culture'), 'co-inoculation still needs a culture');
  S().grapes.forEach(g => { g.protocolId = 'white-aromatic-noml'; g.roseProtocolId = 'rose-saignee'; });
  eq(A.calcProtocolBiologicals().filter(b => b.cat === 'ML Culture').length, 0);
  reset();
});
t('shopping list merges yeast, biologicals and chemicals', () => {
  reset();
  const list = A.buildShoppingList();
  const cats = new Set(list.map(r => r.cat));
  ok(cats.has('Yeast'), 'no yeast rows');
  ok(cats.has('SO₂'), 'no SO2 rows');
  ok(cats.has('Nutrient'), 'no nutrient rows');
  list.forEach(r => {
    ok(r.key && r.key.includes('|'), 'row missing a stable key');
    ok(typeof r.purchased === 'boolean');
    ok(r.total >= 0 && r.buy >= r.total - 0.01, r.product + ': buy < needed');
    ok(Array.isArray(r.uses) && r.uses.length, r.product + ': no usage breakdown');
  });
});
t('purchase flags toggle and survive recalculation', () => {
  reset();
  const key = A.buildShoppingList()[0].key;
  A.togglePurchased(key);
  eq(S().purchased[key], true);
  ok(A.buildShoppingList().find(r => r.key === key).purchased, 'flag lost on rebuild');
  S().wines[0].agingVolumeGal = 25;             // change the plan
  ok(A.buildShoppingList().find(r => r.key === key).purchased, 'flag lost when quantities changed');
  S().wines[0].agingVolumeGal = 30;
  A.togglePurchased(key);
  eq(S().purchased[key], false);
  reset();
});
t('clearPurchased empties every flag', () => {
  reset();
  A.buildShoppingList().slice(0, 3).forEach(r => A.togglePurchased(r.key));
  ok(Object.values(S().purchased).some(Boolean));
  A.clearPurchased();
  eq(S().purchased, {});
});
t('CSV exports one row per item with a header', () => {
  reset();
  const csv = A.shoppingListCSV();
  const lines = csv.split('\n');
  eq(lines[0], 'Have it,Category,Item,Needed,Buy (+10%),Unit,Suggested pack,Used for,Notes');
  eq(lines.length, A.buildShoppingList().length + 1);
});
t('CSV marks purchased items and escapes safely', () => {
  reset();
  const key = A.buildShoppingList().find(r => r.cat === 'SO₂').key;
  A.togglePurchased(key);
  const row = A.shoppingListCSV().split('\n').find(l => l.startsWith('YES,'));
  ok(row, 'purchased row not marked');
  eq(A.csvCell('a,b'), '"a,b"');
  eq(A.csvCell('say "hi"'), '"say ""hi"""');
  eq(A.csvCell('plain'), 'plain');
  eq(A.csvCell(null), '');
  reset();
});
t('lineVolumes gives must, wine and fruit weight', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose);
  const v = A.lineVolumes(line);
  near(v.gal_must, line.mustGal);
  near(v.gal_wine, line.mustGal * A.LOSS.pToS);
  ok(v.lbs > v.gal_must, 'fruit weight should exceed gallons for whole grapes');
});
t('juice grapes convert at 1:1', () => {
  reset();
  const g = A.grapeById('g3');
  g.form = 'juice'; g.lbsPerGal = 1; g.style = null;
  eq(A.grapeRatio(g), 1);
  const line = A.getTrackingLines().find(l => l.grapeId === 'g3');
  if (line) near(A.lineVolumes(line).lbs, line.mustGal);
  g.form = 'grapes'; g.lbsPerGal = 12; g.style = 'berry';
  reset();
});
t('an empty cellar produces an empty list, not a crash', () => {
  const wines = S().wines;
  S().wines = [];
  eq(A.calcProtocolChemicals(), []);
  eq(A.buildShoppingList(), []);
  eq(A.renderShoppingList(), '');
  S().wines = wines;
  reset();
});

/* ══════════════════════════════════════════════════════════
   Render + persistence
   ══════════════════════════════════════════════════════════ */
t('protocols tab renders the list and every detail view', () => {
  reset();
  A.S.ui.tab = 'protocols'; A.S.ui.protocolId = null;
  ok(A.renderProtocolsTab().includes('Which grape runs which protocol'));
  A.protocolLibrary().forEach(p => {
    A.S.ui.protocolId = p.id;
    const html = A.renderProtocolsTab();
    ok(html.includes('Addition schedule'), p.id + ': detail view broken');
    ok(html.includes('Compatibility check'), p.id + ': no compatibility panel');
  });
  A.S.ui.protocolId = null; A.S.ui.tab = 'wines';
});
t('supplies renders the shopping list with checkboxes', () => {
  reset();
  const html = A.renderSuppliesTab();
  ok(html.includes('Protocol Shopping List'));
  ok(html.includes('togglePurchased'));
  ok(html.includes('exportShoppingList'));
  ok(html.includes('Yeast Needed by Strain'), 'existing yeast panel was dropped');
  ok(html.includes('Equipment Arsenal') || html.includes('Yeast Library'), 'equipment/yeast panels dropped');
});
t('wine detail shows the protocol panel', () => {
  reset();
  A.S.ui.wineId = 'w1';
  const html = A.renderWines();
  ok(html.includes('setGrapeProtocol'), 'no protocol picker on the wine');
});
t('tracking detail shows protocol, steps and additions', () => {
  reset();
  const line = A.getTrackingLines().find(l => !l.isRose);
  A.startTracking(line.key);
  const html = A.renderTrackingDetail(line);
  ok(html.includes('📜 Protocol'));
  ok(html.includes('Additions this protocol calls for'));
  ok(html.includes('Malolactic Fermentation'), 'ML block was dropped');
  reset();
});
t('flowchart draws a bypass marker only where the secondary is skipped', () => {
  reset();
  const count = () => (A.buildSVG().match(/no secondary/g) || []).length;
  S().grapes.forEach(g => { g.protocolId = 'red-classic-ml'; g.roseProtocolId = 'red-classic-ml'; });
  eq(count(), 0, 'bypass shown when every line keeps its secondary');
  S().grapes.forEach(g => { g.roseProtocolId = 'rose-saignee'; });
  ok(count() > 0, 'rosé bleed should bypass the secondary');
  const roseOnly = count();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-ml'; });
  ok(count() > roseOnly, 'co-inoculated main lines should bypass too');
  reset();
});
t('protocols survive a profile save/load round-trip', () => {
  reset();
  A.protoEditable('red-classic-ml').name = 'House Red';
  A.newProtocol();
  const customId = S().protocols[0].id;
  S().grapes[0].protocolId = customId;
  A.togglePurchased('Yeast|VR21');
  const p = A.stateToProfile('Test', 'pTest');
  const json = JSON.parse(JSON.stringify(p));
  S().protocols = []; S().protocolEdits = {}; S().purchased = {};
  A.loadProfileIntoState(json);
  eq(A.getProtocol('red-classic-ml').name, 'House Red', 'edits lost');
  ok(S().protocols.find(x => x.id === customId), 'custom protocol lost');
  eq(S().grapes[0].protocolId, customId, 'assignment lost');
  eq(S().purchased['Yeast|VR21'], true, 'purchase flags lost');
  reset();
});
t('an old profile with no protocol fields migrates cleanly', () => {
  const old = {
    id: 'old', name: 'Legacy',
    equipment: S().equipment, customYeasts: [],
    grapes: [{ id: 'x1', name: 'Zinfandel', type: 'red', pounds: 400, lbsPerGal: 13 }],
    wines: [{ id: 'x9', name: 'Zin', color: 'red', wineType: 'single', grapeId: 'x1', agingVolumeGal: 20, components: [] }],
    tracking: {}, svEquipment: {},
  };
  A.loadProfileIntoState(JSON.parse(JSON.stringify(old)));
  eq(S().protocolEdits, {});
  eq(S().grapes[0].protocolId, null);
  eq(A.grapeProtocolId(S().grapes[0]), 'red-classic-ml');
  ok(A.calcWine(S().wines[0]).grapsNeeded > 0);
  ok(A.renderSuppliesTab().length > 100);
  ok(A.buildSVG().length > 100);
});
t('every inline handler referenced in markup actually exists', () => {
  reset();
  A.S.ui.trackKey = null;
  const htmls = [];
  ['wines', 'grapes', 'protocols', 'tracking', 'calculators', 'supplies', 'flowchart'].forEach(tab => {
    A.S.ui.tab = tab; htmls.push(A.renderTab());
  });
  A.protocolLibrary().forEach(p => { A.S.ui.tab = 'protocols'; A.S.ui.protocolId = p.id; htmls.push(A.renderTab()); });
  A.S.ui.protocolId = null;
  const line = A.getTrackingLines().find(l => !l.isRose);
  A.startTracking(line.key); A.S.ui.trackKey = line.key;
  A.S.ui.tab = 'tracking'; htmls.push(A.renderTab());
  A.S.ui.trackKey = null; A.S.ui.tab = 'wines';

  const missing = new Set();
  htmls.join('\n').replace(/on(?:click|change|input|submit)="([^"]*)"/g, (_, code) => {
    // Blank out quoted arguments first — product names like
    // "Potassium Metabisulfite (KMS)" otherwise read as calls.
    const bare = code.replace(/'[^']*'/g, "''").replace(/&#39;[^&]*&#39;/g, '');
    (bare.match(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g) || []).forEach(m => {
      const fn = m.replace(/[^\w$]/g, '').trim();
      if (['if', 'for', 'while', 'return', 'function', 'catch', 'switch', 'typeof', 'new'].includes(fn)) return;
      if (typeof A[fn] !== 'function' && !/^(this|event|document|window|Math|JSON|Number|String|Array|Object|parseInt|parseFloat)$/.test(fn)) missing.add(fn);
    });
    return _;
  });
  ok(missing.size === 0, 'undefined handlers: ' + [...missing].join(', '));
  reset();
});

t('no rendered handler attribute is broken by a stray quote', () => {
  reset();
  const htmls = [];
  ['wines','grapes','protocols','tracking','calculators','supplies','flowchart'].forEach(tab => { A.S.ui.tab = tab; htmls.push(A.renderTab()); });
  A.protocolLibrary().forEach(p => { A.S.ui.tab='protocols'; A.S.ui.protocolId=p.id; htmls.push(A.renderTab()); });
  A.S.ui.protocolId=null; A.S.ui.tab='wines';
  const bad = [];
  htmls.join('\n').replace(/\son(?:click|change|input|submit)="([^"]*)"/g, (m, code) => {
    // an odd number of single quotes means a JS string ran off the end
    if ((code.match(/'/g) || []).length % 2 !== 0) bad.push(code.slice(0, 90));
    return m;
  });
  ok(bad.length === 0, 'malformed handlers: ' + bad.slice(0, 3).join(' | '));
  // and no attribute should be cut short by an unescaped double quote
  const cut = [];
  htmls.join('\n').replace(/\son(?:click|change)="([^"]*)"([^\s>])/g, (m, _c, next) => { cut.push(next); return m; });
  ok(cut.length === 0, 'attributes terminated early before: ' + cut.slice(0, 3).join(', '));
  reset();
});
t('apostrophes in names survive into handlers', () => {
  reset();
  S().customYeasts.push({ id: 'cy1', brand: "O'Brien", name: "O'Brien Select", fullName: "O'Brien Select", tags: ['red'] });
  S().wines[1].yeastId = 'cy1';
  const html = A.renderSuppliesTab();
  ok(html.includes("O\\&#39;Brien Select") || html.includes("O&#39;Brien Select"), 'apostrophe not escaped');
  const bad = [];
  html.replace(/\son(?:click|change)="([^"]*)"/g, (m, code) => {
    if ((code.match(/'/g) || []).length % 2 !== 0) bad.push(code.slice(0, 80));
    return m;
  });
  ok(bad.length === 0, 'apostrophe broke a handler: ' + bad.slice(0, 2).join(' | '));
  S().customYeasts.length = 0; S().wines[1].yeastId = 'mj-m02';
  reset();
});

t('ML culture is listed by volume, not weight', () => {
  reset();
  const ml = A.calcProtocolBiologicals().find(b => b.cat === 'ML Culture');
  eq(ml.unit, 'gal');
  eq(ml.buy, ml.total, 'a sachet count has no percentage margin');
  ok(/sachet/.test(ml.pack));
});
t('grapes tab shows and sets the protocol per grape', () => {
  reset();
  A.S.ui.tab = 'grapes';
  const html = A.renderTab();
  ok(html.includes('setGrapeProtocol'), 'no protocol picker on the grape card');
  ok(html.includes('Straight to aging') || html.includes('Secondary'), 'no secondary indicator');
  A.S.ui.tab = 'wines';
});
t('the arithmetic matches a hand calculation', () => {
  reset();
  const lines = A.getTrackingLines();
  const byName = n => lines.find(l => A.trackLineName(l).includes(n));
  const cab = byName('Cabernet Sauvignon'), merlot = byName('Merlot');
  const rows = A.calcProtocolChemicals();
  // FT Rouge is 1.30 g per gallon of must, on the two red lines only
  near(rows.find(r => r.product === 'FT Rouge').total,
       1.30 * (cab.mustGal + merlot.mustGal), 0.05);
  // VP41 treats the post-press volume of those same two lines
  near(A.calcProtocolBiologicals().find(b => b.product === 'VP41').total,
       (cab.mustGal + merlot.mustGal) * A.LOSS.pToS, 0.05);
});

t('protocol names are editable from the detail view and the list card', () => {
  reset();
  A.S.ui.tab = 'protocols';
  const list = A.renderTab();
  ok((list.match(/setProtoField\('[^']+','name'/g) || []).length >= 10,
     'list cards should each carry a rename input');
  A.S.ui.protocolId = 'red-classic-ml';
  const detail = A.renderTab();
  ok(detail.includes('id="proto-name"'), 'no name input in the header');
  ok(detail.includes("setProtoField('red-classic-ml','name'"), 'name input not wired');
  ok(detail.includes('id="proto-desc"'), 'description not editable');
  A.S.ui.protocolId = null; A.S.ui.tab = 'wines';
});
t('renaming a builtin sticks, propagates, and resets', () => {
  reset();
  A.setProtoField('red-classic-ml', 'name', '  Iurie House Red  ');
  eq(A.getProtocol('red-classic-ml').name, 'Iurie House Red', 'not trimmed/saved');
  eq(A.PROTOCOL_PRESETS.find(x => x.id === 'red-classic-ml').name,
     'Red — Classic, consecutive MLF', 'the shipped preset was mutated');
  S().grapes[0].protocolId = 'red-classic-ml';
  A.S.ui.tab = 'grapes';
  ok(A.renderTab().includes('Iurie House Red'), 'new name not showing on the grape card');
  A.S.ui.tab = 'wines';
  A.resetProtocolEdit('red-classic-ml');
  eq(A.getProtocol('red-classic-ml').name, 'Red — Classic, consecutive MLF');
  reset();
});
t('an emptied name falls back instead of going blank', () => {
  reset();
  A.setProtoField('red-native', 'name', '   ');
  eq(A.getProtocol('red-native').name, 'Untitled protocol');
  reset();
});
t('a protocol named "true" stays a string', () => {
  reset();
  A.setProtoField('red-native', 'name', 'true');
  eq(A.getProtocol('red-native').name, 'true');
  A.setProtoField('red-native', 'desc', 'false');
  eq(A.getProtocol('red-native').desc, 'false');
  reset();
});
t('custom protocols rename too, and the name survives a save/load', () => {
  reset();
  A.newProtocol();
  const id = S().protocols[0].id;
  A.setProtoField(id, 'name', 'Carbonic Gamay');
  eq(A.getProtocol(id).name, 'Carbonic Gamay');
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pT')));
  S().protocols = [];
  A.loadProfileIntoState(prof);
  eq(A.getProtocol(id).name, 'Carbonic Gamay', 'rename lost on reload');
  reset();
});
t('a renamed protocol with an apostrophe does not break its own input', () => {
  reset();
  A.setProtoField('red-native', 'name', "Ken's Native Red");
  A.S.ui.tab = 'protocols'; A.S.ui.protocolId = 'red-native';
  const html = A.renderTab();
  ok(html.includes('Ken&#39;s Native Red'), 'apostrophe not escaped in the value');
  const bad = [];
  html.replace(/\son(?:click|change)="([^"]*)"/g, (m, code) => {
    if ((code.match(/'/g) || []).length % 2 !== 0) bad.push(code.slice(0, 70));
    return m;
  });
  ok(bad.length === 0, 'apostrophe broke a handler: ' + bad.slice(0, 2).join(' | '));
  A.S.ui.protocolId = null; A.S.ui.tab = 'wines';
  reset();
});
t('ML nutrient is now editable', () => {
  reset();
  A.setProtoField('red-classic-ml', 'mlf.nutrient', 'Acti-ML');
  eq(A.getProtocol('red-classic-ml').mlf.nutrient, 'Acti-ML');
  A.setProtoField('red-classic-ml', 'mlf.nutrient', '');
  eq(A.getProtocol('red-classic-ml').mlf.nutrient, null);
  ok(A.checkProtocol(A.getProtocol('red-classic-ml'), {}).some(i => i.code === 'MLF_NO_NUTRIENT'),
     'dropping the nutrient should raise a note');
  reset();
});


/* ══════════════════════════════════════════════════════════
   Editable product library
   ══════════════════════════════════════════════════════════ */
t('the catalog merges built-ins with custom products', () => {
  reset();
  const builtin = Object.keys(A.CHEM_CATALOG).length;
  eq(Object.keys(A.productCatalog()).length, builtin);
  A.addCustomProduct();
  eq(Object.keys(A.productCatalog()).length, builtin + 1);
  ok(A.isCustomProduct('New product'));
  ok(!A.isCustomProduct('Fermaid K'), 'a built-in should never read as custom');
  reset();
});
t('adding twice does not collide on the name', () => {
  reset();
  A.addCustomProduct(); A.addCustomProduct(); A.addCustomProduct();
  eq(Object.keys(S().customProducts).sort(), ['New product', 'New product 2', 'New product 3']);
  reset();
});
t('product fields are editable, and pack sizes parse', () => {
  reset();
  A.addCustomProduct();
  A.setProductField('New product', 'cat', 'Tannin');
  A.setProductField('New product', 'unit', 'mL');
  A.setProductField('New product', 'note', 'From the Croatian co-op');
  A.setProductField('New product', 'packs', ' 500, 100 , 25 ');
  const p = A.productInfo('New product');
  eq(p.cat, 'Tannin'); eq(p.unit, 'mL');
  eq(p.packs, [25, 100, 500], 'packs should be parsed, cleaned and sorted');
  eq(p.note, 'From the Croatian co-op');
  A.setProductField('New product', 'packs', 'nonsense');
  eq(A.productInfo('New product').packs, null);
  reset();
});
t('a custom product can be used in a protocol and reaches the shopping list', () => {
  reset();
  if (!S().customProducts) S().customProducts = {};
  S().customProducts['Vitiferm Extract'] = { cat: 'Enhancer', unit: 'g', packs: [250], note: 'House blend', custom: true };
  const p = A.protoEditable('red-classic-ml');
  p.additions.push({ stage: 'crush', product: 'Vitiferm Extract', rate: 2, basis: 'gal_must', note: '' });
  const row = A.calcProtocolChemicals().find(r => r.product === 'Vitiferm Extract');
  ok(row, 'custom product missing from the shopping list');
  eq(row.cat, 'Enhancer', 'category not picked up from the custom entry');
  eq(row.unit, 'g');
  eq(row.note, 'House blend');
  ok(/250/.test(row.pack), 'custom pack size not used: ' + row.pack);
  reset();
});
t('a custom product filed as Tannin gets the 8-hour enzyme rule', () => {
  reset();
  S().customProducts = { 'Cellar Tannin X': { cat: 'Tannin', unit: 'g', packs: [100], note: '', custom: true } };
  const p = A.protoEditable('red-classic-ml');
  p.additions.push({ stage: 'crush', product: 'Cellar Tannin X', rate: 1, basis: 'gal_must' });
  ok(A.checkProtocol(A.getProtocol('red-classic-ml'), {}).some(i => i.code === 'ENZYME_TANNIN_STAGE'),
     'the compatibility engine ignored a custom tannin');
  reset();
});
t('a custom product filed as Nutrient satisfies the nitrogen check', () => {
  reset();
  S().customProducts = { 'Homebrew Nutrient': { cat: 'Nutrient', unit: 'g', packs: [100], note: '', custom: true } };
  const p = A.protoEditable('red-classic-ml');
  p.additions = p.additions.filter(a => !/Fermaid/.test(a.product));
  ok(A.checkProtocol(A.getProtocol('red-classic-ml'), {}).some(i => i.code === 'NO_NUTRIENT'));
  p.additions.push({ stage: 'ferment', product: 'Homebrew Nutrient', rate: 1, basis: 'gal_must' });
  ok(!A.checkProtocol(A.getProtocol('red-classic-ml'), {}).some(i => i.code === 'NO_NUTRIENT'),
     'a custom nutrient should count');
  reset();
});
t('renaming a product follows through protocols and purchase flags', () => {
  reset();
  S().customProducts = { 'Old Name': { cat: 'Fining', unit: 'g', packs: [100], note: '', custom: true } };
  const p = A.protoEditable('red-classic-ml');
  p.additions.push({ stage: 'aging', product: 'Old Name', rate: 1, basis: 'gal_wine' });
  A.newProtocol();
  S().protocols[0].additions.push({ stage: 'aging', product: 'Old Name', rate: 1, basis: 'gal_wine' });
  A.togglePurchased('Fining|Old Name');
  A.setProductField('Old Name', 'name', 'New Name');
  ok(!S().customProducts['Old Name'], 'old key left behind');
  ok(S().customProducts['New Name'], 'renamed product missing');
  ok(A.getProtocol('red-classic-ml').additions.some(a => a.product === 'New Name'), 'builtin edit not followed');
  ok(S().protocols[0].additions.some(a => a.product === 'New Name'), 'custom protocol not followed');
  eq(S().purchased['Fining|New Name'], true, 'purchase flag not carried across');
  ok(!('Fining|Old Name' in S().purchased), 'stale purchase key left behind');
  reset();
});
t('renaming onto an existing name is refused', () => {
  reset();
  S().customProducts = { 'Mine': { cat: 'Other', unit: 'g', packs: null, note: '', custom: true } };
  A.setProductField('Mine', 'name', 'Fermaid K');
  ok(S().customProducts['Mine'], 'the rename should have been rejected');
  reset();
});
t('deleting a product leaves the protocol readable', () => {
  reset();
  S().customProducts = { 'Doomed': { cat: 'Fining', unit: 'g', packs: [100], note: '', custom: true } };
  A.protoEditable('red-classic-ml').additions.push({ stage: 'aging', product: 'Doomed', rate: 1, basis: 'gal_wine' });
  A.delCustomProduct('Doomed');
  eq(A.productInfo('Doomed').cat, 'Other', 'an unknown product should fall back, not throw');
  const row = A.calcProtocolChemicals().find(r => r.product === 'Doomed');
  ok(row && row.cat === 'Other', 'orphaned product should still total up');
  eq(row.pack, '', 'no pack sizes for an orphan');
  reset();
});
t('the product library panel renders and flags orphans', () => {
  reset();
  A.S.ui.tab = 'protocols'; A.S.ui.protocolId = null;
  ok(A.renderTab().includes('Product Library'));
  A.protoEditable('red-native').additions.push({ stage: 'aging', product: 'Ghost Product', rate: 1, basis: 'gal_wine' });
  ok(A.renderTab().includes('Ghost Product'), 'orphan not surfaced');
  A.S.ui.tab = 'wines';
  reset();
});
t('the product dropdown keeps an orphaned selection selectable', () => {
  reset();
  A.protoEditable('red-native').additions.push({ stage: 'aging', product: 'Ghost Product', rate: 1, basis: 'gal_wine' });
  A.S.ui.tab = 'protocols'; A.S.ui.protocolId = 'red-native';
  const html = A.renderTab();
  ok(html.includes('Ghost Product'), 'orphan dropped from the dropdown');
  ok(html.includes('<optgroup'), 'dropdown should be grouped by category');
  A.S.ui.protocolId = null; A.S.ui.tab = 'wines';
  reset();
});
t('custom products persist through a profile round-trip', () => {
  reset();
  S().customProducts = { 'Kept': { cat: 'Oak', unit: 'g', packs: [454], note: 'n', custom: true } };
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pT')));
  S().customProducts = {};
  A.loadProfileIntoState(prof);
  eq(A.productInfo('Kept').cat, 'Oak');
  reset();
});

/* ══════════════════════════════════════════════════════════
   Actual weights and volumes
   ══════════════════════════════════════════════════════════ */
const aLine = () => A.getTrackingLines().find(l => !l.isRose);

t('a fresh record has an empty volume ledger', () => {
  reset();
  const rec = A.trackingRec(aLine().key);
  eq(rec.volumes, { fruitLbs: null, mustGal: null });
  eq(rec.volumeLog, []);
});
t('measured must overrides the planned volume', () => {
  reset();
  const line = aLine();
  const rec = A.trackingRec(line.key);
  eq(A.actualMust(rec, line), line.mustGal, 'should fall back to planned');
  A.setRecVolume(line.key, 'mustGal', '42.5');
  eq(A.actualMust(A.trackingRec(line.key), line), 42.5);
  A.setRecVolume(line.key, 'mustGal', '');
  eq(A.actualMust(A.trackingRec(line.key), line), line.mustGal, 'clearing should fall back');
  A.setRecVolume(line.key, 'mustGal', '-5');
  eq(A.actualMust(A.trackingRec(line.key), line), line.mustGal, 'a negative volume is not a measurement');
  reset();
});
t('measured extraction rate is computed, and only when both figures exist', () => {
  reset();
  const line = aLine();
  eq(A.measuredYield(A.trackingRec(line.key)), null);
  A.setRecVolume(line.key, 'fruitLbs', '600');
  eq(A.measuredYield(A.trackingRec(line.key)), null, 'weight alone is not a rate');
  A.setRecVolume(line.key, 'mustGal', '40');
  near(A.measuredYield(A.trackingRec(line.key)), 15);
  reset();
});
t('the measured rate can be pushed back onto the grape', () => {
  reset();
  const line = aLine();
  A.setRecVolume(line.key, 'fruitLbs', '600');
  A.setRecVolume(line.key, 'mustGal', '40');
  A.applyMeasuredYield(line.key, line.grapeId);
  eq(A.grapeById(line.grapeId).lbsPerGal, 15);
  reset();
});
t('measured volume drives the addition doses and the shopping list', () => {
  reset();
  const line = aLine();
  const before = A.calcProtocolChemicals().find(r => r.product === 'Opti-Red').total;
  A.setRecVolume(line.key, 'mustGal', String(line.mustGal * 2));
  const after = A.calcProtocolChemicals().find(r => r.product === 'Opti-Red').total;
  ok(after > before, 'a bigger measured must should need more product');
  near(after - before, line.mustGal, 0.1, 'the extra should be exactly the extra gallons at 1 g/gal');
  reset();
});
t('measured volume drives the stage volumes shown in the stepper', () => {
  reset();
  const line = aLine();
  A.setRecVolume(line.key, 'mustGal', '100');
  const rec = A.trackingRec(line.key);
  near(A.stageVolumes(A.actualMust(rec, line), true).secondary, 85);
  reset();
});
t('volume log entries add, edit and delete', () => {
  reset();
  const line = aLine();
  A.addVolumeEntry(line.key);
  const rec = A.trackingRec(line.key);
  eq(rec.volumeLog.length, 1);
  const id = rec.volumeLog[0].id;
  eq(rec.volumeLog[0].event, 'racking');
  A.setVolumeEntry(line.key, id, 'event', 'grosslees');
  A.setVolumeEntry(line.key, id, 'gal', '38.2');
  A.setVolumeEntry(line.key, id, 'note', 'heavy lees');
  eq(rec.volumeLog[0].event, 'grosslees');
  eq(rec.volumeLog[0].gal, '38.2');
  eq(rec.volumeLog[0].note, 'heavy lees');
  A.delVolumeEntry(line.key, id);
  eq(rec.volumeLog.length, 0);
  reset();
});
t('the ledger tracks running losses down the log', () => {
  reset();
  const line = aLine();
  A.setRecVolume(line.key, 'mustGal', '50');
  A.addVolumeEntry(line.key);
  const rec = A.trackingRec(line.key);
  A.setVolumeEntry(line.key, rec.volumeLog[0].id, 'gal', '42');
  A.setVolumeEntry(line.key, rec.volumeLog[0].id, 'date', '2026-09-20');
  A.addVolumeEntry(line.key);
  A.setVolumeEntry(line.key, rec.volumeLog[1].id, 'gal', '40');
  A.setVolumeEntry(line.key, rec.volumeLog[1].id, 'date', '2026-10-15');
  eq(A.latestVolume(rec), 40);
  const html = A.trkVolumePanel(line, rec);
  ok(html.includes('-16.0%'), 'first racking loss not shown');
  ok(html.includes('-20.0%'), 'total loss from must not shown');
  reset();
});
t('the volume panel renders and sits above the protocol section', () => {
  reset();
  const line = aLine();
  A.startTracking(line.key);
  const html = A.renderTrackingDetail(line);
  ok(html.includes('Actual Weights &amp; Volumes') || html.includes('Actual Weights & Volumes'));
  ok(html.indexOf('Actual Weights') < html.indexOf('📜 Protocol'), 'volumes should come first');
  ok(html.includes('setRecVolume'));
  ok(html.includes('addVolumeEntry'));
  reset();
});
t('the batch header marks a measured volume', () => {
  reset();
  const line = aLine();
  A.startTracking(line.key);
  ok(!A.renderTrackingDetail(line).includes('(measured)'));
  A.setRecVolume(line.key, 'mustGal', '99');
  const html = A.renderTrackingDetail(line);
  ok(html.includes('(measured)'), 'measured volume not flagged');
  ok(html.includes('99.00 gal'));
  reset();
});
t('volume data survives a profile round-trip', () => {
  reset();
  const line = aLine();
  A.setRecVolume(line.key, 'fruitLbs', '512');
  A.addVolumeEntry(line.key);
  A.setVolumeEntry(line.key, A.trackingRec(line.key).volumeLog[0].id, 'gal', '33');
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pT')));
  S().tracking = {};
  A.loadProfileIntoState(prof);
  eq(A.trackingRec(line.key).volumes.fruitLbs, 512);
  eq(A.trackingRec(line.key).volumeLog[0].gal, '33');
  reset();
});
t('an old tracking record with no volume fields migrates', () => {
  reset();
  S().tracking['legacy::x'] = { started: true, stage: 'primary', ml: { enabled: false, timing: 'post' } };
  A.migrateState();
  eq(S().tracking['legacy::x'].volumes, { fruitLbs: null, mustGal: null });
  eq(S().tracking['legacy::x'].volumeLog, []);
  reset();
});

/* ══════════════════════════════════════════════════════════
   Calculators
   ══════════════════════════════════════════════════════════ */
t('SO2 maths reproduces the MoreWine checklist figure', () => {
  near(A.kmsGrams(50, 5), 1.64, 0.02, '50 ppm into 5 gal');
  near(A.kmsGrams(50, 1), 0.33, 0.01, 'the 0.33 g/gal on the sheet');
  eq(A.kmsGrams(-10, 5), 0, 'no negative doses');
  eq(A.kmsGrams(50, 0), 0);
});
t('molecular SO2 falls off as pH rises', () => {
  near(A.molecularSO2(30, 3.2), 1.17, 0.02);
  near(A.molecularSO2(30, 3.8), 0.30, 0.02);
  ok(A.molecularSO2(30, 3.2) > A.molecularSO2(30, 3.8) * 3.5,
     'the pH effect should be roughly fourfold across that range');
  near(A.freeSO2Needed(A.molecularSO2(30, 3.5), 3.5), 30, 0.01, 'the two should be inverses');
});
t('free SO2 target rises steeply with pH', () => {
  const at32 = A.freeSO2Needed(0.5, 3.2), at38 = A.freeSO2Needed(0.5, 3.8);
  near(at32, 12.5, 1); near(at38, 49.6, 2);
  ok(at38 > at32 * 3);
});
t('Brix and SG convert consistently', () => {
  near(A.brixToSG(0), 1.0, 0.001);
  near(A.brixToSG(22), 1.0916, 0.002);
  near(A.sgToBrix(A.brixToSG(22)), 22, 0.01, 'round trip');
  [0, 5, 12, 18, 22, 26, 30].forEach(b =>
    near(A.sgToBrix(A.brixToSG(b)), b, 0.01, 'round trip at ' + b + ' Brix'));
});
t('chaptalization is a mass balance, checked against first principles', () => {
  // 1 lb of sugar in 1 gal of water is 454 / (3785 + 454) = 10.7 Brix
  near(A.chaptalGrams(1, 0, 10.71), 454, 6, 'sugar into water');
  near(A.chaptalGrams(5, 21, 24) / 5, 162, 2, 'g per gallon for +3 Brix');
  eq(A.chaptalGrams(5, 24, 21), 0, 'no negative sugar');
  eq(A.chaptalGrams(0, 21, 24), 0);
});
t('dilution maths conserves sugar', () => {
  const w = A.dilutionGal(5, 27, 24);
  near(w, 0.625, 0.01);
  near(5 * 27, (5 + w) * 24, 0.01, 'sugar mass should be unchanged');
  eq(A.dilutionGal(5, 24, 27), 0, 'water cannot raise Brix');
});
t('tartaric acid is 3.79 g per gallon per g/L', () => {
  near(A.tartaricGrams(1, 5, 6), 3.785, 0.01);
  near(A.tartaricGrams(5, 5.0, 6.5), 28.39, 0.05);
  eq(A.tartaricGrams(5, 6, 5), 0, 'acid cannot lower TA');
});
t('deacidification uses the right rate per agent', () => {
  near(A.deacidGrams(5, 9, 7, 'khco3'), 34, 0.1);
  near(A.deacidGrams(5, 9, 7, 'caco3'), 25, 0.1);
  ok(A.deacidGrams(5, 9, 7, 'khco3') > A.deacidGrams(5, 9, 7, 'caco3'),
     'chalk is the stronger agent per gram');
  eq(A.deacidGrams(5, 7, 9, 'khco3'), 0);
});
t('ABV works from both gravity and Brix', () => {
  near(A.abvFromSG(1.095, 0.995), 13.13, 0.01);
  near(A.abvFromBrix(23, -1.5), 13.1, 0.6);
  ok(A.abvFromSG(1.0, 1.0) === 0);
});
t('the Pearson square splits proportionally and refuses the impossible', () => {
  eq(A.pearson(24, 19, 22), { pctA: 60, pctB: 40 });
  eq(A.pearson(24, 19, 24), { pctA: 100, pctB: 0 });
  eq(A.pearson(24, 19, 30), null, 'a target outside the range is not blendable');
  eq(A.pearson(24, 19, 15), null);
  eq(A.pearson(20, 20, 20), null, 'identical wines have nothing to blend');
});
t('the calculators tab renders every card', () => {
  reset();
  A.S.ui.tab = 'calculators';
  const html = A.renderTab();
  ['SO₂ Addition', 'Chaptalization', 'Water Addition', 'Acid Addition',
   'Deacidification', 'Alcohol by Volume', 'Pearson square', 'Yield'].forEach(h =>
    ok(html.includes(h), 'missing card: ' + h));
  ok(html.includes('id="calc-so2Vol"'), 'inputs need ids so focus survives the re-render');
  A.S.ui.tab = 'wines';
});
t('calculator inputs persist and reset', () => {
  reset();
  A.setCalc('so2Vol', '17.5');
  eq(A.calcNum('so2Vol'), 17.5);
  A.S.ui.tab = 'calculators';
  ok(A.renderTab().includes('value="17.5"'));
  A.S.ui.tab = 'wines';
  A.resetCalcs();
  eq(A.calcNum('so2Vol'), A.CALC_DEFAULTS.so2Vol, 'reset should fall back to the default');
  reset();
});
t('calculators survive nonsense input without throwing', () => {
  reset();
  A.S.ui.tab = 'calculators';
  ['so2Vol', 'so2pH', 'chapVol', 'chapBrix', 'chapTarget', 'dilVol', 'acidVol',
   'deacidVol', 'psA', 'psB', 'psTarget', 'yieldLbs', 'yieldRate'].forEach(k => A.setCalc(k, ''));
  ok(A.renderTab().length > 500, 'blank inputs broke the tab');
  ['so2Vol', 'chapVol', 'yieldRate'].forEach(k => A.setCalc(k, '-99'));
  ok(A.renderTab().length > 500, 'negative inputs broke the tab');
  ['so2pH', 'chapBrix'].forEach(k => A.setCalc(k, 'abc'));
  ok(A.renderTab().length > 500, 'text in a number field broke the tab');
  A.S.ui.tab = 'wines';
  reset();
});
t('the yield calculator matches the app loss chain', () => {
  reset();
  A.setCalc('yieldLbs', '1300'); A.setCalc('yieldRate', '13');
  A.setCalc('yieldSecondary', 'yes');
  A.S.ui.tab = 'calculators';
  const withSec = A.renderTab();
  ok(withSec.includes('100.00 gal'), 'must volume wrong');
  ok(withSec.includes('85.00 gal'), 'press volume wrong');
  ok(withSec.includes('80.75 gal'), 'aging volume wrong');
  ok(withSec.includes('Racked to aging'), 'the racking row should be there');
  A.setCalc('yieldSecondary', 'no');
  const noSec = A.renderTab();
  ok(noSec.includes('85.00 gal'), 'without a secondary, press volume goes straight to aging');
  ok(!noSec.includes('Racked to aging'), 'the racking row should be gone');
  ok(noSec.includes('Skipping the secondary'), 'no explanation of the difference');
  const bottles = h => +(h.match(/(\d+) bottles/) || [])[1];
  ok(bottles(noSec) > bottles(withSec), 'skipping a racking should yield more bottles');
  A.S.ui.tab = 'wines';
  reset();
});
t('switching to Calculators clears the open protocol', () => {
  reset();
  A.S.ui.protocolId = 'red-native';
  A.switchTab('calculators');
  eq(A.S.ui.protocolId, null);
  eq(A.S.ui.tab, 'calculators');
  A.S.ui.tab = 'wines';
  reset();
});

/* ══════════════════════════════════════════════════════════
   FEATURE — Co-fermentation
   ══════════════════════════════════════════════════════════ */

// w1 ships as a Bordeaux blend: g1 Cabernet 70% (500 lbs @ 13, 25 Bx),
// g2 Merlot 30% (175 lbs @ 13, 24 Bx). Flipping it to a co-ferment gives a
// clean two-variety case with equal yields, so the volume and weight bases
// agree and any divergence is a real bug.
const mkCo = (proto, basis) => {
  reset();
  const w = S().wines[0];
  A.setBlendMode(w.id, 'coferment');
  w.agingVolumeGal = 30;
  w.cofermentProtocolId = proto || 'red-classic-ml';
  w.ratioBasis = basis || 'volume';
  w.yeastId = 'mj-vr21';
  return w;
};

/* ── model & migration ── */
t('old profiles migrate to separate-ferment blends', () => {
  reset();
  delete S().wines[0].blendMode; delete S().wines[0].ratioBasis;
  A.migrateState();
  eq(S().wines[0].blendMode, 'separate');
  eq(S().wines[0].ratioBasis, 'volume');
  ok(!A.isCoferment(S().wines[0]), 'a migrated blend must not become a co-ferment');
  reset();
});
t('migrateState backfills the co-ferment protocol slots as null', () => {
  reset();
  eq(S().wines[0].cofermentProtocolId, null);
  eq(S().wines[0].cofermentRoseProtocolId, null);
});
t('isCoferment only fires on blends explicitly switched over', () => {
  reset();
  ok(!A.isCoferment(S().wines[0]), 'a separate blend is not a co-ferment');
  ok(!A.isCoferment(S().wines[1]), 'a single varietal is never a co-ferment');
  A.setBlendMode(S().wines[0].id, 'coferment');
  ok(A.isCoferment(S().wines[0]));
  A.setBlendMode(S().wines[0].id, 'separate');
  ok(!A.isCoferment(S().wines[0]), 'switching back must restore the separate ferment');
  reset();
});
t('switching to co-ferment keeps the varieties and their ratios', () => {
  const w = mkCo();
  eq(w.components.length, 2);
  eq(w.components.map(c => c.ratio), [70, 30]);
  reset();
});
t('a co-ferment drops per-variety tank splits and bleeds', () => {
  reset();
  const w = S().wines[0];
  w.components[0].useTankSplit = true;
  w.components[0].hasRose = true;
  A.setBlendMode(w.id, 'coferment');
  ok(!w.components[0].useTankSplit, 'one vessel cannot hold a per-variety tank split');
  ok(!w.components[0].hasRose, 'a bleed comes off the whole co-ferment, not one variety');
  reset();
});
t('a co-ferment inherits a yeast from its components if it has none', () => {
  reset();
  const w = S().wines[0];
  w.yeastId = null;
  A.setBlendMode(w.id, 'coferment');
  eq(w.yeastId, 'mj-vr21');
  reset();
});

/* ── proportions ── */
t('volume basis: shares are read straight off the ratios', () => {
  const w = mkCo('red-classic-ml', 'volume');
  const mix = A.cofermentMix(w);
  near(mix.comps[0].volShare, 0.7, 0.001);
  near(mix.comps[1].volShare, 0.3, 0.001);
  near(mix.lbsPerGal, 13, 0.001, 'equal yields blend to the same rate');
  reset();
});
t('ratios that do not total 100 are still normalised', () => {
  const w = mkCo();
  w.components[0].ratio = 35; w.components[1].ratio = 15;   // same 70/30, half scale
  const mix = A.cofermentMix(w);
  near(mix.comps[0].volShare, 0.7, 0.001);
  near(mix.comps[1].volShare, 0.3, 0.001);
  reset();
});
t('mixing juice with whole grapes splits volume and weight apart', () => {
  const w = mkCo('red-classic-ml', 'volume');
  S().grapes[1].form = 'juice'; A.migrateState();            // Merlot arrives as juice, 1:1
  const byVol = A.cofermentMix(w);
  near(byVol.comps[0].volShare, 0.7, 0.001);
  near(byVol.lbsPerGal, 0.7 * 13 + 0.3 * 1, 0.001);
  w.ratioBasis = 'weight';
  const byWt = A.cofermentMix(w);
  near(byWt.comps[0].weightShare, 0.7, 0.001);
  near(byWt.comps[0].volShare, (0.7 / 13) / (0.7 / 13 + 0.3 / 1), 0.001,
    'by weight, the juice dominates the vessel');
  ok(byWt.comps[0].volShare < 0.2, '70% of the fruit by weight is a small share of the must here');
  reset();
});
t('an empty variety slot never skews the proportions', () => {
  const w = mkCo();
  w.components.push({ grapeId: null, ratio: 0, tanks: [] });
  const mix = A.cofermentMix(w);
  eq(mix.comps.length, 3, 'rows stay index-aligned with components');
  near(mix.comps[0].volShare, 0.7, 0.001);
  eq(mix.comps[2].volShare, 0);
  reset();
});
t('starting Brix is the volume-weighted average', () => {
  const w = mkCo();
  near(A.cofermentBrix(w), 0.7 * 25 + 0.3 * 24, 0.01);
  reset();
});

/* ── the volume chain ── */
t('a co-ferment back-calculates one chain from the aging vessel', () => {
  const w = mkCo('red-classic-ml');                 // consecutive MLF → secondary
  const c = A.calcWine(w);
  ok(c.isCoferment, 'calcWine should route to the co-ferment engine');
  near(c.secondaryGal, 30 / 0.95, 0.01);
  near(c.totalMustGal, 30 / 0.95 / 0.85, 0.01);
  near(c.grapsNeeded, (30 / 0.95 / 0.85) * 13, 0.1);
  reset();
});
t('co-inoculated MLF removes the secondary and one racking', () => {
  const withSec = A.calcWine(mkCo('red-classic-ml'));
  const noSec = A.calcWine(mkCo('red-coinoc-ml'));
  ok(withSec.hasSecondary, 'sequential MLF needs its own vessel');
  ok(!noSec.hasSecondary, 'co-inoculated MLF finishes with the primary');
  near(noSec.totalMustGal, 30 / 0.85, 0.01);
  ok(noSec.totalMustGal < withSec.totalMustGal,
    'skipping a racking means less fruit for the same aging vessel');
  eq(noSec.bottles, withSec.bottles, 'the aging vessel, not the chain, sets the bottle count');
  reset();
});
t('the fruit bill splits by proportion', () => {
  const c = A.calcWine(mkCo());
  near(c.components[0].needLbs, c.totalMustGal * 0.7 * 13, 0.1);
  near(c.components[1].needLbs, c.totalMustGal * 0.3 * 13, 0.1);
  near(c.components[0].needLbs + c.components[1].needLbs, c.grapsNeeded, 0.1);
  reset();
});
t('the shortest variety caps the batch', () => {
  const w = mkCo();
  S().grapes[1].pounds = 40;                        // not enough Merlot for 30%
  const c = A.calcWine(w);
  ok(!c.sufficient, 'a short variety makes the whole co-ferment short');
  ok(c.components[1].shortLbs > 0);
  ok(c.components[0].sufficient, 'the other variety is still fine on its own');
  near(c.maxMustGal, 40 / (0.3 * 13), 0.05,
    'holding the recipe, the Merlot decides how big the batch can be');
  ok(c.maxMustGal < c.totalMustGal);
  reset();
});
t('a co-ferment reports no single-variety excess', () => {
  const c = A.calcWine(mkCo());
  c.components.forEach(cc => eq(cc.excessGal, 0));
  eq(A.calcSVConsolidation().size, 0, 'nothing is held back to consolidate');
  reset();
});
t('saignée off a co-ferment enlarges the must and yields a rosé', () => {
  const w = mkCo();
  const plain = A.calcWine(w).totalMustGal;
  w.hasRose = true; w.saigneePercent = 10;
  const c = A.calcWine(w);
  near(c.totalMustGal, plain / 0.9, 0.01);
  near(c.roseMustGal, c.totalMustGal * 0.1, 0.01);
  ok(c.roseCalc && c.roseCalc.bottles > 0, 'the bleed should yield bottles');
  reset();
});

/* ── allocation ── */
t('a co-ferment claims exactly its recipe', () => {
  const w = mkCo();
  const c = A.calcWine(w);
  const alloc = A.calcGrapeAllocations();
  near(alloc.get('g1').allocations.find(a => a.wineId === w.id).requested,
    c.components[0].needLbs, 0.1);
  near(alloc.get('g2').allocations.find(a => a.wineId === w.id).requested,
    c.components[1].needLbs, 0.1);
  reset();
});
t('leftover fruit does not get swept into a co-ferment', () => {
  const w = mkCo();
  const c = A.calcWine(w);
  const alloc = A.calcGrapeAllocations();
  ok(alloc.get('g1').remainingLbs > 1,
    'the Cabernet a co-ferment does not need must stay free');
  near(alloc.get('g1').usedLbs, c.components[0].needLbs, 0.1);
  reset();
});
t('a separate blend still absorbs leftovers as single-variety wine', () => {
  reset();
  const alloc = A.calcGrapeAllocations();
  near(alloc.get('g1').remainingLbs, 0, 0.01,
    'the separate-ferment path is unchanged — leftovers become SV wine');
  reset();
});
t('an earlier wine still gets first claim on a shared grape', () => {
  const w = mkCo();
  S().wines.push({ id: 'wX', name: 'Merlot Solo', color: 'red', wineType: 'single',
    lbsPerGal: 13, grapeId: 'g2', agingEquipmentId: null, agingVolumeGal: 12,
    components: [], primaryEquipmentId: null, secondaryEquipmentId: null,
    hasRose: false, saigneePercent: 0, roseAgingEquipmentId: null, roseAgingVolumeGal: 0,
    roseYeastId: null, yeastId: 'mj-vr5', useTankSplit: false, tanks: [] });
  A.migrateState();
  const alloc = A.calcGrapeAllocations();
  const co = alloc.get('g2').allocations.find(a => a.wineId === w.id);
  const solo = alloc.get('g2').allocations.find(a => a.wineId === 'wX');
  near(co.allocated, co.requested, 0.1, 'the co-ferment is first in the list');
  ok(solo.allocated < solo.requested, 'the later wine takes what is left');
  reset();
});

/* ── tracking ── */
t('a co-ferment is one batch, not one per variety', () => {
  const w = mkCo();
  const lines = A.getTrackingLines();
  const co = lines.filter(l => l.coWineId === w.id);
  eq(co.length, 1, 'one vessel, one log');
  eq(co[0].key, 'co::' + w.id);
  near(co[0].mustGal, A.calcWine(w).totalMustGal, 0.01);
  ok(!lines.some(l => !l.coWineId && (l.grapeId === 'g1' || l.grapeId === 'g2')),
    'the varieties must not also appear as separate batches');
  reset();
});
t('the batch is named for the varieties in the vessel', () => {
  mkCo();
  const line = A.getTrackingLines().find(l => l.coWineId);
  ok(A.trackLineName(line).includes('Cabernet Sauvignon'), 'names the first variety');
  ok(A.trackLineName(line).includes('Merlot'), 'names the second');
  ok(A.trackLineName(line).includes('co-ferment'), 'says what it is');
  reset();
});
t('the co-ferment protocol drives its tracking record', () => {
  const w = mkCo('red-coinoc-ml');
  const key = 'co::' + w.id;
  const rec = A.trackingRec(key);
  ok(rec.ml.enabled, 'co-inoculated protocols still run an ML');
  eq(rec.ml.timing, 'simultaneous');
  ok(!A.recNeedsSecondary(rec, key), 'co-inoculation skips the secondary vessel');
  eq(A.trackStages(rec, key), ['primary', 'aging', 'bottled']);
  reset();
});
t('sequential MLF puts the secondary and ML stages back', () => {
  const w = mkCo('red-classic-ml');
  const key = 'co::' + w.id;
  const rec = A.trackingRec(key);
  eq(rec.ml.timing, 'post');
  ok(A.recNeedsSecondary(rec, key));
  eq(A.trackStages(rec, key), ['primary', 'secondary', 'ml', 'aging', 'bottled']);
  reset();
});
t('a manual ML override still wins on a co-ferment', () => {
  const w = mkCo('red-classic-ml');
  const key = 'co::' + w.id;
  const rec = A.trackingRec(key);
  rec.mlManual = true; rec.ml = { enabled: true, timing: 'simultaneous' };
  ok(!A.recNeedsSecondary(rec, key), 'the winemaker overrides the protocol');
  reset();
});
t('stage volumes follow the co-ferment chain', () => {
  const w = mkCo('red-coinoc-ml');
  const key = 'co::' + w.id;
  const line = A.getTrackingLines().find(l => l.key === key);
  const v = A.stageVolumes(line.mustGal, A.recNeedsSecondary(A.trackingRec(key), key));
  near(v.aging, line.mustGal * 0.85, 0.01, 'no secondary means no second racking loss');
  reset();
});
t('a co-ferment never opens the Blend Lab', () => {
  const w = mkCo();
  ok(!A.getBlendTargets().some(b => b.wine.id === w.id),
    'there is nothing to assemble — it was never apart');
  reset();
});
t('the batch label reads sensibly from a bare key', () => {
  const w = mkCo();
  ok(A.trackKeyLabel('co::' + w.id).includes('co-ferment'));
  reset();
});

/* ── supplies ── */
t('protocol additions scale off the whole co-ferment volume', () => {
  const w = mkCo('red-classic-ml');
  const must = A.calcWine(w).totalMustGal;
  const line = A.getTrackingLines().find(l => l.coWineId);
  const vols = A.lineVolumes(line);
  near(vols.gal_must, must, 0.01);
  near(vols.gal_wine, must * 0.85, 0.01);
  near(vols.lbs, must * 13, 0.1, 'lbs use the blended yield rate');
  reset();
});
t('the shopping list bills the co-ferment once', () => {
  const w = mkCo();
  const list = A.buildShoppingList({ includeOptional: false, margin: 0.1 });
  const uses = [].concat.apply([], list.map(r => r.uses || []));
  const mine = uses.filter(u => String(u.batch).includes('co-ferment'));
  ok(mine.length > 0, 'the co-ferment should reach the shopping list');
  ok(!uses.some(u => u.batch === 'Merlot'),
    'a co-fermented variety must not be billed again on its own');
  reset();
});
t('yeast demand counts one inoculation for the vessel', () => {
  const w = mkCo();
  const d = A.getYeastDemand().find(y => y.yeastId === 'mj-vr21');
  ok(d, 'the co-ferment yeast should show demand');
  near(d.totalGal, A.calcWine(w).totalMustGal, 0.01);
  reset();
});

/* ── harvest windows ── */
t('non-overlapping harvest windows are flagged', () => {
  const w = mkCo();
  S().grapes[0].harvestStartMonth = 'October'; S().grapes[0].harvestStartPeriod = 'Mid';
  S().grapes[0].harvestEndMonth = 'October';   S().grapes[0].harvestEndPeriod = 'Late';
  S().grapes[1].harvestStartMonth = 'August';  S().grapes[1].harvestStartPeriod = 'Early';
  S().grapes[1].harvestEndMonth = 'August';    S().grapes[1].harvestEndPeriod = 'Late';
  const clash = A.cofermentHarvestClash(w);
  ok(clash, 'August fruit cannot wait for mid-October fruit');
  eq(clash.early, 'Merlot'); eq(clash.late, 'Cabernet Sauvignon');
  reset();
});
t('overlapping harvest windows pass quietly', () => {
  const w = mkCo();
  eq(A.cofermentHarvestClash(w), null, 'the shipped windows overlap');
  reset();
});

/* ── render paths ── */
t('the co-ferment editor renders', () => {
  const w = mkCo();
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('Co-Ferment Composition'), 'composition section');
  ok(html.includes('Proportion %'), 'proportion input');
  ok(html.includes('setBlendMode'), 'the mode switch');
  ok(html.includes('setRatioBasis'), 'the volume/weight switch');
  ok(html.includes('Co-Ferment Summary'), 'summary box');
  ok(!html.includes('Blend Ratio %'), 'the separate-ferment fields should be gone');
  reset();
});
t('the editor shows the secondary as skipped under co-inoculation', () => {
  const w = mkCo('red-coinoc-ml');
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('Straight to aging'), 'the protocol panel states the consequence');
  ok(html.includes('press straight to aging'), 'the vessel slot is closed off');
  reset();
});
t('the editor offers a secondary vessel under sequential MLF', () => {
  const w = mkCo('red-classic-ml');
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('Secondary vessel'), 'the protocol panel says a vessel is needed');
  ok(html.includes("'secondaryEquipmentId'"), 'and the picker is live');
  reset();
});
t('a short co-ferment explains its ceiling', () => {
  const w = mkCo();
  S().grapes[1].pounds = 40;
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('The fruit runs out'), 'the summary should say so plainly');
  reset();
});
t('every tab still renders with a co-ferment in the cellar', () => {
  mkCo();
  ['wines', 'grapes', 'protocols', 'tracking', 'calculators', 'supplies', 'flowchart'].forEach(tab => {
    S().ui.tab = tab;
    const html = A.renderTab();
    ok(typeof html === 'string' && html.length > 50, tab + ' produced no markup');
  });
  S().ui.tab = 'wines';
  reset();
});
t('the tracking detail opens on a co-ferment batch', () => {
  const w = mkCo();
  S().ui.tab = 'tracking'; S().ui.trackKey = 'co::' + w.id;
  const html = A.renderTab();
  ok(html.includes('co-ferment'), 'the batch is named');
  ok(html.includes('setCofermentProtocol'), 'the protocol is editable from the log');
  ok(html.includes('every variety in the vessel'), 'and it says what it governs');
  S().ui.trackKey = null;
  reset();
});
t('the flowchart draws the co-ferment as one vessel', () => {
  mkCo();
  const svg = A.buildSVG();
  ok(svg.includes('co-ferment'), 'the column is badged');
  ok(svg.includes('arr-co'), 'the feed arrows are drawn');
  ok(svg.includes('Cabernet Sauvignon'), 'both varieties still get a node');
  ok(svg.includes('Merlot'));
  reset();
});
t('a variety used only in a co-ferment still gets exactly one node', () => {
  const w = mkCo();
  const svg = A.buildSVG();
  const count = (svg.match(/>Merlot</g) || []).length;
  ok(count >= 1, 'the Merlot node exists');
  ok(count <= 2, 'and it is not duplicated per consumer');
  reset();
});

/* ── persistence ── */
t('co-ferment settings survive a profile round-trip', () => {
  const w = mkCo('red-coinoc-ml', 'weight');
  w.cofermentRoseProtocolId = 'rose-saignee';
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pT')));
  reset();
  A.loadProfileIntoState(prof);
  const back = S().wines.find(x => x.id === w.id);
  eq(back.blendMode, 'coferment');
  eq(back.ratioBasis, 'weight');
  eq(back.cofermentProtocolId, 'red-coinoc-ml');
  ok(A.isCoferment(back));
  reset();
});
t('the separate-ferment blend is untouched by all of this', () => {
  reset();
  const c = A.calcWine(S().wines[0]);
  ok(c.isBlend && !c.isCoferment);
  ok(c.components[0].blendPortionGal > 0, 'per-variety blend portions still compute');
  ok(A.getBlendTargets().length === 1, 'it still opens the Blend Lab');
  reset();
});

t('a saignée off a co-ferment shows its yield', () => {
  const w = mkCo();
  w.hasRose = true; w.saigneePercent = 12; w.roseAgingEquipmentId = 'eq3';
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('Enable Saign'), 'the bleed toggle is there');
  ok(html.includes('Ros\u00e9 Yield'), 'and the yield box renders off the wine calc');
  ok(html.includes('carries the same'), 'the note explains what is in the bleed');
  reset();
});
t('a co-ferment is badged as one everywhere it is listed', () => {
  const w = mkCo();
  S().ui.tab = 'wines'; S().ui.wineId = w.id;
  const html = A.renderTab();
  ok(html.includes('Co-Ferment</span>'), 'the detail header');
  ok(html.includes('>co-ferment</span>'), 'the sidebar chip');
  reset();
});

/* ══════════════════════════════════════════════════════════
   FEATURE — Inoculation log
   ══════════════════════════════════════════════════════════ */

// w2 is the shipped Chardonnay single varietal on mj-m02.
const startBatch = (key) => { A.startTracking(key); return A.trackingRec(key); };
const chardKey = () => A.getTrackingLines().find(l => l.grapeId === 'g3').key;

t('the inoculation panel names the planned strain and a dose', () => {
  reset();
  const key = chardKey();
  startBatch(key);
  S().ui.tab = 'tracking'; S().ui.trackKey = key;
  const html = A.renderTab();
  ok(html.includes('Inoculation'), 'the section exists');
  ok(html.includes('M02'), 'it names the strain from the project');
  ok(html.includes('g/gal'), 'and states the rate it suggested from');
  ok(html.includes('logYeastPitch'), 'with a control to log the pitch');
  S().ui.trackKey = null; reset();
});
t('the suggested dose follows must volume and the season rate', () => {
  reset();
  S().ui.yeastRate = 1;
  const line = A.getTrackingLines().find(l => l.grapeId === 'g3');
  eq(A.suggestedYeastGrams(line.mustGal), Math.round(line.mustGal));
  S().ui.yeastRate = 2;
  eq(A.suggestedYeastGrams(line.mustGal), Math.round(line.mustGal * 2));
  S().ui.yeastRate = 1;
  reset();
});
t('the rehydration hint comes off the batch protocol', () => {
  reset();
  const line = A.getTrackingLines().find(l => l.grapeId === 'g3');
  const hint = A.rehydrationHint(line, line.mustGal);
  ok(hint, 'the white protocol calls for a rehydration nutrient');
  ok(/Go-Ferm/.test(hint.product));
  ok(hint.grams > 0, 'and it works out a real dose');
  reset();
});
t('a pitch is recorded once, with its strain', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-y-date': '2026-09-20', 'inoc-y-strain': 'mj-m02',
               'inoc-y-amount': '9', 'inoc-y-notes': 'rehydrated at 40C' },
    () => A.logYeastPitch(key));
  const p = A.pitchOf(rec, 'yeast');
  ok(p, 'the pitch is stored');
  eq(p.date, '2026-09-20');
  eq(p.amount, 9);
  eq(p.unit, 'g');
  eq(p.yeastId, 'mj-m02');
  ok(p.product.includes('M02'), 'the product is the strain name');
  reset();
});
t('re-logging replaces the pitch rather than stacking a second one', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-y-strain': 'mj-m02', 'inoc-y-amount': '9' }, () => A.logYeastPitch(key));
  withFields({ 'inoc-y-strain': 'mj-m06', 'inoc-y-amount': '11' }, () => A.logYeastPitch(key));
  eq(rec.additions.filter(a => a.kind === 'yeast').length, 1, 'one vessel, one pitch');
  eq(A.pitchOf(rec, 'yeast').amount, 11);
  reset();
});
t('a pitch with no strain chosen is refused', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-y-strain': '' }, () => A.logYeastPitch(key));
  eq(A.pitchOf(rec, 'yeast'), null, 'nothing should be written');
  reset();
});
t('the pitch stays out of the chemistry table', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-y-strain': 'mj-m02', 'inoc-y-amount': '9' }, () => A.logYeastPitch(key));
  withFields({ 'add-select': 'Bentonite', 'add-amount': '20', 'add-unit': 'g' },
    () => A.addAddition(key));
  const chem = A.trkAdditionsPanel(key, rec);
  ok(chem.includes('Bentonite'), 'ordinary additions still list');
  ok(!chem.includes('M02'), 'the pitch is not duplicated here');
  ok(chem.includes('Inoculation panel above'), 'and the note says where it went');
  reset();
});
t('clearing a pitch removes it', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-y-strain': 'mj-m02' }, () => A.logYeastPitch(key));
  A.delAddition(key, A.pitchOf(rec, 'yeast').id);
  eq(A.pitchOf(rec, 'yeast'), null);
  reset();
});
t('a logged pitch reaches the season totals in Supplies', () => {
  reset();
  const key = chardKey();
  startBatch(key);
  withFields({ 'inoc-y-strain': 'mj-m02', 'inoc-y-amount': '9' }, () => A.logYeastPitch(key));
  const row = A.getChemicalTotals().find(r => r.product.includes('M02'));
  ok(row, 'the strain shows up under what was actually used');
  eq(row.total, 9);
  reset();
});
t('the nudge appears until the pitch is logged', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  const line = A.getTrackingLines().find(l => l.key === key);
  ok(A.trkInoculationPanel(line, rec, line.mustGal).includes("isn't logged yet"));
  withFields({ 'inoc-y-strain': 'mj-m02' }, () => A.logYeastPitch(key));
  const after = A.trkInoculationPanel(line, rec, line.mustGal);
  ok(!after.includes("isn't logged yet"), 'and goes once it is');
  ok(after.includes('pitched'), 'replaced by the record');
  reset();
});

/* ── malolactic side ── */
t('no ML planned means nothing to inoculate', () => {
  reset();
  const key = chardKey();                       // white-aromatic-noml
  const rec = startBatch(key);
  const line = A.getTrackingLines().find(l => l.key === key);
  const html = A.trkInoculationPanel(line, rec, line.mustGal);
  ok(html.includes('No malolactic planned'), 'the panel says so plainly');
  ok(!html.includes('logMlPitch'), 'and offers no control');
  reset();
});
t('sequential MLF explains when the culture goes in', () => {
  reset();
  S().grapes[2].protocolId = 'red-classic-ml';
  const key = chardKey();
  const rec = startBatch(key);
  const line = A.getTrackingLines().find(l => l.key === key);
  const html = A.trkInoculationPanel(line, rec, line.mustGal);
  ok(html.includes('Sequential'), 'the timing is named');
  ok(html.includes('VP41'), 'the culture is prefilled from the protocol');
  ok(html.includes('logMlPitch'), 'and it can be logged');
  reset();
});
t('co-inoculated MLF says it goes in with the yeast', () => {
  reset();
  S().grapes[2].protocolId = 'red-coinoc-ml';
  const key = chardKey();
  const rec = startBatch(key);
  const line = A.getTrackingLines().find(l => l.key === key);
  ok(A.trkInoculationPanel(line, rec, line.mustGal).includes('Co-inoculated'));
  reset();
});
t('an ML inoculation is recorded once', () => {
  reset();
  S().grapes[2].protocolId = 'red-classic-ml';
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-m-date': '2026-10-05', 'inoc-m-product': 'VP41',
               'inoc-m-amount': '2.5', 'inoc-m-unit': 'g' }, () => A.logMlPitch(key));
  const p = A.pitchOf(rec, 'ml');
  ok(p); eq(p.product, 'VP41'); eq(p.amount, 2.5); eq(p.date, '2026-10-05');
  withFields({ 'inoc-m-product': 'CH16' }, () => A.logMlPitch(key));
  eq(rec.additions.filter(a => a.kind === 'ml').length, 1);
  reset();
});
t('an unnamed ML culture is refused', () => {
  reset();
  S().grapes[2].protocolId = 'red-classic-ml';
  const key = chardKey();
  const rec = startBatch(key);
  withFields({ 'inoc-m-product': '  ' }, () => A.logMlPitch(key));
  eq(A.pitchOf(rec, 'ml'), null);
  reset();
});

/* ── co-ferments and persistence ── */
t('a co-ferment gets one pitch for the whole vessel', () => {
  const w = mkCo();
  const key = 'co::' + w.id;
  const rec = startBatch(key);
  const line = A.getTrackingLines().find(l => l.key === key);
  const html = A.trkInoculationPanel(line, rec, line.mustGal);
  ok(html.includes('VR21'), 'the co-ferment yeast is the planned strain');
  withFields({ 'inoc-y-strain': 'mj-vr21', 'inoc-y-amount': '37' }, () => A.logYeastPitch(key));
  eq(rec.additions.filter(a => a.kind === 'yeast').length, 1);
  reset();
});
t('pitches survive a profile round-trip', () => {
  reset();
  const key = chardKey();
  startBatch(key);
  withFields({ 'inoc-y-strain': 'mj-m02', 'inoc-y-amount': '9' }, () => A.logYeastPitch(key));
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pT')));
  reset();
  A.loadProfileIntoState(prof);
  const back = A.pitchOf(S().tracking[key], 'yeast');
  ok(back && back.amount === 9 && back.kind === 'yeast');
  reset();
});
t('an old record with no pitches still renders', () => {
  reset();
  const key = chardKey();
  const rec = startBatch(key);
  rec.additions = [{ id: 'x1', date: '2026-09-01', stage: 'primary', product: 'Bentonite', amount: 5, unit: 'g', notes: '' }];
  const line = A.getTrackingLines().find(l => l.key === key);
  ok(A.trkInoculationPanel(line, rec, line.mustGal).length > 50);
  ok(A.trkAdditionsPanel(key, rec).includes('Bentonite'));
  reset();
});

/* ══════════════════════════════════════════════════════════
   FEATURE — corrected co-inoculation protocols (2026 revision)
   ══════════════════════════════════════════════════════════ */
t('both co-inoculation protocols ship and skip the secondary', () => {
  ['red-coinoc-ml', 'red-coinoc-mlprime'].forEach(id => {
    const p = A.getProtocol(id);
    ok(p, id + ' missing');
    eq(p.mlf.mode, 'simultaneous', id + ' should co-inoculate');
    eq(A.needsSecondary(p).required, false, id + ' should not need a secondary');
  });
});
t('the ML culture is in the addition schedule, at the ML stage', () => {
  const vp = A.getProtocol('red-coinoc-ml').additions.find(a => a.product === 'VP41');
  const mp = A.getProtocol('red-coinoc-mlprime').additions.find(a => a.product === 'ML Prime');
  ok(vp && vp.stage === 'ml', 'VP41 not scheduled');
  ok(mp && mp.stage === 'ml', 'ML Prime not scheduled');
  near(vp.rate, 0.04, 0.001, 'VP41 should be 1 g/hL');
  near(mp.rate, 0.38, 0.001, 'ML Prime should be a 25 g pack per 66 gal');
  near(mp.rate * 66, 25, 0.5, 'ML Prime pack sizing drifted');
});
t('ML cultures are catalogued, so nothing shows as an orphan', () => {
  eq(A.productInfo('VP41').cat, 'ML Culture');
  eq(A.productInfo('ML Prime').cat, 'ML Culture');
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-mlprime'; });
  const inUse = Object.keys(A.productsInUse());
  const cat = A.productCatalog();
  eq(inUse.filter(n => !cat[n]), [], 'protocol references an uncatalogued product');
  reset();
});
t('a culture is billed once — as a sachet, not also by weight', () => {
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-mlprime'; g.roseProtocolId = 'rose-saignee'; });
  const chem = A.calcProtocolChemicals();
  eq(chem.filter(r => r.product === 'ML Prime').length, 0, 'culture double-billed by weight');
  const bio = A.calcProtocolBiologicals().find(b => b.product === 'ML Prime');
  ok(bio && bio.cat === 'ML Culture', 'no sachet row for ML Prime');
  ok(/sachet/.test(bio.pack));
  reset();
});
t('a co-inoculated culture treats must volume, not post-press', () => {
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-ml'; });
  const lines = A.getTrackingLines().filter(l => !l.isRose);
  const must = lines.reduce((s, l) => s + l.mustGal, 0);
  near(A.calcProtocolBiologicals().find(b => b.product === 'VP41').total, must, 0.05,
       'co-inoculation should dose the whole must');
  S().grapes.forEach(g => { g.protocolId = 'red-classic-ml'; });
  const must2 = A.getTrackingLines().filter(l => !l.isRose).reduce((s, l) => s + l.mustGal, 0);
  near(A.calcProtocolBiologicals().find(b => b.product === 'VP41').total, must2 * A.LOSS.pToS, 0.05,
       'a consecutive MLF only sees what came off the press');
  reset();
});
t('a bench-trial addition stays on the shopping list with no quantity', () => {
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-mlprime'; });
  const row = A.calcProtocolChemicals().find(r => r.product === 'Tartaric Acid');
  ok(row, 'bench-trial acid fell off the shopping list');
  eq(row.total, 0, 'a bench-trial row should carry no quantity');
  ok(row.benchTrial, 'row not flagged as bench trial');
  ok(/bench trial/.test(A.shoppingListCSV()), 'CSV lost the bench-trial marker');
  reset();
});
t('a zero-rate addition without the flag is still dropped', () => {
  reset();
  const p = JSON.parse(JSON.stringify(A.getProtocol('red-native')));
  p.additions.push({ stage: 'aging', product: 'Bentonite', rate: 0, basis: 'gal_wine' });
  S().protocols.push(Object.assign(p, { id: 'ptest', builtin: false }));
  S().grapes.forEach(g => { g.protocolId = 'ptest'; g.roseProtocolId = 'ptest'; });
  eq(A.calcProtocolChemicals().filter(r => r.product === 'Bentonite').length, 0);
  reset();
});
t('ML Prime surfaces its pH gate and its lack of a fallback', () => {
  const c = codes(A.checkProtocol(A.getProtocol('red-coinoc-mlprime'), {}));
  ok(c.includes('MLB_PH_GATE'), 'no pH gate note');
  ok(c.includes('MLB_NO_RESTART'), 'no restart warning');
  ok(!c.includes('ACID_BEFORE_MLF'), 'post-ML acid should not trip the acid rule');
});
t('acidifying before the malic is gone is a conflict on a high-floor strain', () => {
  const p = mutate('red-coinoc-mlprime', x => {
    x.additions.push({ stage: 'crush', product: 'Tartaric Acid', rate: 2, basis: 'gal_must' });
  });
  ok(codes(A.checkProtocol(p, {})).includes('ACID_BEFORE_MLF'));
});
t('VP41 takes acid at crush, with a headroom note instead', () => {
  const c = codes(A.checkProtocol(A.getProtocol('red-coinoc-ml'), {}));
  ok(c.includes('ACID_BEFORE_MLF_HEADROOM'), 'no headroom note');
  ok(!c.includes('ACID_BEFORE_MLF'), 'VP41 tolerates pH 3.1 — should not be a conflict');
  ok(!c.includes('MLB_PH_GATE'), 'VP41 has no 3.4 gate');
  ok(!c.includes('MLB_NO_RESTART'), 'VP41 can restart a stalled MLF');
});
t('SO2 limits follow the strain, not one fixed number', () => {
  // 38 ppm is fine for VP41 (60 ppm ceiling) but not comfortable for ML Prime (50)
  eq(codes(A.checkProtocol(A.getProtocol('red-coinoc-ml'), {})).filter(c => /^SO2_COINOC/.test(c)), []);
  const hot = mutate('red-coinoc-mlprime', p => { p.additions[0].rate = 0.28; });   // ~42 ppm
  ok(codes(A.checkProtocol(hot, {})).includes('SO2_COINOC'));
  const over = mutate('red-coinoc-mlprime', p => { p.additions[0].rate = 0.40; });  // ~61 ppm
  ok(codes(A.checkProtocol(over, {})).includes('SO2_COINOC_OVER'));
});
t('ML Prime cannot carry a consecutive MLF', () => {
  const p = mutate('red-coinoc-mlprime', x => { x.mlf.mode = 'consecutive'; });
  ok(codes(A.checkProtocol(p, {})).includes('MLB_NOT_SEQUENTIAL'));
});
t('strain limits drive the pH and alcohol warnings', () => {
  ok(codes(A.checkProtocol(A.getProtocol('red-coinoc-mlprime'), { pH: 3.3 })).includes('MLF_LOW_PH'),
     'pH 3.3 is under ML Prime floor');
  eq(codes(A.checkProtocol(A.getProtocol('red-coinoc-ml'), { pH: 3.3 })).filter(c => c === 'MLF_LOW_PH'), [],
     'pH 3.3 is fine for VP41');
  ok(codes(A.checkProtocol(A.getProtocol('red-coinoc-mlprime'), { potentialAlc: 15.8 })).includes('MLF_HIGH_ALC'));
  eq(codes(A.checkProtocol(A.getProtocol('red-coinoc-ml'), { potentialAlc: 15.8 })).filter(c => c === 'MLF_HIGH_ALC'), []);
});
t('a stale override on the corrected protocol is retired once', () => {
  reset();
  S().protocolEdits['red-coinoc-ml'] = { name: 'Old co-inoc', additions: [] };
  S().protoRev = null;
  A.migrateState();
  ok(!S().protocolEdits['red-coinoc-ml'], 'stale schedule override survived');
  // a fresh edit made after the revision is left alone
  A.setProtoField('red-coinoc-ml', 'name', 'My co-inoc');
  A.setProtoAdd('red-coinoc-ml', 0, 'rate', 0.22);
  A.migrateState();
  eq(A.getProtocol('red-coinoc-ml').name, 'My co-inoc', 'a current edit was wrongly discarded');
  reset();
});
t('the revision marker survives a profile round-trip', () => {
  reset();
  const prof = JSON.parse(JSON.stringify(A.stateToProfile('T', 'pR')));
  eq(prof.protoRev, 2026);
  S().protoRev = null;
  A.loadProfileIntoState(prof);
  eq(S().protoRev, 2026);
  reset();
});
t('both new protocols render their detail view', () => {
  reset();
  ['red-coinoc-ml', 'red-coinoc-mlprime'].forEach(id => {
    const html = A.renderProtocolDetail(A.getProtocol(id));
    ok(html.includes('Addition schedule'), id + ': detail view broken');
    ok(html.includes('benchTrial'), id + ': no bench-trial control');
  });
  reset();
});
t('the shopping list shows a bench-trial row without a number', () => {
  reset();
  S().grapes.forEach(g => { g.protocolId = 'red-coinoc-mlprime'; });
  const html = A.renderShoppingList();
  ok(html.includes('Tartaric Acid'), 'acid missing from the list');
  ok(html.includes('bench trial'), 'bench-trial row rendered as a quantity');
  reset();
});

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
