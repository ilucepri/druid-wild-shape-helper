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

  Sheet.TABS.push({ tab: TAB_ID, label: "WILDSHAPEHELPER.Tab", icon: "fas fa-paw", condition: hasWildShape });
  foundry.applications.handlebars.loadTemplates([TEMPLATE, MANAGER_TEMPLATE]);
});

Hooks.on("dnd5e.prepareSheetContext", (sheet, partId, context) => {
  if ( partId === TAB_ID ) context.wildShape = prepareContext(sheet.actor);
});

Hooks.on("renderCharacterActorSheet", (sheet, element) => {
  const tab = element.querySelector(`.tab[data-tab="${TAB_ID}"]`);
  // Partial renders keep the existing tab element, so only bind once per element.
  if ( !tab || tab.dataset.wshBound ) return;
  tab.dataset.wshBound = "true";
  tab.querySelectorAll("[data-wsh-action]").forEach(el => el.addEventListener("click", event => {
    event.preventDefault();
    onAction(sheet.actor, el.dataset.wshAction, el.closest("[data-uuid]")?.dataset.uuid);
  }));
  tab.addEventListener("drop", event => onDrop(event, sheet.actor));
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
 * Every Beast in the Actor compendiums the user can see, one entry per name (module packs win over the system's).
 * @returns {Promise<object[]>}
 */
async function getBeastIndex() {
  if ( beastIndex ) return beastIndex;
  const fields = [
    "img", "system.details.cr", "system.details.type.value",
    "system.attributes.movement.fly", "system.attributes.movement.swim"
  ];
  const packs = game.packs.filter(p => (p.documentName === "Actor") && p.visible)
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

function prepareContext(actor) {
  const original = getOriginalActor(actor);
  const item = getWildShapeItem(original);
  const limits = getFormLimits(original);
  const uses = item?.system.uses;
  const forms = getKnownForms(original).map(f => ({
    ...f,
    crLabel: dnd5e.utils.formatCR(f.cr),
    allowed: isFormAllowed(f, limits)
  }));
  const legacy = isLegacy(original);
  return {
    owner: actor.isOwner,
    transformed: actor.isPolymorphed,
    currentForm: actor.isPolymorphed ? actor.name : null,
    currentImg: actor.img,
    legacy,
    forms,
    maxKnown: getMaxKnown(original),
    uses: uses?.max ? { value: uses.value, max: uses.max } : null,
    // 2014 druids can pick any eligible beast, not only their favorites.
    canUse: (legacy || forms.some(f => f.allowed)) && (!uses?.max || (uses.value > 0)),
    ...describeLimits(limits)
  };
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

async function onAction(actor, action, uuid) {
  switch ( action ) {
    case "transform": return wildShape(actor);
    case "revert": return actor.revertOriginalForm();
    case "open": return (await fromUuid(uuid))?.sheet.render(true);
    case "remove": return removeForm(getOriginalActor(actor), uuid);
    case "manage": return FormsManager.open(getOriginalActor(actor));
  }
}

async function wildShape(actor) {
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
  const favorites = getKnownForms(actor).filter(f => isFormAllowed(f, limits));
  let others = [];
  if ( legacy ) {
    // 2014: any beast the druid has seen, so offer every eligible beast after the favorites.
    const favoriteNames = new Set(favorites.map(f => f.name.toLowerCase()));
    others = (await getBeastIndex()).filter(f => !favoriteNames.has(f.name.toLowerCase()) && isFormAllowed(f, limits));
  }
  const uuid = await chooseForm(favorites, others);
  if ( !uuid ) return;
  const source = await fromUuid(uuid);
  if ( !source ) return ui.notifications.warn("WILDSHAPEHELPER.Warning.MissingForm", { localize: true });

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

/**
 * Prompt the player to pick a form: favorites / known forms first, then any other eligible beast.
 * @param {object[]} forms     Known or favorite forms.
 * @param {object[]} [others]  Other eligible beasts (2014 rules).
 * @returns {Promise<string|null>}  UUID of the selected form.
 */
async function chooseForm(forms, others=[]) {
  const esc = Handlebars.escapeExpression;
  const localize = key => game.i18n.localize(`WILDSHAPEHELPER.${key}`);
  const row = (f, checked) => `
    <label class="wsh-choice" data-search="${esc(f.name.toLowerCase())}">
      <input type="radio" name="form" value="${esc(f.uuid)}" ${checked ? "checked" : ""}>
      <img src="${esc(f.img)}" alt="">
      <span class="wsh-choice-name">${esc(f.name)}</span>
      <span class="wsh-choice-cr">${localize("CR")} ${dnd5e.utils.formatCR(f.cr)}
        ${f.fly ? '<i class="fas fa-feather" inert></i>' : ""}
        ${f.swim ? '<i class="fas fa-water" inert></i>' : ""}</span>
    </label>`;
  let content = "";
  if ( others.length ) content += `<input type="search" class="wsh-search" placeholder="${esc(localize("Search"))}"
    aria-label="${esc(localize("Search"))}">`;
  content += `<div class="wsh-choices">`;
  if ( forms.length && others.length ) content += `<h4 class="wsh-choice-group">${esc(localize("Favorites"))}</h4>`;
  content += forms.map((f, i) => row(f, i === 0)).join("");
  if ( forms.length && others.length ) content += `<h4 class="wsh-choice-group">${esc(localize("OtherBeasts"))}</h4>`;
  content += others.map((f, i) => row(f, !forms.length && (i === 0))).join("");
  content += "</div>";

  return foundry.applications.api.DialogV2.prompt({
    window: { title: "WILDSHAPEHELPER.ChooseForm", icon: "fas fa-paw" },
    classes: ["wsh-dialog"],
    position: { width: 420 },
    content,
    render: (event, dialog) => {
      const element = dialog?.element ?? event?.target?.element;
      const input = element?.querySelector(".wsh-search");
      input?.addEventListener("input", () => {
        const query = input.value.trim().toLowerCase();
        for ( const choice of element.querySelectorAll(".wsh-choice") ) {
          choice.hidden = !!query && !choice.dataset.search.includes(query);
        }
      });
    },
    ok: {
      label: "WILDSHAPEHELPER.WildShape",
      icon: "fas fa-paw",
      callback: (event, button) => button.form.elements.form?.value ?? null
    },
    rejectClose: false
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
  await addForm(original, {
    uuid: source.uuid,
    name: source.name,
    img: source.img,
    cr: source.system.details.cr ?? 0,
    fly: (source.system.attributes.movement.fly ?? 0) > 0,
    swim: (source.system.attributes.movement.swim ?? 0) > 0
  });
  if ( original !== actor ) actor.sheet.render();
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
  await actor.update({ [`flags.${MODULE_ID}`]: { forms, removed: Array.from(removed) } });
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
