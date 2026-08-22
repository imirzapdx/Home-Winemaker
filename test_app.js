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
    getElementById: id => (id === 'content' ? content : makeEl()),
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
  ['wines', 'grapes', 'protocols', 'tracking', 'supplies', 'flowchart'].forEach(tab => {
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
t('10 presets ship', () => eq(A.PROTOCOL_PRESETS.length, 10));
t('library returns builtins', () => eq(A.protocolLibrary().length, 10));
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
  ['wines', 'grapes', 'protocols', 'tracking', 'supplies', 'flowchart'].forEach(tab => {
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
  ['wines','grapes','protocols','tracking','supplies','flowchart'].forEach(tab => { A.S.ui.tab = tab; htmls.push(A.renderTab()); });
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

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
