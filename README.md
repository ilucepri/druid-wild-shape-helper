# Druid Wild Shape Helper

Foundry VTT module for the dnd5e system (2024 rules). It adds a **Wild Shape** tab to druid character sheets:

- Lists the druid's known forms: the ones chosen with *dnd5e-character-builder* plus any creature dragged onto the tab.
- Shows the remaining Wild Shape uses, the maximum CR and whether flying forms are allowed (read from the Wild Shape / Circle Forms features).
- **Wild Shape** button: pick a known form, spend one use and transform using the dnd5e `wildshape` preset.
- While transformed, the button becomes **Revert form**.
- **Choose forms** window: remove known forms and learn new ones from every Beast in your compendiums that fits your level's CR and flying limits, up to your known-forms maximum (4 / 6 / 8).

## 2014 rules

Druids whose Wild Shape feature (or druid class) is marked as 2014 rules, or worlds set to the legacy rules, get a 2014 mode:

- No known forms: the **Wild Shape** picker lists every eligible Beast in your compendiums, with a search box. The tab keeps a list of **favorite forms** (no limit) that appear first.
- Limits follow the 2014 Beast Shapes table, including "no swimming speed" before 4th level, and Circle of the Moon (CR 1 from 2nd level, druid level ÷ 3 from 6th).
- You take the beast's hit points: no kept HP, no temporary HP, no Moon minimum AC and no spells in beast form.

When a Wild Shape / Circle Forms feature has no transform profiles (for example an imported or hand-made feature), the module uses the Beast Shapes table for the druid's level and rules.

## Install

In Foundry, go to *Add-on Modules → Install Module* and paste this manifest URL:

```
https://github.com/ilucepri/druid-wild-shape-helper/releases/latest/download/module.json
```

Players need the GM to enable **Allow Polymorphing** in the dnd5e settings, and they need permission to create actors.

Compatibility: Foundry v13–v14, dnd5e 5.x (tested against 5.3.3).
