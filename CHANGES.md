# Protocols build — what changed

Base: `winemaking_planner_8_15.html` (3,670 lines) → `index.html` (4,875 lines).
Nothing was removed. Every existing tab, panel and function is still there.

---

## 1. Protocols — a new tab

Sits between **Grapes** and **Tracking**: fruit → method → schedule.

It's not inside Supplies because Wine Projects, Tracking, Flowchart *and*
Supplies all read from it. Supplies is downstream — it consumes protocol data to
cost out the season. Making it the parent would mean editing a method from a
shopping page.

**Ten presets**, all editable, all resettable:

| | Red | White / Orange | Rosé |
|---|---|---|---|
| | Classic, consecutive MLF | Aromatic, no MLF | Saignée, no MLF |
| | Co-inoculated MLF | Barrel ferment, full MLF | Direct press, no MLF |
| | Native yeast, native MLF | Orange skin-contact, native | |
| | Biodiva bioprotection → Sacch | Minimal, nutrients only | |

Each carries a method block (yeast strategy, bioprotection strain, cold soak,
press point, MLF mode and culture, cold stabilization, filtration), an
**addition schedule** with rates and a basis, and an ordered **step checklist**
that shows up on the batch in Tracking.

Red and White rates come straight from your scanned MoreWine checklists —
0.33 g/gal SO₂, Lallzyme EX at 0.1, Opti-Red/Opti-White at 1.0, FT Rouge at 1.3
(0.8–1.9), FT Blanc Soft at 0.5 (0.2–0.6), and the 8-hour enzyme-before-tannin
rule enforced by the compatibility checker. Ken's handwritten note is in there
too: 7 g/gal oak chips at crush, American untoasted first, flagged optional so
it stays out of the shopping list unless you switch optional additions on.

Builtins use the same override layer as your yeasts — `S.protocolEdits[id]`
holds a full copy, the shipped preset is never mutated, Reset restores it.
Duplicate any protocol to start a custom one; that's a better starting point
than blank.

**Assignment is per grape**, which is what "each varietal done a different way"
means. Rosé bleeds get their own protocol, since a saignée off a Cabernet must
isn't made like the Cabernet. You can set it from the Protocols tab table, the
Grapes card, the wine detail, or the batch in Tracking — all four write to the
same place.

## 2. Secondary is now optional

One rule drives it: a secondary vessel exists so something can happen to the
wine in bulk after the primary and before aging. In practice that's a
consecutive MLF. Co-inoculated MLF finishes with the primary; no MLF means press
straight into the aging vessel.

This is not cosmetic — **it changes the yield math.** Skipping the secondary
skips one racking, so `chainFor()` returns `sToA: 1` instead of `0.95`. A wine
with no secondary needs about 5% less fruit to fill the same barrel. The
allocation engine computes this **per component**, so a blend can mix a
co-inoculated Cabernet with a consecutive-MLF Merlot and the fruit demand is
right for each.

Where it shows up:

- **Wine Projects** — the Secondary Fermenter dropdown becomes "⏭ Not needed —
  press straight to aging", with the reason on hover.
- **Tracking** — the stepper goes primary → aging. ML settings follow the
  protocol until you override them on a batch, and a "↩ Follow protocol" button
  hands control back.
- **Flowchart** — a dashed hollow pass-through marker in the secondary row
  instead of a vessel, with a new legend entry.
- **Blend Lab** — `blendSplitStage()` reports whether components merge after
  primary or after secondary.

There's an override at the protocol level: Auto / Always / Never.

## 3. Compatibility checking

20 rules, each returning what's wrong *and* what to do. Errors are red, risks
amber, notes grey. They run live on the Protocols tab, on each wine in Wine
Projects, and on each batch in Tracking.

The ones worth naming:

- **Biodiva cancelled by SO₂** — bioprotection is doing the job SO₂ would do;
  running both is self-defeating. Hard conflict.
- **Killer yeast versus bioprotection** — EC-1118 and K1-V1116 will destroy
  Biodiva before it contributes anything. Hard conflict.
- **Bioprotection with nothing to follow it** — T. delbrueckii stalls around
  8–10% and can't finish alone.
- **Lysozyme or sorbate with MLF** — one kills the bacteria, the other makes
  geranium taint that can't be removed.
- **Enzyme and tannin in the same stage** — the tannin neutralizes the enzyme.
  This is the 8-hour rule from your checklists, enforced structurally.
- **DAP during a co-inoculated ferment** — nitrogen spikes inhibit MLB.
- **SO₂-producing yeast on co-inoculation** — EC-1118, K1-V1116, Premier Blanc.
- **71B with a planned MLF** — it eats some of the malic you were counting on.
- **MLF below pH 3.1, above 15% potential alcohol, or under 60°F.**
- **Cold stabilizing before MLF is confirmed finished** — it restarts in bottle.
- **A red with no MLF** — refermentation risk unless you hold SO₂ and sterile
  filter.
- Plus bentonite-versus-enzyme, bentonite-versus-tannin, missing nutrient,
  filtering without cold stabilizing, yeast alcohol tolerance, and rosé-with-MLF.

Strain traits (killer, SO₂ producer, malic consumer) live in a separate
`YEAST_TRAITS` map so the yeast editor's save path can't drop them.

## 4. Shopping list with purchase checkmarks

New panel in Supplies, appended below the existing planning content — the
"Yeast Needed by Strain" and "Chemicals Logged in Tracking" panels are
untouched, and the equipment and yeast library panels below them are intact.

Every batch contributes its protocol's addition schedule, scaled by that
batch's volume (`per gal must` = pre-press, `per gal wine` = post-press),
totalled by product across the whole season. Yeast, ML cultures and
bioprotection strains are in the same table.

- Purchase checkbox per row, keyed stably (`SO₂|Potassium Metabisulfite (KMS)`)
  so ticks survive recalculation when you change a plan.
- The existing yeast-by-strain table got the same checkbox column.
- Adjustable safety margin (default 10%) and an optional-additions toggle.
- Suggested pack sizes from a product catalog.
- **Export CSV** — one row per item, with what it's for and whether you have it.

For the default cellar that produces, among others: FT Rouge 67.5 g,
Go-Ferm Protect 76.62 g, KMS 35.34 g, VP41 for 44.13 gal (1 × 66-gal sachet).

---

## Testing

`test_app.js` — **99 tests, all passing.** Run:

```
python3 build_harness.py && node test_app.js
```

The harness runs the real script block from `index.html` in a Node VM with DOM
stubs, so it tests the shipped file rather than a copy.
`build_harness.py` extracts the script and appends an export epilogue, because
`let`/`const` bindings stay in a VM script's lexical scope otherwise.

Coverage: every tab renders, all ten protocol detail views render, preset
structural integrity, the two PDF checklists reproduced faithfully,
enzyme-before-tannin ordering across all presets, the override/reset layer,
secondary derivation for every preset plus overrides, the yield-math change
(verified to be exactly one racking loss), mixed-protocol blend allocation
without overcommitting, tracking stage advance on a no-secondary batch, all 20
compatibility rules, chemical aggregation checked against hand arithmetic, pack
sizing, purchase flags surviving plan changes, CSV escaping, profile round-trip
persistence, legacy-profile migration, every inline handler resolving to a real
function, and no rendered handler attribute broken by a stray quote.

That last one caught a real bug: `JSON.stringify` in an `onchange` attribute
emitted double quotes that terminated the attribute early. Fixed with a `jsStr()`
helper that escapes ahead of the HTML entity.

---

## One thing to fix on your side

The project-knowledge files (`wm_part1.txt`–`wm_part5.txt`,
`winemaking_planner.html`) are still the old three-tab build — 1,657 lines with
none of `calcGrapeAllocations`, `grapeRatio`, `migrateState`, `YEAST_DEFAULTS`
or `builtinYeasts`. Replace them with this `index.html` so the next session
doesn't start from the wrong file.

## Verify before crush

Every rate is a planning starting point from the MoreWine checklists and
standard Lallemand / Scott Labs labels. Manufacturers revise them. Check the
current product label — the app should never be the authority on a dosage.
