# Build notes — products, volumes, calculators

4,901 → 5,484 lines. **145 tests passing.** Run with:

```
python3 build_harness.py && node test_app.js
```

---

## 1. Products are editable

`CHEM_CATALOG` is now the shipped floor, not the ceiling. A new **Product
Library** panel at the bottom of the Protocols tab lets you add anything you
actually stock — name, category, unit, pack sizes, notes.

The category is not decoration. It feeds the compatibility engine and the
shopping list, so a product you file as **Tannin** picks up the 8-hour enzyme
rule, and one filed as **Nutrient** satisfies the nitrogen check. Pack sizes
drive the "suggested pack" column.

Three things worth knowing:

- **Renaming follows through.** Change a product's name and every protocol
  addition that used it is rewritten, and the purchase checkmark moves to the
  new key. A rename never silently orphans a line on the shopping list.
- **Deleting is safe.** If a protocol still references a deleted product, it
  keeps working — the item still totals up, just filed under "Other" with no
  pack size. The library flags these as orphans so you can re-add them.
- **The addition dropdown is now grouped by category**, with custom entries
  marked ✎, and it keeps an orphaned selection selectable rather than silently
  switching it to something else.

## 2. Actual weights and volumes in Tracking

New **📏 Actual Weights & Volumes** section, sitting directly under the batch
header — above the protocol, as the first thing you see.

Two headline figures: **fruit on the scale** and **must in the fermenter**, each
showing the planned number and the percentage you're off it. Enter both and the
panel computes your **measured extraction rate** in lbs/gal, with a one-click
link to write it back to the grape so future planning uses the number this fruit
actually gave rather than the estimate.

Below that, a **volume log** — a dated row per measurement, with an event type
(off gross lees, racking, after MLF, cold stabilization, fining, filtration,
topping, into barrel, at bottling) and a note. Each row shows the change from
the previous reading in both gallons and percent, and the panel totals the loss
from must to your latest reading.

The important part is what it feeds. Once a measured must volume exists it
replaces the planned figure **everywhere downstream** — the stepper's stage
volumes, the protocol addition doses on that batch, and the Supplies shopping
list. The doses you're handed are for the wine you actually have. The batch
header and the tracking card both mark when a volume is measured rather than
estimated.

## 3. Calculators tab

Eight bench calculations, between Tracking and Supplies. Every one shows its
working, and inputs persist so switching tabs doesn't lose your place.

| | |
|---|---|
| **SO₂ addition** | Molecular target by pH, not just free SO₂. Includes a pH sensitivity table. |
| **Chaptalization** | Sugar to raise Brix, as a mass balance. |
| **Water addition** | Water to lower Brix, with the TA dilution warning. |
| **Acid addition** | Tartaric to raise TA. |
| **Deacidification** | Potassium bicarbonate or chalk, with the pH shift and a warning past 2 g/L. |
| **ABV** | From gravity or Brix, plus the ×0.55 field estimate. |
| **Blending** | Pearson square, with a note that it does not work for pH. |
| **Yield** | Fruit to bottles through the app's own loss chain. |

The SO₂ one earns its place. Free SO₂ alone tells you almost nothing — at pH 3.8
you need roughly four times the free SO₂ you'd need at pH 3.2 for the same
protection. The calculator works backward from a molecular target (0.5 ppm reds,
0.8 whites) to the free SO₂ you need, then to grams of KMS.

### Math verification

Every formula is checked against an independent reference, not just against
itself:

- **KMS**: 50 ppm into 5 gallons → 1.64 g. The MoreWine sheet says 1.6 g, and
  0.33 g/gal. Matches.
- **Brix → SG**: within 0.0002 of published tables from 0 to 26 Brix.
- **Chaptalization**: 1 lb of sugar into 1 gallon of water gives 10.71 Brix by
  first principles. The calculator agrees to within 6 g.
- **Dilution**: verified by confirming sugar mass is conserved.
- **Tartaric**: 3.785 g/gal per 1 g/L — exactly 1 g/L, since a gallon is
  3.785 L.
- **ABV**: (1.095 − 0.995) × 131.25 = 13.13%.
- **Pearson**: 24 and 19 to a target of 22 gives 60/40.

One real bug surfaced here. The first `brixToSG` was a fitted polynomial while
`sgToBrix` was the standard cubic, and the two drifted about 0.15 Brix apart on
a round trip. `brixToSG` is now the numeric inverse of the cubic, so the two
directions can't disagree.

---

## Test coverage added

44 new tests on top of the existing 101.

**Products** — catalog merging, name collision on add, pack-size parsing and
sorting, a custom product reaching the shopping list with its own category and
pack, a custom Tannin triggering the enzyme rule, a custom Nutrient satisfying
the nitrogen check, rename propagating through builtin edits and custom
protocols and purchase flags, rename onto an existing name being refused, delete
leaving the protocol readable, orphan detection, orphans staying selectable in
the dropdown, profile round-trip.

**Volumes** — empty ledger on a fresh record, measured must overriding planned
and falling back when cleared, negative values rejected, extraction rate needing
both figures, writing the rate back to the grape, measured volume changing doses
by exactly the extra gallons, stepper volumes following, log CRUD, running loss
percentages, panel ordering above the protocol section, the header "measured"
flag, profile round-trip, legacy record migration.

**Calculators** — all eight formulas against the reference values above, the
Brix/SG round trip at seven points, the tab rendering every card, inputs having
ids so focus survives the re-render, persistence and reset, and a robustness
sweep feeding blank, negative and non-numeric values into every field.

---

Rates and constants are still planning figures. Bench trial anything going into
a batch you care about, and check the current product label before crush.
