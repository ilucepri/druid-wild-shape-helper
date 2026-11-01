const MODULE_ID = "druid-wild-shape-helper";
const BUILDER_ID = "dnd5e-character-builder";
const TAB_ID = "wildShape";
const TEMPLATE = `modules/${MODULE_ID}/templates/wild-shape-tab.hbs`;
const MANAGER_TEMPLATE = `modules/${MODULE_ID}/templates/forms-manager.hbs`;
const FORM_ITEMS = new Set(["wild-shape", "circle-forms"]);

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const Sheet = dnd5e.applications.actor.CharacterActorSheet;

  // Insert the tab body before the non-tab parts so it renders alongside the other tabs.
  const part = { container: { classes: ["tab-body"], id: "tabs" }, template: TEMPLATE, scrollable: [""] };
  const parts = {};
  for ( const [key, value] of Object.entries(Sheet.PARTS) ) {
    if ( key === "abilityScores" ) parts[TAB_ID] = part;
    parts[key] = value;
  }
  parts[TAB_ID] ??= part;
  Sheet.PARTS = parts;

  // No tab condition: a part that appears after the first render (e.g. the druid reaches 2nd level with the
  // sheet open) is appended outside the tab container. The part always renders and the tab button is hidden instead.
  Sheet.TABS.push({ tab: TAB_ID, label: "WILDSHAPEHELPER.Tab", icon: "fas fa-paw" });
  foundry.applications.handlebars.loadTemplates([TEMPLATE, MANAGER_TEMPLATE]);
});

// Registered at setup: the compendium list for the choices only exists once packs are initialized.
Hooks.once("setup", () => {
  const { SetField, StringField } = foundry.data.fields;
  const packageTitle = ({ packageType, packageName }) => {
    if ( packageType === "system" ) return game.system.title;
    if ( packageType === "world" ) return game.world.title;
    return game.modules.get(packageName)?.title ?? packageName;
  };
  const choices = Object.fromEntries(game.packs.filter(p => p.documentName === "Actor")
    .map(p => [p.collection, `${p.metadata.label} (${packageTitle(p.metadata)})`])
    .sort((a, b) => a[1].localeCompare(b[1])));
  game.settings.register(MODULE_ID, "beastPacks", {
    name: "WILDSHAPEHELPER.Settings.Packs.Name",
    hint: "WILDSHAPEHELPER.Settings.Packs.Hint",
    scope: "world",
    config: true,
    type: new SetField(new StringField({ choices })),
    default: [],
    onChange: () => {
      beastIndex = undefined;
      for ( const app of foundry.applications.instances.values() ) {
        if ( (app instanceof dnd5e.applications.actor.CharacterActorSheet) || (app instanceof FormsManager) ) {
          if ( app.rendered ) app.render();
        }
      }
    }
  });
});

Hooks.on("dnd5e.prepareSheetContext", (sheet, partId, context) => {
  if ( partId === TAB_ID ) context.wildShape = hasWildShape(sheet.actor) ? prepareContext(sheet) : null;
});

Hooks.on("renderCharacterActorSheet", (sheet, element) => {
  const enabled = hasWildShape(sheet.actor);
  // Inline style: the sheet's tab styles would override a [hidden] attribute.
  const navItem = element.querySelector(`nav.tabs [data-tab="${TAB_ID}"]`);
  if ( navItem ) navItem.style.display = enabled ? "" : "none";
  const tab = element.querySelector(`.tab[data-tab="${TAB_ID}"]`);
  if ( !tab ) return;
  if ( !enabled && tab.classList.contains("active") ) sheet.changeTab("details", "primary");

  // Safety net: keep the tab inside the tab container next to the other tabs.
  const body = element.querySelector(".tab-body");
  if ( body && (tab.parentElement !== body) ) body.append(tab);

  // Partial renders keep the existing tab element, so only bind once per element.
  if ( tab.dataset.wshBound ) return;
  tab.dataset.wshBound = "true";
  tab.querySelectorAll("[data-wsh-action]").forEach(el => el.addEventListener("click", event => {
    event.preventDefault();
    onAction(sheet.actor, el.dataset.wshAction, el.closest("[data-uuid]")?.dataset.uuid);
  }));
  tab.addEventListener("drop", event => onDrop(event, sheet.actor));
  bindBeastBrowser(tab, sheet.actor);
});

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

/**
 * The un-transformed actor, which owns the known forms and the Wild Shape uses.
 * @param {Actor5e} actor
 * @returns {Actor5e}
 */
function getOriginalActor(actor) {
  if ( !actor.isPolymorphed ) return actor;
  return game.actors.get(actor.getFlag("dnd5e", "originalActor")) ?? actor;
}

function getWildShapeItem(actor) {
  return actor.itemTypes.feat.find(i => i.identifier === "wild-shape");
}

function hasWildShape(actor) {
  return !!getWildShapeItem(getOriginalActor(actor));
}

/**
 * Whether this druid plays by the 2014 rules: no known forms, and the beast's hit points replace the druid's.
 * Decided by the Wild Shape feature or druid class source, falling back to the world's rules setting.
 * @param {Actor5e} actor  Original actor.
 * @returns {boolean}
 */
function isLegacy(actor) {
  const rules = getWildShapeItem(actor)?.system.source?.rules || actor.classes?.druid?.system.source?.rules;
  if ( rules ) return rules === "2014";
  return game.settings.get("dnd5e", "rulesVersion") === "legacy";
}

function isMoonDruid(actor) {
  return actor.itemTypes.subclass.some(i => (i.system.classIdentifier === "druid") && i.identifier.includes("moon"));
}

/**
 * Known forms chosen in the character builder plus forms added here, minus the ones removed here.
 * @param {Actor5e} actor  Original actor.
 * @returns {object[]}
 */
function getKnownForms(actor) {
  // Read the builder flag directly: getFlag throws when that module isn't active.
  const builder = foundry.utils.getProperty(getWildShapeItem(actor)?.flags ?? {}, `${BUILDER_ID}.knownWildShapeForms`) ?? [];
  const custom = actor.getFlag(MODULE_ID, "forms") ?? [];
  const removed = new Set(actor.getFlag(MODULE_ID, "removed") ?? []);
  const forms = new Map();
  for ( const f of [...builder, ...custom] ) if ( !forms.has(f.uuid) && !removed.has(f.uuid) ) forms.set(f.uuid, f);
  return sortForms(Array.from(forms.values()));
}

function sortForms(forms) {
  return forms.sort((a, b) => (a.cr - b.cr) || a.name.localeCompare(b.name));
}

/**
 * How many forms the druid can know: the class scale value if there is one, otherwise the 2024 table.
 * 2014 druids have no known forms, so their favorites have no limit.
 * @param {Actor5e} actor  Original actor.
 * @returns {number|null}
 */
function getMaxKnown(actor) {
  if ( isLegacy(actor) ) return null;
  const scale = actor.system.scale?.druid?.["known-forms"]?.value;
  if ( scale ) return scale;
  const level = actor.classes?.druid?.system.levels ?? 0;
  if ( level < 2 ) return null;
  return level >= 8 ? 8 : level >= 4 ? 6 : 4;
}

let beastIndex;

/**
 * Compendiums chosen in the module settings. A stored compendium that no longer exists (its module was
 * uninstalled) can fail validation, so fall back to every compendium instead of breaking the tab.
 * @returns {Set<string>}
 */
function getChosenPacks() {
  try {
    return new Set(game.settings.get(MODULE_ID, "beastPacks") ?? []);
  } catch(err) {
    console.warn(`${MODULE_ID} | Could not read the beast compendium setting, using every compendium.`, err);
    return new Set();
  }
}

/**
 * Every Beast in the Actor compendiums chosen by the GM (all of them when none is chosen) that the user can see,
 * one entry per name (module packs win over the system's).
 * @returns {Promise<object[]>}
 */
async function getBeastIndex() {
  if ( beastIndex ) return beastIndex;
  const fields = [
    "img", "system.details.cr", "system.details.type.value",
    "system.attributes.movement.fly", "system.attributes.movement.swim"
  ];
  const chosen = getChosenPacks();
  const packs = game.packs.filter(p => (p.documentName === "Actor") && p.visible)
    .filter(p => !chosen.size || chosen.has(p.collection))
    .sort((a, b) => (a.metadata.packageType === "system") - (b.metadata.packageType === "system"));
  const byName = new Map();
  for ( const pack of packs ) {
    for ( const entry of await pack.getIndex({ fields }) ) {
      const get = key => foundry.utils.getProperty(entry, key);
      const key = entry.name.toLowerCase();
      if ( (entry.type !== "npc") || (get("system.details.type.value") !== "beast") || byName.has(key) ) continue;
      byName.set(key, {
        uuid: entry.uuid,
        name: entry.name,
        img: entry.img,
        cr: get("system.details.cr") ?? 0,
        fly: (get("system.attributes.movement.fly") ?? 0) > 0,
        swim: (get("system.attributes.movement.swim") ?? 0) > 0,
        sourceLabel: pack.metadata.label
      });
    }
  }
  return beastIndex = sortForms(Array.from(byName.values()));
}

/**
 * @typedef {object} FormLimit
 * @property {number} cr      Highest challenge rating allowed.
 * @property {boolean} fly    Whether forms with a fly speed are allowed.
 * @property {boolean} swim   Whether forms with a swim speed are allowed.
 */

/**
 * Transformation limits from the transform activities on Wild Shape / Circle Forms. Features without
 * transform profiles (hand-made or imported ones) fall back to the Beast Shapes tables.
 * @param {Actor5e} actor  Original actor.
 * @returns {FormLimit[]}
 */
function getFormLimits(actor) {
  const limits = [];
  let circleProfiles = false;
  for ( const item of actor.items ) {
    if ( !FORM_ITEMS.has(item.identifier) ) continue;
    for ( const activity of item.system.activities?.getByType("transform") ?? [] ) {
      const rollData = activity.getRollData({ deterministic: true });
      for ( const profile of activity.availableProfiles ) {
        if ( profile.types.size && !profile.types.has("beast") ) continue;
        if ( item.identifier === "circle-forms" ) circleProfiles = true;
        limits.push({
          cr: profile.cr === "" ? Infinity : dnd5e.utils.simplifyBonus(profile.cr, rollData),
          fly: !profile.movement.has("fly"),
          swim: !profile.movement.has("swim")
        });
      }
    }
  }
  const [base, moon] = getTableLimits(actor);
  if ( !limits.length && base ) limits.push(base);
  if ( moon && !circleProfiles ) limits.push(moon);
  return limits;
}

/**
 * Beast Shapes table for the druid's level and rules, plus the Circle of the Moon row when it applies.
 * @param {Actor5e} actor  Original actor.
 * @returns {FormLimit[]}  Base limit and, for Moon druids, the Circle Forms limit.
 */
function getTableLimits(actor) {
  const level = actor.classes?.druid?.system.levels ?? 0;
  if ( level < 2 ) return [];
  const legacy = isLegacy(actor);
  let base;
  if ( level >= 8 ) base = { cr: 1, fly: true, swim: true };
  else if ( level >= 4 ) base = { cr: 0.5, fly: false, swim: true };
  else base = { cr: 0.25, fly: false, swim: !legacy };
  if ( !isMoonDruid(actor) ) return [base];
  // 2014 Circle Forms: CR 1 from 2nd level, druid level / 3 from 6th. 2024: druid level / 3 from 3rd.
  // Both keep the movement limits of the base table.
  const moonCR = legacy ? (level >= 6 ? Math.floor(level / 3) : 1) : Math.floor(level / 3);
  return [base, { ...base, cr: Math.max(base.cr, moonCR) }];
}

function isFormAllowed(form, limits) {
  if ( !limits.length ) return true;
  return limits.some(l => (form.cr <= l.cr) && (!form.fly || l.fly) && (!form.swim || l.swim));
}

/**
 * Summary of the limits for display: best CR overall and best CR for flying / swimming forms.
 * @param {FormLimit[]} limits
 * @returns {{ maxCR: string|null, maxFlyCR: string|null, maxSwimCR: string|null }}
 */
function describeLimits(limits) {
  const best = list => {
    const cr = Math.max(...list.map(l => l.cr));
    return Number.isFinite(cr) ? dnd5e.utils.formatCR(cr) : null;
  };
  return {
    maxCR: best(limits),
    maxFlyCR: best(limits.filter(l => l.fly)),
    maxSwimCR: best(limits.filter(l => l.swim))
  };
}

/**
 * @param {CharacterActorSheet} sheet
 * @returns {object}
 */
function prepareContext(sheet) {
  const actor = sheet.actor;
  const original = getOriginalActor(actor);
  const item = getWildShapeItem(original);
  const limits = getFormLimits(original);
  const uses = item?.system.uses;
  const legacy = isLegacy(original);
  const favorites = getFavorites(original);
  const owner = actor.isOwner;
  const transformed = actor.isPolymorphed;
  const noUses = !!uses?.max && (uses.value < 1);
  // Shown even without uses left: the button is disabled with a tooltip instead of disappearing.
  const canTransform = owner && !transformed;
  const forms = getKnownForms(original).map(f => {
    const allowed = isFormAllowed(f, limits);
    return {
      ...f,
      crLabel: dnd5e.utils.formatCR(f.cr),
      search: f.name.toLowerCase(),
      allowed,
      favorite: !legacy && favorites.has(f.uuid),
      canTransform: canTransform && allowed,
      canFavorite: owner && !legacy,
      canRemove: owner
    };
  }).sort((a, b) => b.favorite - a.favorite);

  // 2014: browse every eligible beast in the tab, grouped by CR.
  let beastGroups = null;
  let loading = false;
  if ( legacy && !transformed ) {
    if ( beastIndex ) beastGroups = groupByCR(original, beastIndex.filter(f => isFormAllowed(f, limits)), forms, {
      canTransform, canAdd: owner
    });
    else {
      loading = true;
      getBeastIndex().then(() => sheet.rendered && sheet.render());
    }
  }

  return {
    owner,
    transformed,
    currentForm: transformed ? actor.name : null,
    currentImg: actor.img,
    legacy,
    forms,
    maxKnown: getMaxKnown(original),
    uses: uses?.max ? { value: uses.value, max: uses.max } : null,
    noUses,
    beastGroups,
    beastCount: beastGroups?.reduce((n, g) => n + g.forms.length, 0) ?? 0,
    loading,
    search: beastSearch.get(original.uuid) ?? "",
    ...describeLimits(limits)
  };
}

/** Per-actor UI state for the beast browser, kept across sheet re-renders. */
const beastSearch = new Map();
const openCRGroups = new Map();

function getOpenGroups(actor) {
  if ( !openCRGroups.has(actor.uuid) ) openCRGroups.set(actor.uuid, new Set());
  return openCRGroups.get(actor.uuid);
}

/**
 * Group eligible beasts by challenge rating, skipping the ones already in the favorites list.
 * @param {Actor5e} actor        Original actor.
 * @param {object[]} beasts      Eligible beasts.
 * @param {object[]} favorites   Forms already listed in the tab.
 * @param {object} permissions
 * @param {boolean} permissions.canTransform  Whether the druid can transform right now.
 * @param {boolean} permissions.canAdd        Whether the user can add favorites.
 * @returns {object[]}
 */
function groupByCR(actor, beasts, favorites, { canTransform, canAdd }) {
  const listed = new Set(favorites.map(f => f.name.toLowerCase()));
  const open = getOpenGroups(actor);
  const groups = new Map();
  for ( const beast of beasts ) {
    if ( listed.has(beast.name.toLowerCase()) ) continue;
    if ( !groups.has(beast.cr) ) groups.set(beast.cr, {
      cr: beast.cr,
      crLabel: dnd5e.utils.formatCR(beast.cr),
      open: open.has(String(beast.cr)),
      forms: []
    });
    groups.get(beast.cr).forms.push({
      ...beast,
      crLabel: dnd5e.utils.formatCR(beast.cr),
      search: beast.name.toLowerCase(),
      allowed: true,
      canTransform,
      canAdd
    });
  }
  return Array.from(groups.values()).sort((a, b) => a.cr - b.cr);
}

/**
 * Search box and collapsible CR groups of the 2014 beast browser.
 * @param {HTMLElement} tab
 * @param {Actor5e} actor
 */
function bindBeastBrowser(tab, actor) {
  const original = getOriginalActor(actor);
  const open = getOpenGroups(original);
  const input = tab.querySelector(".wsh-beast-search");

  // Remember which groups the player opened, but not the ones opened by a search.
  for ( const details of tab.querySelectorAll(".wsh-cr-group") ) {
    details.addEventListener("toggle", () => {
      if ( input?.value.trim() ) return;
      if ( details.open ) open.add(details.dataset.cr);
      else open.delete(details.dataset.cr);
    });
  }

  const applySearch = () => {
    const query = input.value.trim().toLowerCase();
    beastSearch.set(original.uuid, input.value);
    for ( const card of tab.querySelectorAll(".wsh-searchable") ) {
      card.hidden = !!query && !card.dataset.search.includes(query);
    }
    for ( const details of tab.querySelectorAll(".wsh-cr-group") ) {
      const matches = details.querySelectorAll(".wsh-searchable:not([hidden])").length;
      details.hidden = !!query && !matches;
      details.open = query ? matches > 0 : open.has(details.dataset.cr);
    }
    tab.querySelector(".wsh-no-results")?.toggleAttribute("hidden",
      !query || !!tab.querySelector(".wsh-searchable:not([hidden])"));
  };
  if ( !input ) return;
  input.addEventListener("input", applySearch);
  if ( input.value ) applySearch();
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

async function onAction(actor, action, uuid) {
  switch ( action ) {
    case "transformInto": return wildShape(actor, uuid);
    case "add": return addBeast(getOriginalActor(actor), uuid);
    case "revert": return actor.revertOriginalForm();
    case "open": return (await fromUuid(uuid))?.sheet.render(true);
    case "remove": return removeForm(getOriginalActor(actor), uuid);
    case "favorite": return toggleFavorite(getOriginalActor(actor), uuid);
    case "manage": return FormsManager.open(getOriginalActor(actor));
  }
}

/**
 * Spend a Wild Shape use and transform.
 * @param {Actor5e} actor   Druid (not transformed).
 * @param {string} uuid     Form picked from the tab.
 */
async function wildShape(actor, uuid) {
  if ( actor.isPolymorphed ) return;
  if ( !game.user.isGM && !(game.settings.get("dnd5e", "allowPolymorphing") && game.user.can("ACTOR_CREATE")) ) {
    return ui.notifications.warn("WILDSHAPEHELPER.Warning.NoPermission", { localize: true });
  }
  const item = getWildShapeItem(actor);
  const uses = item.system.uses;
  if ( uses.max && (uses.value < 1) ) {
    return ui.notifications.warn("WILDSHAPEHELPER.Warning.NoUses", { localize: true });
  }

  const legacy = isLegacy(actor);
  const limits = getFormLimits(actor);
  const source = await fromUuid(uuid);
  if ( !source ) return ui.notifications.warn("WILDSHAPEHELPER.Warning.MissingForm", { localize: true });
  if ( !isFormAllowed(describeActor(source), limits) ) {
    return ui.notifications.warn("WILDSHAPEHELPER.Locked", { localize: true });
  }

  const settings = getTransformSettings(item, legacy);

  if ( uses.max ) await item.update({ "system.uses.spent": uses.spent + 1 });
  await ChatMessage.implementation.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${game.i18n.format("WILDSHAPEHELPER.Chat", {
      actor: Handlebars.escapeExpression(actor.name), form: Handlebars.escapeExpression(source.name)
    })}</p>`
  });
  return actor.transformInto(source, settings, { renderSheet: true });
}

/**
 * Form data stored for a creature: what the tab and the limits need.
 * @param {Actor5e} source
 * @returns {object}
 */
function describeActor(source) {
  return {
    uuid: source.uuid,
    name: source.name,
    img: source.img,
    cr: source.system.details.cr ?? 0,
    fly: (source.system.attributes.movement.fly ?? 0) > 0,
    swim: (source.system.attributes.movement.swim ?? 0) > 0
  };
}

/**
 * Transformation settings from the Wild Shape feature, or the system's wildshape preset.
 * The preset follows the 2024 rules, so for 2014 druids the beast's hit points replace the druid's:
 * no kept HP, no temporary HP, no Moon minimum AC and no spellcasting in beast form.
 * @param {Item5e} item       Wild Shape feature.
 * @param {boolean} legacy    Use the 2014 rules.
 * @returns {TransformationSetting}
 */
function getTransformSettings(item, legacy) {
  const { TransformationSetting } = dnd5e.dataModels.settings;
  const settings = item.system.activities.getByType("transform")[0]?.settings
    ?? new TransformationSetting({ ...CONFIG.DND5E.transformation.presets.wildshape.settings, preset: "wildshape" });
  if ( !legacy ) return settings;
  const data = settings.toObject();
  return new TransformationSetting({
    ...data,
    keep: data.keep.filter(k => !["hp", "tempHP", "spells"].includes(k)),
    spellLists: [],
    tempFormula: "",
    minimumAC: ""
  });
}

async function onDrop(event, actor) {
  const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  if ( data?.type !== "Actor" ) return;
  // Keep the sheet's default drop handler from opening the polymorph dialog.
  event.preventDefault();
  event.stopPropagation();
  const original = getOriginalActor(actor);
  if ( !original.isOwner ) return;
  const source = await fromUuid(data.uuid);
  if ( source?.type !== "npc" ) {
    return ui.notifications.warn("WILDSHAPEHELPER.Warning.NotNPC", { localize: true });
  }
  await addForm(original, describeActor(source));
  if ( original !== actor ) actor.sheet.render();
}

/**
 * Add a beast from the compendium index as a favorite (2014) from the tab's beast browser.
 * @param {Actor5e} actor  Original actor.
 * @param {string} uuid
 */
async function addBeast(actor, uuid) {
  const beast = (await getBeastIndex()).find(f => f.uuid === uuid);
  if ( beast ) await addForm(actor, beast);
}

async function addForm(actor, form) {
  const forms = (actor.getFlag(MODULE_ID, "forms") ?? []).filter(f => f.uuid !== form.uuid);
  const removed = (actor.getFlag(MODULE_ID, "removed") ?? []).filter(uuid => uuid !== form.uuid);
  forms.push({ uuid: form.uuid, name: form.name, img: form.img, cr: form.cr, fly: form.fly, swim: form.swim });
  await actor.update({ [`flags.${MODULE_ID}`]: { forms, removed } });
}

/**
 * Forget a known form. Builder forms can't be deleted from the builder's flag, so they are remembered as removed.
 */
async function removeForm(actor, uuid) {
  const forms = (actor.getFlag(MODULE_ID, "forms") ?? []).filter(f => f.uuid !== uuid);
  const removed = new Set(actor.getFlag(MODULE_ID, "removed") ?? []).add(uuid);
  const favorites = getFavorites(actor);
  favorites.delete(uuid);
  await actor.update({ [`flags.${MODULE_ID}`]: {
    forms, removed: Array.from(removed), favorites: Array.from(favorites)
  } });
}

/**
 * Known forms marked as favorites (2024 rules), listed first in the tab and the Wild Shape picker.
 * @param {Actor5e} actor  Original actor.
 * @returns {Set<string>}  Form UUIDs.
 */
function getFavorites(actor) {
  return new Set(actor.getFlag(MODULE_ID, "favorites") ?? []);
}

async function toggleFavorite(actor, uuid) {
  const favorites = getFavorites(actor);
  if ( !favorites.delete(uuid) ) favorites.add(uuid);
  await actor.setFlag(MODULE_ID, "favorites", Array.from(favorites));
}

/* -------------------------------------------- */
/*  Forms Manager                               */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Window to review the known forms and pick new ones from the beasts allowed at the druid's level.
 */
class FormsManager extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options={}) {
    super({ ...options, id: `${MODULE_ID}-manager-${actor.id}` });
    this.actor = actor;
    // Re-render whenever the actor changes, also when a form is removed from the sheet tab.
    actor.apps[this.id] = this;
  }

  _onClose(options) {
    super._onClose(options);
    delete this.actor.apps[this.id];
  }

  static DEFAULT_OPTIONS = {
    classes: ["dnd5e2", "wsh-manager"],
    window: { title: "WILDSHAPEHELPER.ManageForms", icon: "fas fa-paw", resizable: true },
    position: { width: 680, height: 620 },
    actions: {
      addForm: FormsManager.#onAddForm,
      removeForm: FormsManager.#onRemoveForm,
      openForm: FormsManager.#onOpenForm
    }
  };

  static PARTS = {
    body: { template: MANAGER_TEMPLATE, scrollable: [".wsh-column-list"] }
  };

  /**
   * Open the manager for an actor, reusing the window if it is already open.
   * @param {Actor5e} actor  Original actor.
   */
  static open(actor) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-manager-${actor.id}`);
    return (existing ?? new this(actor)).render({ force: true });
  }

  /** Current text in the search box, kept across re-renders. */
  #search = "";

  get title() {
    const key = isLegacy(this.actor) ? "ManageFavorites" : "ManageForms";
    return `${game.i18n.localize(`WILDSHAPEHELPER.${key}`)}: ${this.actor.name}`;
  }

  async _prepareContext(options) {
    const limits = getFormLimits(this.actor);
    const max = getMaxKnown(this.actor);
    const withLabels = f => ({ ...f, crLabel: dnd5e.utils.formatCR(f.cr), allowed: isFormAllowed(f, limits) });
    const known = getKnownForms(this.actor).map(withLabels);
    const knownUuids = new Set(known.map(f => f.uuid));
    const knownNames = new Set(known.map(f => f.name.toLowerCase()));
    const candidates = (await getBeastIndex())
      .filter(f => !knownUuids.has(f.uuid) && !knownNames.has(f.name.toLowerCase()) && isFormAllowed(f, limits))
      .map(f => ({ ...withLabels(f), search: f.name.toLowerCase() }));
    return {
      legacy: isLegacy(this.actor),
      known,
      candidates,
      max,
      full: !!max && (known.length >= max),
      search: this.#search,
      ...describeLimits(limits)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const input = this.element.querySelector(".wsh-search");
    input?.addEventListener("input", () => {
      this.#search = input.value;
      this.#applySearch();
    });
    this.#applySearch();
  }

  #applySearch() {
    const query = this.#search.trim().toLowerCase();
    for ( const row of this.element.querySelectorAll(".wsh-candidate") ) {
      row.hidden = !!query && !row.dataset.search.includes(query);
    }
  }

  async #findCandidate(target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    return (await getBeastIndex()).find(f => f.uuid === uuid);
  }

  static async #onAddForm(event, target) {
    const form = await this.#findCandidate(target);
    if ( !form ) return;
    const max = getMaxKnown(this.actor);
    if ( max && (getKnownForms(this.actor).length >= max) ) {
      return ui.notifications.warn("WILDSHAPEHELPER.Warning.TooManyForms", { localize: true });
    }
    await addForm(this.actor, form);
  }

  static async #onRemoveForm(event, target) {
    await removeForm(this.actor, target.closest("[data-uuid]")?.dataset.uuid);
  }

  static async #onOpenForm(event, target) {
    (await fromUuid(target.closest("[data-uuid]")?.dataset.uuid))?.sheet.render(true);
  }
}
