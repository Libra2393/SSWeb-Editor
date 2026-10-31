// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.

import { SaveFile, num } from "./codec.js";
import { loadFromServer, loadFromFiles, loadWith, addSection, applyVariants, formatFor, coverage, bitCoverage, enumEntries } from "./defs.js";
import { looksLikeSdExport, parseKey, readSdExport } from "./wiisd.js";
import { diffSlots } from "./compare.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
};
const hex = (n, w = 4) => "0x" + n.toString(16).toUpperCase().padStart(w, "0");

const state = {
  all: [], // one defs object per format in the manifest
  defs: null, // the format of the open file (the first format until one is opened)
  save: null,
  fileName: "wiiking2.sav",
  handle: null,
  slot: 0,
  tab: null,
  flagFilter: "",
  raw: { target: "slot", poke: { offset: "0x0000", type: "u8", value: "" } },
  coverageFilter: "all",
  compare: null, // { name, save, slot, hideNoise } while comparing with a second save
  variantWarnings: [],
  imported: null, // { from, titleId, skip } when the open save came out of a Wii SD export
};

// ---------------------------------------------------------------- startup

async function init() {
  try {
    // The standalone build (tools/build_standalone.py) embeds every definition file in the page, so it works
    // from disk with no server. The hosted version fetches defs/ as usual.
    const embedded = globalThis.SSWEB_EMBEDDED_DEFS;
    setDefs(embedded
      ? await loadWith(async (name) => {
          if (!(name in embedded)) throw new Error(`${name} is missing from this build`);
          return structuredClone(embedded[name]);
        })
      : await loadFromServer());
  } catch (e) {
    $("#defsStatus").innerHTML = "";
    $("#defsStatus").append(
      "Couldn't fetch defs/ (" + e.message + "). If you opened index.html straight from disk, either serve the folder ",
      el("code", {}, "python3 -m http.server"),
      " or ",
      el("button", { class: "link", onclick: () => $("#defsDirInput").click() }, "pick the defs folder"),
      "."
    );
  }
  wire();
}

function setDefs(all) {
  state.all = all;
  state.defs = (state.save && formatFor(all, state.save.bytes)) || all[0];
  $("#defsStatus").textContent = `Definitions: ${all.map((d) => d.format.label || d.layout.name).join(", ")} — ${all[0].sections.length} sections loaded.`;
  if (!state.tab) state.tab = state.defs.sections[0]?.id;
  renderWarnings();
  if (state.save) {
    // Re-wrap the current bytes with the new definitions, keeping the original for "changed" tracking.
    const s = new SaveFile(state.save.bytes.buffer, state.defs);
    s.original.set(state.save.original);
    state.save = s;
    renderAll();
  }
}

function wire() {
  $("#openBtn").onclick = openFile;
  $("#fileInput").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0], null);
  $("#saveBtn").onclick = saveInPlace;
  $("#downloadBtn").onclick = () => { const b = prepareBytes(); if (b) download(b, state.fileName); };
  $("#downloadOrigBtn").onclick = () => download(state.save.original, state.fileName.replace(/(\.sav)?$/, ".orig.sav"));
  $("#downloadSkipBtn").onclick = () => state.imported?.skip && download(state.imported.skip, "skip.dat");
  $("#fixAllBtn").onclick = () => {
    const fixed = state.save.updateChecksums({ all: true });
    toast(fixed.length ? `Recomputed ${fixed.length} checksum(s).` : "This format's checksum algorithm isn't known, so nothing was recomputed.", !fixed.length);
    renderAll();
  };
  $("#compareBtn").onclick = () => $("#compareInput").click();
  $("#compareInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) openComparison(file.name, await file.arrayBuffer());
  };
  $("#addDefBtn").onclick = () => $("#defFileInput").click();
  $("#defFileInput").onchange = async (e) => {
    for (const f of e.target.files) {
      try {
        const json = JSON.parse(await f.text());
        let sec;
        for (const d of state.all) sec = addSection(d, structuredClone(json), f.name);
        toast(`Added section “${sec.title || sec.id}” from ${f.name}`);
      } catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
    e.target.value = "";
    for (const d of state.all) d.variantState = null;
    renderWarnings();
    renderAll();
  };
  $("#pickDefsBtn").onclick = () => $("#defsDirInput").click();
  $("#defsDirInput").onchange = async (e) => {
    try { setDefs(await loadFromFiles(e.target.files)); toast("Definitions loaded."); }
    catch (err) { toast(err.message, true); }
    e.target.value = "";
  };
  for (const m of document.querySelectorAll(".menu")) m.addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") m.open = false; });

  document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
    if (!item) return;
    const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle().catch(() => null) : null;
    loadFile(item.getAsFile(), handle?.kind === "file" ? handle : null);
  });
  window.addEventListener("beforeunload", (e) => { if (hasUnsaved()) e.preventDefault(); });
}

// ---------------------------------------------------------------- file io

async function openFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: "Skyward Sword save or Wii SD export", accept: { "application/octet-stream": [".sav", ".bin"] } }] });
      return loadFile(await handle.getFile(), handle);
    } catch (e) { if (e.name === "AbortError") return; }
  }
  $("#fileInput").click();
}

async function loadFile(file, handle) {
  if (!state.all.length) return toast("Load the definitions first.", true);
  if (hasUnsaved() && !confirm("Discard unsaved changes?")) return;
  const buf = await file.arrayBuffer();
  if (!formatFor(state.all, new Uint8Array(buf)) && looksLikeSdExport(new Uint8Array(buf))) return importSdExport(new Uint8Array(buf), file.name);
  openBytes(buf, file.name, handle, null);
}

function openBytes(buf, name, handle, imported) {
  const file = { name };
  const defs = formatFor(state.all, new Uint8Array(buf));
  if (!defs) {
    const sizes = state.all.map((d) => `${num(d.layout.fileSize)} (${d.format.label || d.layout.name})`).join(" or ");
    return toast(`${file.name} is ${buf.byteLength} bytes; expected ${sizes}. Is it the raw, unencrypted save?`, true);
  }
  const { layout } = defs;
  const magic = gameIdOf(new Uint8Array(buf), layout);
  if (!layout.magic.values[magic] && !confirm(`Unrecognized header "${magic}" for ${defs.format.label}. Open anyway?`)) return;
  state.defs = defs;
  state.save = new SaveFile(buf, state.defs);
  state.fileName = file.name;
  // Safeguard: an imported save never keeps a handle, so Save can't write raw save data back over the
  // encrypted export. It always downloads a plain wiiking2.sav instead.
  state.handle = imported ? null : handle;
  state.imported = imported;
  state.compare = null;
  state.slot = firstUsedSlot();
  renderAll();
  const bad = badChecksums();
  toast(`Loaded ${file.name} as ${defs.format.label}` + (bad.length ? ` — checksum mismatch in ${bad.join(", ")}` : ""), bad.length > 0);
}

/**
 * Recomputes checksums of changed scopes and returns the bytes to write, or null if the user backs out
 * because a changed scope has a checksum the editor can't compute.
 */
function prepareBytes() {
  const unknown = [];
  state.defs.layout.checksums.forEach((cs) => {
    for (let n = 0; n < state.save.scopeCount(cs.scope); n++) {
      if (state.save.checksumValid(cs, n) === null && state.save.scopeChanged(cs.scope, n)) unknown.push(scopeLabel(cs.scope, n));
    }
  });
  if (unknown.length && !confirm(`The ${state.defs.format.label} checksum hasn't been worked out yet, so ${unknown.join(", ")} will keep the old checksum. ` +
    "The game may reject or reset that file. Keep a backup of the original. Save anyway?")) return null;
  state.save.updateChecksums();
  renderSlots();
  return state.save.bytes;
}

async function saveInPlace() {
  const bytes = prepareBytes();
  if (!bytes) return;
  if (!state.handle) return download(bytes, state.fileName);
  try {
    const w = await state.handle.createWritable();
    await w.write(bytes);
    await w.close();
    state.save.markSaved();
    renderAll();
    toast(`Saved ${state.fileName}`);
  } catch (e) {
    toast(`Couldn't write the file (${e.message}). Use “Download copy” instead.`, true);
  }
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- Wii SD export import

const SD_STORE = "ss-editor.sdKeys";

/**
 * Asks for the SD key/IV (never bundled) behind a US disclaimer, decrypts the export locally and opens the
 * wiiking2.sav inside it. Import only: there is deliberately no way back to an encrypted export.
 */
function importSdExport(bytes, name) {
  const dlg = $("#sdDialog"), form = $("#sdForm"), err = $("#sdError");
  $("#sdFileName").textContent = name;
  err.hidden = true;
  $("#sdOwn").checked = false;
  try {
    const saved = JSON.parse(localStorage.getItem(SD_STORE) || "null");
    $("#sdKey").value = saved?.key || "";
    $("#sdIv").value = saved?.iv || "";
    $("#sdRemember").checked = !!saved;
  } catch { /* storage unavailable: just ask */ }
  $("#sdCancel").onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    if (!$("#sdOwn").checked) return fail("Please confirm this is your own save.");
    const key = parseKey($("#sdKey").value), iv = parseKey($("#sdIv").value);
    if (!key || !iv) return fail("The key and the IV must each be 32 hexadecimal digits.");
    let out;
    try { out = await readSdExport(bytes, key, iv); } catch (ex) { return fail(ex.message); }
    const save = out.files.find((f) => f.name === "wiiking2.sav");
    if (!save) return fail(`This export (${out.titleId}) has no wiiking2.sav. It may be for a different game.`);
    try {
      if ($("#sdRemember").checked) localStorage.setItem(SD_STORE, JSON.stringify({ key: $("#sdKey").value.trim(), iv: $("#sdIv").value.trim() }));
      else localStorage.removeItem(SD_STORE);
    } catch { /* not remembered; fine */ }
    dlg.close();
    const skip = out.files.find((f) => f.name === "skip.dat")?.data || null;
    openBytes(save.data.slice().buffer, "wiiking2.sav", null, { from: name, titleId: out.titleId, skip });
    toast(`Imported wiiking2.sav (${out.titleId}) from ${name}. Saving downloads a raw wiiking2.sav for Dolphin; SD exports can't be re-created.`);
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- helpers

/** The game ID stored in the file header, e.g. "SOUE". */
function gameIdOf(bytes, layout = state.defs.layout) {
  const m = layout.magic;
  return String.fromCharCode(...bytes.subarray(num(m.offset), num(m.offset) + m.length));
}

/** Dolphin keeps each game's save under title/00010000/<game ID as hex>/data. */
const titleFolder = (id) => "title/00010000/" + [...id].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** Applies the definitions' variants for this format and game ID whenever they differ from the last ones applied. */
function syncVariants() {
  const keys = [state.defs.format.id, gameIdOf(state.save.bytes)];
  if (state.defs.variantState === keys.join("/")) return false;
  state.variantWarnings = applyVariants(state.defs, keys);
  renderWarnings();
  return true;
}

const hasUnsaved = () => {
  const s = state.save;
  return !!s && s.bytes.some((b, i) => b !== s.original[i]);
};

function summaryField(name) {
  const key = state.defs.layout.slotSummary?.[name];
  return key ? state.defs.fieldsById.get(key) : null;
}

function firstUsedSlot() {
  const empty = summaryField("empty");
  const n = state.save.scopeCount("slot");
  for (let i = 0; i < n; i++) if (!empty || !state.save.read(empty, i)) return i;
  return 0;
}

function badChecksums() {
  const out = [];
  state.defs.layout.checksums.forEach((cs) => {
    for (let n = 0; n < state.save.scopeCount(cs.scope); n++) {
      if (state.save.checksumValid(cs, n) === false) out.push(scopeLabel(cs.scope, n));
    }
  });
  return out;
}

const scopeLabel = (name, n) => {
  const s = state.defs.layout.scopes[name];
  return (s.labels?.[n] || s.label || name).replace("{n}", n + 1);
};

function fmtDuration(secs) {
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let toastTimer;
function toast(msg, warn = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (warn ? " warn" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), warn ? 7000 : 3500);
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  const loaded = !!state.save;
  $("#dropZone").hidden = loaded;
  $("#editor").hidden = !loaded;
  for (const id of ["#saveBtn", "#downloadBtn", "#downloadOrigBtn", "#fixAllBtn", "#compareBtn"]) $(id).disabled = !loaded;
  if (!loaded) return;
  syncVariants();
  const { layout, format } = state.defs;
  const magic = gameIdOf(state.save.bytes);
  const where = layout.platform === "wii" ? ` · ${magic} ${layout.magic.values[magic] || "(unknown region)"} · Dolphin folder ${titleFolder(magic)}` : "";
  const from = state.imported ? ` · imported from ${state.imported.from} (decrypted locally)` : "";
  $("#fileInfo").textContent = `${state.fileName} · ${format.label}${where}${from}` + (state.handle ? "" : " · Save will download");
  $("#downloadSkipBtn").hidden = !state.imported?.skip;
  $("#saveBtn").title = state.handle ? `Write back to ${state.fileName}` : "This browser can't write the file back, so Save downloads it";
  renderSlots();
  renderSlotTools();
  renderTabs();
  renderContent();
}

function renderSlots() {
  const nav = $("#slots");
  nav.replaceChildren();
  const { save } = state;
  const nameF = summaryField("name"), emptyF = summaryField("empty"), timeF = summaryField("playTime");
  const slotChecks = state.defs.layout.checksums.map((cs, i) => [cs, i]).filter(([cs]) => cs.scope === "slot");
  for (let i = 0; i < save.scopeCount("slot"); i++) {
    const empty = emptyF && save.read(emptyF, i);
    const states = slotChecks.map(([cs]) => save.checksumValid(cs, i));
    const ok = states.every((v) => v === true), unknown = states.some((v) => v === null);
    const changed = save.scopeChanged("slot", i);
    nav.append(
      el("button", {
        class: "slot" + (i === state.slot ? " active" : "") + (empty ? " empty" : ""),
        "aria-pressed": i === state.slot ? "true" : "false",
        onclick: () => { state.slot = i; renderAll(); },
      },
        el("span", { class: "slot-n" }, scopeLabel("slot", i)),
        el("span", { class: "slot-name" }, empty ? "Empty" : (nameF && save.read(nameF, i)) || "—"),
        el("span", { class: "slot-meta" },
          timeF && !empty ? fmtDuration(save.read(timeF, i)) : "",
          changed ? el("span", { class: "pill edit" }, "edited") : null,
          unknown ? el("span", { class: "pill", title: "This format's checksum algorithm hasn't been worked out" }, "checksum unknown")
            : changed ? el("span", { class: "pill" }, "checksum on save")
            : el("span", { class: "pill " + (ok ? "ok" : "bad") }, ok ? "checksum ok" : "checksum bad"),
        ),
      ),
    );
  }
}

function renderSlotTools() {
  const box = $("#slotTools");
  box.replaceChildren();
  const n = state.save.scopeCount("slot");
  const target = el("select", { "aria-label": "Copy to" },
    ...[...Array(n).keys()].filter((i) => i !== state.slot).map((i) => el("option", { value: i }, scopeLabel("slot", i))));
  box.append(
    el("span", { class: "muted" }, scopeLabel("slot", state.slot) + ":"),
    el("button", { class: "btn small", onclick: () => {
      if (!state.save.scopeChanged("slot", state.slot)) return toast("Nothing to revert.");
      state.save.revertScope("slot", state.slot); renderAll(); toast("Reverted to the loaded version.");
    } }, "Revert changes"),
    el("span", { class: "tool-sep" }),
    ...presetControls(),
    el("span", { class: "tool-sep" }),
    el("button", { class: "btn small", onclick: () => {
      const to = Number(target.value);
      if (!confirm(`Overwrite ${scopeLabel("slot", to)} with ${scopeLabel("slot", state.slot)}?`)) return;
      state.save.copyScope("slot", state.slot, to); state.slot = to; renderAll(); toast("Copied. The checksum is rewritten on save.");
    } }, "Copy to"),
    target,
  );
}

function presetControls() {
  const presets = (state.defs.presets || []).filter((p) => p.scope === "slot");
  if (!presets.length) return [];
  const pick = el("select", { "aria-label": "Preset" }, ...presets.map((p, i) => el("option", { value: i }, p.title || p.id)));
  return [
    el("span", { class: "tool-sep" }),
    el("button", { class: "btn small", title: "Overwrite parts of this file with a prepared starting state", onclick: () => applyPreset(presets[Number(pick.value)]) }, "Apply preset"),
    pick,
  ];
}

/** Writes every value a preset lists into the current slot. Checksums are updated on save as for any edit. */
function applyPreset(preset) {
  const where = scopeLabel("slot", state.slot);
  if (!confirm(`${preset.title}\n\n${preset.description || ""}\n\nApply to ${where}? Fields the preset lists are overwritten; everything else is kept. Use "Revert changes" to undo before saving.`)) return;
  const skipped = [];
  let written = 0;
  for (const entry of preset.apply || []) {
    const f = entry.field ? state.defs.fieldsById.get(entry.field) : entry.resolved;
    if (!f || f.invalid) { skipped.push(entry.field || entry.resolved?.flagRef || entry.resolved?.id); continue; }
    if (entry.onlyIfEmpty && state.save.read(f, state.slot)) continue;
    try { state.save.write(f, state.slot, entry.value); written++; }
    catch (e) { skipped.push(`${entry.field || f.flagRef}: ${e.message}`); }
  }
  renderAll();
  toast(`Applied “${preset.title}” to ${where}: ${written} values written` + (skipped.length ? `, ${skipped.length} skipped (${skipped.join(", ")})` : "") + ". Checksums update when you save.", skipped.length > 0);
}

function renderTabs() {
  const nav = $("#tabs");
  nav.replaceChildren();
  const tabs = [...state.defs.sections.map((s) => [s.id, s.title || s.id]), ["__raw", "Raw bytes"], ...(state.compare ? [["__compare", "Compare"]] : []), ...(state.defs.tracker ? [["__coverage", "Coverage"]] : [])];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = tabs[0][0];
  for (const [id, title] of tabs) {
    nav.append(el("button", {
      role: "tab", class: "tab" + (id === state.tab ? " active" : ""), "aria-selected": id === state.tab ? "true" : "false",
      onclick: () => { state.tab = id; renderTabs(); renderContent(); },
    }, title));
  }
}

function renderContent() {
  const c = $("#content");
  c.replaceChildren();
  if (state.tab === "__raw") return c.append(renderRaw());
  if (state.tab === "__coverage") return c.append(renderCoverage());
  if (state.tab === "__compare" && state.compare) return c.append(renderCompare());
  const section = state.defs.sections.find((s) => s.id === state.tab);
  if (!section) return;
  const isFlags = section.layout === "flags";
  if (section.description || isFlags) {
    const head = el("div", { class: "section-head" });
    if (section.description) head.append(el("p", { class: "muted" }, section.description));
    if (isFlags) {
      const input = el("input", { type: "search", placeholder: "Filter flags…", value: state.flagFilter, class: "filter",
        oninput: (e) => { state.flagFilter = e.target.value; applyFilter(c); } });
      head.append(input);
    }
    c.append(head);
  }
  const grid = el("div", { class: "groups" + (isFlags ? " flags" : "") });
  for (const g of section.groups) grid.append(renderGroup(g, isFlags));
  c.append(grid);
  if (isFlags) applyFilter(c);
}

function applyFilter(root) {
  const q = state.flagFilter.trim().toLowerCase();
  for (const card of root.querySelectorAll(".group")) {
    let any = false;
    for (const row of card.querySelectorAll(".field")) {
      const hit = !q || row.dataset.search.includes(q);
      row.hidden = !hit;
      any ||= hit;
    }
    card.hidden = !any;
  }
}

function renderGroup(g, isFlags) {
  const body = el("div", { class: "group-body", style: g.columns ? `--cols:${g.columns}` : null });
  const fields = (g.fields || []).filter((f) => (f.type === "row" ? f.fields?.some((k) => !k.invalid) : !f.invalid));
  if (!fields.length) return document.createDocumentFragment();
  for (const f of fields) body.append(renderField(f));
  const title = el("h3", {}, g.title || "");
  if (isFlags) {
    const count = el("span", { class: "count" });
    const update = () => { count.textContent = `${fields.filter((f) => state.save.read(f, state.slot)).length}/${fields.length}`; };
    update();
    body.addEventListener("change", update);
    title.append(count);
  }
  return el("div", { class: "group" + (g.columns ? " cols" : "") }, title, g.description ? el("p", { class: "muted small" }, g.description) : null, body);
}

function fieldTitle(f) {
  const bits = [f.description, f.flagRef, `${f.scope} + ${hex(num(f.offset))}`];
  if (f.mask != null) bits.push(`mask ${hex(num(f.mask), 2)}`);
  if (f.bits != null) bits.push(`bits ${num(f.shift ?? 0)}–${num(f.shift ?? 0) + num(f.bits) - 1} of ${f.type}`);
  return bits.filter(Boolean).join(" · ");
}

function renderField(f) {
  if (f.type === "row") {
    const kids = f.fields.filter((k) => !k.invalid);
    const row = el("div", { class: "field row-field", dataset: { search: (f.label || f.id).toLowerCase() } });
    row.append(
      el("span", { class: "label" }, f.label || f.id),
      el("span", { class: "row-controls" }, ...kids.map((k) => control(k, row, true))));
    markChanged(row, kids);
    return row;
  }
  const row = el("div", { class: "field", title: fieldTitle(f), dataset: { search: `${f.label || f.id} ${hex(num(f.offset))} ${f.flagRef || ""}`.toLowerCase() } });
  const ctl = control(f, row);
  if (f.type === "flag" || f.type === "bool") {
    row.classList.add("check");
    row.append(el("label", {}, ctl, el("span", {}, f.label || f.id)));
  } else {
    const id = "f_" + f.key.replace(/\W/g, "_");
    ctl.id = id;
    row.append(el("label", { for: id, class: "label" }, f.label || f.id, f.unit ? el("span", { class: "unit" }, f.unit) : null), ctl);
  }
  markChanged(row, [f]);
  return row;
}

function markChanged(row, fields) {
  const changed = fields.some((f) => !sameValue(state.save.read(f, state.slot), state.save.readOriginal(f, state.slot)));
  row.classList.toggle("changed", changed);
}
const sameValue = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** Builds the input for one field and wires it to write back into the save. */
function control(f, row, compact = false) {
  const { save } = state;
  const value = save.read(f, state.slot);
  const commit = (v) => {
    try { save.write(f, state.slot, v); }
    catch (e) { toast(e.message, true); return; }
    if (f.scope === "file") {
      const before = state.defs.variantState;
      renderAll();
      const id = gameIdOf(state.save.bytes);
      if (state.defs.variantState !== before && state.defs.layout.platform === "wii") toast(`Game ID is now ${id}. Dolphin reads this save from Wii/${titleFolder(id)}/data/, so put the saved file there.`);
      return;
    }
    markChanged(row, row.classList.contains("row-field") ? [...row.querySelectorAll("[data-key]")].map((n) => state.defs.fieldsById.get(n.dataset.key)) : [f]);
    renderSlots();
  };
  const tip = compact ? `${f.label || f.id} · ${fieldTitle(f)}` : null;

  if (f.type === "flag" || f.type === "bool") {
    return el("input", { type: "checkbox", checked: value, title: tip, "aria-label": compact ? f.label : null, dataset: { key: f.key },
      onchange: (e) => commit(e.target.checked) });
  }
  if (f.type === "string" && f.options) {
    const sel = el("select", { dataset: { key: f.key }, title: tip },
      ...Object.entries(f.options).map(([v, label]) => el("option", { value: v, selected: v === value }, label)));
    if (!(value in f.options)) sel.prepend(el("option", { value, selected: true }, `${value} (unknown)`));
    sel.onchange = (e) => commit(e.target.value);
    return sel;
  }
  if (f.type === "string") {
    const max = f.encoding?.startsWith("utf16") ? Math.floor(num(f.length) / 2) : num(f.length) - 1;
    return el("input", { type: "text", value, maxlength: max, spellcheck: "false", dataset: { key: f.key }, title: tip,
      onchange: (e) => commit(e.target.value) });
  }
  if (f.type === "duration") {
    return el("input", { type: "text", value: fmtDuration(value), pattern: "\\d+:\\d{1,2}:\\d{1,2}", placeholder: "h:mm:ss", dataset: { key: f.key }, title: tip,
      onchange: (e) => {
        const m = e.target.value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
        if (!m) return e.target.setCustomValidity("Use h:mm:ss"), e.target.reportValidity();
        e.target.setCustomValidity("");
        commit(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      } });
  }
  if (f.type === "wiitime") {
    return el("input", { type: "datetime-local", step: 1, value, dataset: { key: f.key }, title: tip,
      onchange: (e) => e.target.value && commit(e.target.value) });
  }
  if (f.enum) {
    const entries = enumEntries(state.defs, f.enum);
    const sel = el("select", { dataset: { key: f.key }, title: tip },
      ...entries.map(([v, label]) => el("option", { value: v, selected: v === value }, `${label}`)));
    if (!entries.some(([v]) => v === value)) sel.prepend(el("option", { value, selected: true }, `${hex(value, 2)} (unknown)`));
    sel.onchange = (e) => commit(Number(e.target.value));
    return sel;
  }
  if (f.type === "f32" || f.type === "f64") {
    return el("input", { type: "number", step: "any", value: Number.isFinite(value) ? Number(value.toPrecision(7)) : value, dataset: { key: f.key }, title: tip,
      onchange: (e) => e.target.value !== "" && commit(parseFloat(e.target.value)) });
  }
  // integers (optionally bit-packed)
  const { min, max } = save.range(f);
  if (f.hex) {
    return el("input", { type: "text", class: "mono", value: hex(value, fieldSizeDigits(f)), dataset: { key: f.key }, title: tip,
      onchange: (e) => {
        const v = num(e.target.value);
        if (!Number.isInteger(v) || v < min || v > max) return e.target.setCustomValidity(`${min}–${hex(max)}`), e.target.reportValidity();
        e.target.setCustomValidity("");
        commit(v);
      } });
  }
  return el("input", { type: "number", min, max, step: 1, value, class: compact ? "narrow" : null, dataset: { key: f.key }, title: tip, "aria-label": compact ? f.label : null,
    onchange: (e) => {
      const v = Number(e.target.value);
      if (!Number.isInteger(v) || v < min || v > max) return e.target.setCustomValidity(`Must be ${min}–${max}`), e.target.reportValidity();
      e.target.setCustomValidity("");
      commit(v);
    } });
}
const fieldSizeDigits = (f) => ({ u8: 2, s8: 2, u16: 4, s16: 4 }[f.type] || 8);

// ---------------------------------------------------------------- coverage tracker

const STATUS = {
  "in-editor": "In editor",
  partial: "Partly in editor",
  known: "Location known",
  research: "Needs research",
  "not-possible": "Not possible",
};

const popcount = (b) => { let n = 0; for (; b; b &= b - 1) n++; return n; };

/** A wishlist item is "in editor" when every field it lists exists for this format, "partial" when some do. */
function trackerStatus(item) {
  const fields = item.fields || [];
  if (fields.length) {
    const ok = fields.filter((k) => { const f = state.defs.fieldsById.get(k); return f && !f.invalid; }).length;
    if (ok === fields.length) return "in-editor";
    if (ok) return "partial";
  }
  return item.status || "known";
}

function renderCoverage() {
  const { tracker, layout, format } = state.defs;
  const wrap = el("div", { class: "coverage" });
  const regions = [...tracker.regions, ...(format.id === "hd" ? tracker.hdRegions || [] : [])];
  const masks = {};
  const maskFor = (scope) => (masks[scope] ||= bitCoverage(state.defs, scope));

  // --- totals
  const slotMask = maskFor("slot");
  const slotBits = slotMask.length * 8, slotCovered = slotMask.reduce((a, b) => a + popcount(b), 0);
  const items = tracker.items.map((it) => ({ ...it, s: trackerStatus(it) }));
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, items.filter((i) => i.s === k).length]));
  wrap.append(el("div", { class: "cov-summary" },
    el("div", { class: "cov-big" }, el("b", {}, `${((slotCovered / slotBits) * 100).toFixed(1)}%`), el("span", { class: "muted" }, `of each ${layout.scopes.slot.size}-byte save slot is described by a field (${slotCovered.toLocaleString()} of ${slotBits.toLocaleString()} bits)`)),
    el("div", { class: "cov-chips" }, ...Object.entries(STATUS).map(([k, label]) => el("span", { class: `chip st-${k}` }, `${counts[k]} ${label.toLowerCase()}`))),
  ));

  // --- save map
  const table = el("div", { class: "cov-regions" });
  for (const r of regions) {
    const m = maskFor(r.scope), a = num(r.start), z = num(r.end);
    let bits = 0;
    for (let i = a; i < z && i < m.length; i++) bits += popcount(m[i]);
    const pct = (bits / ((z - a) * 8)) * 100;
    table.append(el("div", { class: "cov-row", title: r.note || "" },
      el("span", { class: "cov-label" }, r.label),
      el("span", { class: "mono cov-range" }, `${hex(a)}–${hex(z - 1)}`),
      el("span", { class: "cov-bar", role: "img", "aria-label": `${pct.toFixed(0)}% covered` }, el("i", { style: `width:${Math.min(100, pct)}%` })),
      el("span", { class: "cov-pct" }, pct >= 99.95 ? "100%" : pct ? `${pct.toFixed(pct < 1 ? 2 : 1)}%` : "—")));
  }
  wrap.append(el("div", { class: "group" }, el("h3", {}, "Save map"),
    el("p", { class: "muted small" }, "Regions of a slot as named by the decompilation. Coverage counts the bits that some field in defs/ describes, so it rises automatically as definitions are added."),
    table));

  // --- wishlist
  const filter = el("select", { "aria-label": "Show", onchange: (e) => { state.coverageFilter = e.target.value; renderContent(); } },
    el("option", { value: "all", selected: state.coverageFilter === "all" }, "All statuses"),
    ...Object.entries(STATUS).map(([k, l]) => el("option", { value: k, selected: state.coverageFilter === k }, l)));
  const list = el("div", { class: "groups" });
  const cats = [...new Set(items.map((i) => i.category))];
  for (const cat of cats) {
    const rows = items.filter((i) => i.category === cat && (state.coverageFilter === "all" || i.s === state.coverageFilter));
    if (!rows.length) continue;
    list.append(el("div", { class: "group" }, el("h3", {}, cat),
      el("ul", { class: "wish" }, ...rows.map((i) => el("li", {},
        el("span", { class: `chip st-${i.s}` }, STATUS[i.s]),
        el("span", {}, i.title, i.note ? el("span", { class: "muted small wish-note" }, i.note) : null))))));
  }
  wrap.append(el("div", { class: "section-head" },
    el("p", { class: "muted" }, "What players are likely to want to edit. Items with fields are ticked off automatically; the rest are tracked in defs/tracker.json."),
    filter), list);
  return wrap;
}

// ---------------------------------------------------------------- compare two saves

/** Loads a second save of the same format to compare against the open one. */
function openComparison(name, buf) {
  const defs = formatFor(state.all, new Uint8Array(buf));
  if (!defs || defs.format.id !== state.defs.format.id) {
    return toast(`${name} isn't a ${state.defs.format.label} save, so it can't be compared with this one.`, true);
  }
  state.compare = { name, save: new SaveFile(buf, state.defs), slot: state.slot, hideNoise: true };
  state.tab = "__compare";
  renderTabs();
  renderContent();
}

const fmtValue = (v) => typeof v === "boolean" ? (v ? "on" : "off")
  : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v === "" ? "(empty)" : String(v);

function renderCompare() {
  const cmp = state.compare;
  const wrap = el("div", { class: "compare" });
  const slotPick = el("select", { "aria-label": "Slot in the other save", onchange: (e) => { cmp.slot = Number(e.target.value); renderContent(); } },
    ...[...Array(cmp.save.scopeCount("slot")).keys()].map((i) => el("option", { value: i, selected: i === cmp.slot }, scopeLabel("slot", i))));
  const noise = el("input", { type: "checkbox", checked: cmp.hideNoise, onchange: (e) => { cmp.hideNoise = e.target.checked; renderContent(); } });
  wrap.append(el("div", { class: "group cmp-head" },
    el("div", {}, el("b", {}, `${state.fileName} · ${scopeLabel("slot", state.slot)}`), el("span", { class: "muted" }, "  (this file, “before”)  →  "),
      el("b", {}, cmp.name), " ", slotPick, el("span", { class: "muted" }, "  (“after”)")),
    el("div", { class: "cmp-tools" },
      el("label", { class: "check" }, noise, el("span", {}, "Hide noise (play time, save time, positions, facing, checksum)")),
      el("button", { class: "btn small", onclick: () => { state.compare = null; state.tab = state.defs.sections[0].id; renderTabs(); renderContent(); } }, "Close comparison"))));

  const d = diffSlots(state.defs, state.save, state.slot, cmp.save, cmp.slot, { hideNoise: cmp.hideNoise });
  const where = (w) => w.stage ? `${w.stage}${w.room != null ? `, room ${w.room}` : ""}` : "no location";
  wrap.append(el("p", { class: "muted" },
    `Location: ${where(d.location.a)} → ${where(d.location.b)}. Play time ${fmtDuration(d.location.a.playTime || 0)} → ${fmtDuration(d.location.b.playTime || 0)}.`,
    cmp.hideNoise && d.noiseBytes ? ` ${d.noiseBytes} noise bytes hidden.` : ""));

  if (!d.known.length && !d.unknown.length) {
    wrap.append(el("div", { class: "group" }, el("p", {}, "No differences in this slot", cmp.hideNoise ? " apart from noise." : ".")));
    return wrap;
  }

  const table = (title, note, rows) => el("div", { class: "group" }, el("h3", {}, title), note ? el("p", { class: "muted small" }, note) : null,
    el("div", { class: "cmp-table", role: "table" }, ...rows));
  if (d.known.length) {
    wrap.append(table(`Known values that changed (${d.known.length})`, null, d.known.map((k) =>
      el("div", { class: "cmp-row", role: "row" },
        el("span", { class: "cmp-what" }, k.labels.join(" · ")),
        el("span", { class: "cmp-val mono" }, fmtValue(k.from), el("span", { class: "muted" }, " → "), el("b", {}, fmtValue(k.to))),
        el("span", { class: "muted small cmp-region" }, k.region)))));
  }
  if (d.unknown.length) {
    wrap.append(table(`Not in the editor yet (${d.unknown.length})`,
      "Changed bits no field describes. Flags are decoded with the game's own flag tables. “Copy definition” puts ready-made JSON on the clipboard: add a label and paste it into a section file in defs/.",
      d.unknown.map((u) => el("div", { class: "cmp-row", role: "row" },
        el("span", { class: "cmp-what" }, el("span", { class: "chip st-known" }, u.kind), " ", u.title,
          el("span", { class: "muted small wish-note" }, u.detail)),
        el("span", { class: "cmp-val mono" }, fmtValue(u.from), el("span", { class: "muted" }, " → "), el("b", {}, fmtValue(u.to))),
        el("span", { class: "muted small cmp-region" }, u.region, " ",
          el("button", { class: "btn small", onclick: () => copyDefinition({ ...u.suggestion, label: u.detail !== "no description yet" ? u.detail : "" }) }, "Copy definition"))))));
  }
  return wrap;
}

async function copyDefinition(def) {
  const text = JSON.stringify(def);
  try { await navigator.clipboard.writeText(text); toast("Definition copied. Give it a label and add it to a section in defs/."); }
  catch { window.prompt("Copy this definition:", text); }
}

// ---------------------------------------------------------------- raw view

function rawTargets() {
  const { scopes } = state.defs.layout;
  const out = [{ id: "slot", label: scopeLabel("slot", state.slot), scope: "slot", index: state.slot, size: num(scopes.slot.size) }];
  out.push({ id: "header", label: "Header", scope: "file", index: 0, size: num(scopes.slot.base) });
  for (const [name, s] of Object.entries(scopes)) {
    if (name === "slot" || name === "file") continue;
    for (let i = 0; i < num(s.count ?? 1); i++) out.push({ id: `${name}:${i}`, label: scopeLabel(name, i), scope: name, index: i, size: num(s.size) });
  }
  return out;
}

function renderRaw() {
  const targets = rawTargets();
  const t = targets.find((x) => x.id === state.raw.target) || targets[0];
  const { save } = state;
  const base = save.scopeBase(t.scope, t.index);
  const cov = coverage(state.defs, t.scope);
  const known = [...Array(t.size).keys()].filter((i) => cov.has(i)).length;

  const wrap = el("div", { class: "raw" });
  const picker = el("select", { onchange: (e) => { state.raw.target = e.target.value; renderContent(); } },
    ...targets.map((x) => el("option", { value: x.id, selected: x.id === t.id }, x.label)));
  wrap.append(el("div", { class: "raw-head" },
    picker,
    el("span", { class: "muted" }, `file offset ${hex(base)} · ${hex(t.size)} bytes · ${known} bytes described by definitions (${((known / t.size) * 100).toFixed(1)}%)`),
    el("span", { class: "legend" }, el("i", { class: "b known" }), "defined", el("i", { class: "b changed" }), "changed", el("i", { class: "b sum" }), "checksum"),
  ));

  // Poke tool: read/write any type at any offset, for exploring unknown bytes.
  const p = state.raw.poke;
  const offIn = el("input", { class: "mono", value: p.offset, size: 8, "aria-label": "Offset", oninput: (e) => (p.offset = e.target.value) });
  const typeIn = el("select", { "aria-label": "Type", onchange: (e) => (p.type = e.target.value) },
    ...["u8", "u16", "u32", "s8", "s16", "s32", "f32", "u64"].map((x) => el("option", { selected: x === p.type }, x)));
  const valIn = el("input", { class: "mono", value: p.value, size: 14, "aria-label": "Value", oninput: (e) => (p.value = e.target.value) });
  const tmpField = () => ({ type: p.type, offset: p.offset, scope: t.scope });
  const inRange = () => { const o = num(p.offset); return Number.isInteger(o) && o >= 0 && o < t.size; };
  wrap.append(el("div", { class: "poke" },
    el("b", {}, "Inspect"), offIn, typeIn,
    el("button", { class: "btn small", onclick: () => {
      if (!inRange()) return toast("Offset out of range.", true);
      const v = save.read(tmpField(), t.index);
      p.value = String(v); valIn.value = p.value;
      if (p.type !== "f32") valIn.value = p.value = `${v} (${hex(Number(v), 2)})`;
    } }, "Read"),
    valIn,
    el("button", { class: "btn small", onclick: () => {
      if (!inRange()) return toast("Offset out of range.", true);
      const raw = p.value.split(" ")[0];
      const v = p.type === "f32" ? parseFloat(raw) : num(raw);
      if (Number.isNaN(v)) return toast("Not a number.", true);
      save.write(tmpField(), t.index, v);
      renderSlots(); renderContent();
    } }, "Write"),
  ));

  const lines = [];
  for (let row = 0; row < t.size; row += 16) {
    const cells = [], ascii = [];
    for (let i = row; i < Math.min(row + 16, t.size); i++) {
      const b = save.bytes[base + i];
      const who = cov.get(i);
      let cls = "b";
      if (who) cls += who[0].endsWith("checksum") ? " sum" : " known";
      if (b !== save.original[base + i]) cls += " changed";
      cells.push(el("span", { class: cls, dataset: { o: i }, title: `${hex(i)} (file ${hex(base + i)})${who ? " — " + who.join(", ") : ""}` }, b.toString(16).padStart(2, "0")));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");
    }
    lines.push(el("div", { class: "hx" }, el("span", { class: "ofs" }, hex(row)), el("span", { class: "bytes" }, cells), el("span", { class: "asc" }, ascii.join(""))));
  }
  const dump = el("div", { class: "dump", onclick: (e) => {
    const o = e.target.dataset?.o;
    if (o == null) return;
    p.offset = hex(Number(o)); offIn.value = p.offset;
  } }, lines);
  wrap.append(dump);
  return wrap;
}

function renderWarnings() {
  const w = [...new Set(state.all.flatMap((d) => d.warnings.map((m) => (state.all.length > 1 ? `[${d.format.id}] ` : "") + m))), ...state.variantWarnings];
  const box = $("#warnings");
  box.hidden = !w.length;
  box.querySelector("summary").textContent = `${w.length} definition warning(s)`;
  box.querySelector("ul").replaceChildren(...w.map((m) => el("li", {}, m)));
}

// Exposed for debugging from the console.
window.ssEditor = {
  state,
  loadBuffer: (buf, name = "wiiking2.sav") => loadFile(new File([buf], name), null),
  compareBuffer: (buf, name = "other.sav") => openComparison(name, buf),
};

init();
