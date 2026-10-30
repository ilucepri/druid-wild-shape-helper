const MODULE_ID = "druid-wild-shape-helper";
const BUILDER_ID = "dnd5e-character-builder";
const TAB_ID = "wildShape";
const TEMPLATE = `modules/${MODULE_ID}/templates/wild-shape-tab.hbs`;
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
  foundry.applications.handlebars.loadTemplates([TEMPLATE]);
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
 * Known forms chosen in the character builder plus forms dropped onto the tab.
 * @param {Actor5e} actor  Original actor.
 * @returns {object[]}
 */
function getKnownForms(actor) {
  const builder = getWildShapeItem(actor)?.getFlag(BUILDER_ID, "knownWildShapeForms") ?? [];
  const custom = actor.getFlag(MODULE_ID, "forms") ?? [];
  const forms = new Map();
  for ( const f of builder ) forms.set(f.uuid, { ...f, removable: false });
  for ( const f of custom ) if ( !forms.has(f.uuid) ) forms.set(f.uuid, { ...f, removable: true });
  return Array.from(forms.values()).sort((a, b) => (a.cr - b.cr) || a.name.localeCompare(b.name));
}

/**
 * Transformation limits from the transform activities on Wild Shape / Circle Forms (CR cap and flying).
 * @param {Actor5e} actor  Original actor.
 * @returns {{ cr: number, fly: boolean }[]}
 */
function getFormLimits(actor) {
  const limits = [];
  for ( const item of actor.items ) {
    if ( !FORM_ITEMS.has(item.identifier) ) continue;
    for ( const activity of item.system.activities?.getByType("transform") ?? [] ) {
      const rollData = activity.getRollData({ deterministic: true });
      for ( const profile of activity.availableProfiles ) {
        if ( profile.types.size && !profile.types.has("beast") ) continue;
        limits.push({
          cr: profile.cr === "" ? Infinity : dnd5e.utils.simplifyBonus(profile.cr, rollData),
          fly: !profile.movement.has("fly")
        });
      }
    }
  }
  return limits;
}

function isFormAllowed(form, limits) {
  if ( !limits.length ) return true;
  return limits.some(l => (form.cr <= l.cr) && (!form.fly || l.fly));
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
  const maxCR = Math.max(...limits.map(l => l.cr));
  const maxFlyCR = Math.max(...limits.filter(l => l.fly).map(l => l.cr));
  return {
    owner: actor.isOwner,
    transformed: actor.isPolymorphed,
    currentForm: actor.isPolymorphed ? actor.name : null,
    currentImg: actor.img,
    forms,
    maxKnown: original.system.scale?.druid?.["known-forms"]?.value ?? null,
    uses: uses?.max ? { value: uses.value, max: uses.max } : null,
    canUse: forms.some(f => f.allowed) && (!uses?.max || (uses.value > 0)),
    maxCR: Number.isFinite(maxCR) ? dnd5e.utils.formatCR(maxCR) : null,
    maxFlyCR: Number.isFinite(maxFlyCR) ? dnd5e.utils.formatCR(maxFlyCR) : null
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

  const limits = getFormLimits(actor);
  const forms = getKnownForms(actor).filter(f => isFormAllowed(f, limits));
  const uuid = await chooseForm(forms);
  if ( !uuid ) return;
  const source = await fromUuid(uuid);
  if ( !source ) return ui.notifications.warn("WILDSHAPEHELPER.Warning.MissingForm", { localize: true });

  const settings = item.system.activities.getByType("transform")[0]?.settings
    ?? new dnd5e.dataModels.settings.TransformationSetting({
      ...CONFIG.DND5E.transformation.presets.wildshape.settings, preset: "wildshape"
    });

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
 * Prompt the player to pick one of the known forms.
 * @param {object[]} forms
 * @returns {Promise<string|null>}  UUID of the selected form.
 */
async function chooseForm(forms) {
  const esc = Handlebars.escapeExpression;
  const content = `<div class="wsh-choices">${forms.map((f, i) => `
    <label class="wsh-choice">
      <input type="radio" name="form" value="${esc(f.uuid)}" ${i === 0 ? "checked" : ""}>
      <img src="${esc(f.img)}" alt="">
      <span class="wsh-choice-name">${esc(f.name)}</span>
      <span class="wsh-choice-cr">${game.i18n.localize("WILDSHAPEHELPER.CR")} ${dnd5e.utils.formatCR(f.cr)}
        ${f.fly ? '<i class="fas fa-feather" inert></i>' : ""}</span>
    </label>`).join("")}</div>`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "WILDSHAPEHELPER.ChooseForm", icon: "fas fa-paw" },
    classes: ["wsh-dialog"],
    content,
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
  const forms = original.getFlag(MODULE_ID, "forms") ?? [];
  if ( forms.some(f => f.uuid === source.uuid) ) return;
  forms.push({
    uuid: source.uuid,
    name: source.name,
    img: source.img,
    cr: source.system.details.cr ?? 0,
    fly: (source.system.attributes.movement.fly ?? 0) > 0
  });
  await original.setFlag(MODULE_ID, "forms", forms);
  if ( original !== actor ) actor.sheet.render();
}

async function removeForm(actor, uuid) {
  const forms = (actor.getFlag(MODULE_ID, "forms") ?? []).filter(f => f.uuid !== uuid);
  await actor.setFlag(MODULE_ID, "forms", forms);
}
