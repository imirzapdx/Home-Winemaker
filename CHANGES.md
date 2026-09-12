# Build notes — co-fermentation

5,484 → 5,959 lines. **191 tests passing** (145 before). Run with:

```
python3 build_harness.py && node test_app.js
```

---

## The switch

A blend wine now has a **How It's Made** selector next to Wine Type:

- **Blend finished wines** — the existing behaviour, and what every saved
  project migrates to. Nothing about it changed.
- **Co-ferment — one vessel** — the varieties go into the primary together,
  on one yeast, under one protocol, and travel as a single wine to the bottle.

Flipping to co-ferment keeps the varieties and their ratios. It pulls a yeast
and vessels up from the components if the wine level was empty, and clears
per-variety tank splits and per-variety bleeds, because one fermenter can hold
neither. Flipping back restores the separate ferment.

`migrateState()` backfills `blendMode:'separate'` on every existing wine, so an
old profile can't accidentally arrive as a co-ferment.

## Proportions — volume or weight

You didn't say which basis you think in, so the app carries both. A **Read as**
selector switches between:

- **% of the must (volume)** — each number is that variety's share of what's in
  the fermenter. Default.
- **% of the fruit (weight)** — each number is its share of what went on the
  scale.

Each variety card shows the *other* figure underneath, so the gap is visible
rather than silent. With two varieties at the same lbs/gal the two bases agree
exactly. Make one of them juice and they diverge hard: 70/30 by weight becomes
roughly 15/85 by volume, because juice is 1:1 and whole grapes are 13:1. That
is the case the toggle exists for.

Ratios that don't total 100 are normalised, and an empty variety slot never
skews the split.

**Starting Brix** is shown as the volume-weighted average of what each variety
brings in — a planning figure, and the compatibility engine uses it for the
potential-alcohol checks on the batch.

## One chain, not one per variety

A co-ferment back-calculates like a single varietal with a compound grape bill:
one primary, one loss chain, one aging vessel, then the fruit bill splits by
proportion.

At a 30-gal aging target with sequential MLF:

| | |
|---|---|
| Secondary | 31.58 gal |
| Must in the fermenter | 37.15 gal |
| Fruit | 483 lbs — 338 Cabernet, 145 Merlot |
| Bottles | ~143 |

Switch that protocol to co-inoculated MLF and the secondary vessel disappears,
one racking loss goes with it, and the same vessel now needs 35.29 gal of must
instead of 37.15. That's the existing `needsSecondary()` logic reused, not a
second copy — the co-ferment path and your varietal protocols can't drift
apart.

## The shortest variety caps the batch

You can't make up a missing variety with more of another and still have the
wine you planned. So if one component runs short, the whole co-ferment is
short, and the summary says how big the batch can actually be at those
proportions — in gallons and in bottles — rather than just flagging a deficit.

The allocation engine changed in two places:

- **Pass 1** treats a co-ferment as one need-based claim, split per grape.
- **Pass 3** no longer sweeps leftover fruit into a co-ferment. A separate
  blend can absorb extra fruit as single-variety wine; a co-ferment takes
  exactly its recipe and no more. Leftovers stay free for another project.

List-order priority is unchanged — an earlier wine still gets first claim.

## Downstream

- **Tracking** — one batch per co-ferment, named for what's in the vessel
  ("Cabernet Sauvignon + Merlot (co-ferment)"), not one per grape. The ML
  setting follows the co-ferment's own protocol, and a manual override on the
  batch still wins. Co-inoculated gives `primary → aging → bottled`;
  sequential gives `primary → secondary → ml → aging → bottled`.
- **Supplies** — protocol additions scale off the combined must and use a
  blended lbs/gal. The varieties are billed once, not again individually.
  Yeast demand counts one inoculation for the vessel.
- **Blend Lab** — a co-ferment never appears there. There is nothing to
  bench-trial; it was never apart.
- **Flowchart** — one badged column for the vessel, with purple feed arrows
  from each contributing variety carrying its poundage. Every grape still gets
  exactly one node, including a variety that exists only inside a co-ferment.
- **Saignée** — a bleed comes off the assembled must, so the rosé carries the
  same mix as the red. It gets its own protocol slot and its own yield box.

## Harvest windows

Since the Grapes tab already carries harvest timing, a co-ferment checks that
its varieties overlap. When they don't, the editor names the pair and which one
you'd be picking off its own schedule — the Syrah/Viognier problem, where the
co-ferment only works if you pick the white early with the red.

---

## Test coverage added

46 new tests on top of the existing 145.

**Model** — migration of old blends, `isCoferment` scoping, ratios surviving
the switch, tank splits and per-variety bleeds being cleared, yeast inheritance.

**Proportions** — volume shares, normalisation of ratios that miss 100, the
juice-versus-grapes divergence in both directions, empty slots staying
index-aligned, weighted Brix.

**Chain** — back-calculation from the aging vessel, co-inoculation removing the
secondary and one racking, bottle count staying tied to the vessel, the fruit
bill splitting by proportion, the short-variety ceiling, no single-variety
excess, saignée enlarging the must.

**Allocation** — exact claims, leftovers staying free, the separate-blend path
still absorbing them, list-order priority across a shared grape.

**Tracking** — one batch not many, batch naming, protocol-driven ML in both
timings, manual override, stage volumes, Blend Lab exclusion, key labels.

**Supplies** — addition scaling, single billing on the shopping list, yeast
demand.

**Render** — the editor, both secondary states, the shortfall explanation, the
tracking detail, the flowchart's badge and feed arrows, single-node-per-grape,
every tab with a co-ferment in the cellar, and the badges.

**Persistence** — a profile round-trip through `blendMode`, `ratioBasis` and
both protocol slots.

Plus a separate edge-case sweep (not in the suite) over: no components, an
empty slot, a zero ratio, a single variety, no aging volume, three varieties,
an inactive grape, an all-juice cellar, weight basis, saignée, no yeast, a
white protocol on a red wine, and every wine in the cellar co-fermented.

---

Rates and constants are still planning figures. Bench trial anything going into
a batch you care about, and check the current product label before crush.
