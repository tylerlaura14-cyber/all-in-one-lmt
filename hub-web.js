/* My Hub inside All in One: gives the hub apps (Mind Tracker, Workout, Fresh Start) the same
   "window.claude" tools they had in the My Hub Mac app, but every save goes into All in One's own
   document storage (IndexedDB). There, sync.js sends it to Google Drive with everything else.

   Each hub document is one stored item:   { id: "hub:<path>", hub: "db", path, data, savedAt }
   Each hub photo or file is one item:     { id: "hubfile:<id>", hub: "file", dataUrl, contentType, sizeBytes, createdAt }
   The medical screens, the Recycle Bin and Ask Claude never see items marked "hub". */
(() => {
  "use strict";
  const P = window.parent !== window ? window.parent : null;
  // Only works inside All in One (it owns the storage and the sync)
  if (!P || typeof P.saveDocToDB !== "function") {
    try { location.replace("index.html#hub"); } catch (e) {}
    return;
  }

  /* ---------- look: My Hub copies the medical side's light/dark mode, color theme and background pictures ---------- */
  // All in One's colors are CSS variables on its <html> (--bg, --card, --accent…); the hub apps read them as --aio-*.
  const LOOK = { bg: "--bg", card: "--card", input: "--input", sunk: "--raised", text: "--text", muted: "--muted", line: "--border",
    btn: "--accent", "on-btn": "--on-accent", "soft-btn": "--accent", header: "--raised", side: "--card", "side-ink": "--text",
    "side-muted": "--muted", "side-hi": "--raised-2" };
  function syncLook() {
    try {
      const pd = P.document.documentElement, de = document.documentElement, cs = P.getComputedStyle(pd);
      for (const [k, name] of Object.entries(LOOK)) {
        const v = cs.getPropertyValue(name).trim();
        if (v) de.style.setProperty("--aio-" + k, v); else de.style.removeProperty("--aio-" + k);
      }
      de.setAttribute("data-theme", pd.classList.contains("dark") ? "dark" : "light");
      // Background pictures: same on/off and strength as the medical side's watermark setting
      const wm = P.document.getElementById("medicalWatermarkBg");
      if (wm && wm.style.display === "none") de.style.setProperty("--aio-watermark", "0");
      else if (wm && wm.style.opacity) de.style.setProperty("--aio-watermark", wm.style.opacity);
      else de.style.removeProperty("--aio-watermark");
      window.dispatchEvent(new Event("aio-look"));
    } catch (e) {}
  }
  syncLook();
  try {
    const lookWatch = new P.MutationObserver(() => syncLook());
    lookWatch.observe(P.document.documentElement, { attributes: true, attributeFilter: ["class", "data-color-theme", "style"] });
    const wm = P.document.getElementById("medicalWatermarkBg");
    if (wm) lookWatch.observe(wm, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("pagehide", () => lookWatch.disconnect());
  } catch (e) {}

  const DOC_PREFIX = "hub:";
  const FILE_PREFIX = "hubfile:";
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function checkPath(path, wantEven) {
    if (typeof path !== "string" || !path) throw new TypeError("Path must be a non-empty string");
    const segs = path.split("/");
    for (const s of segs) if (!SEG.test(s) || s === "." || s === "..") throw new TypeError(`Bad path segment in "${path}"`);
    if ((segs.length % 2 === 0) !== wantEven) throw new TypeError(`${wantEven ? "Document" : "Collection"} path "${path}" has ${segs.length} segments`);
    return segs;
  }
  const dbErr = (code, message) => Object.assign(new Error(message), { code });
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const later = fn => setTimeout(fn, 0);
  const newId = () => {
    const a = new Uint8Array(10); crypto.getRandomValues(a);
    return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("") + Date.now().toString(36);
  };
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });

  /* ---------- reading All in One's storage ---------- */
  async function readHubItems() {
    if (typeof P.invalidateDocsCache === "function") P.invalidateDocsCache();
    const all = await P.readAllStoredDocs();
    if (all === null) throw dbErr("unavailable", "Could not read saved data on this device");
    return all.filter(d => d && d.hub);
  }

  /* ---------- the store: every document in memory, written through to storage ---------- */
  const docs = new Map();   // path -> body
  const seen = new Map();   // path -> JSON of the body as last saved/read (to spot changes from sync)
  let loaded = null;
  const load = () => loaded || (loaded = readHubItems().then(items => {
    for (const d of items) if (d.hub === "db" && typeof d.path === "string" && d.data && typeof d.data === "object") {
      docs.set(d.path, d.data); seen.set(d.path, JSON.stringify(d.data));
    }
  }).catch(e => { loaded = null; throw e; }));
  const listeners = new Set();
  const parentOf = p => p.slice(0, p.lastIndexOf("/"));
  // Writes go to storage one at a time, in order
  let chain = Promise.resolve();
  let pending = 0;
  let writes = 0;
  let reloadWanted = false; // a reload was put off because a save was running
  function persist(path, body) {
    pending++; writes++;
    const json = body === undefined ? null : JSON.stringify(body);
    const p = chain.then(async () => {
      // Looked up at each call: sync.js wraps these to notice the change and send it to Drive
      const ok = json === null
        ? await P.deleteDocFromDB(DOC_PREFIX + path)
        : await P.saveDocToDB({ id: DOC_PREFIX + path, hub: "db", path, data: JSON.parse(json), savedAt: Date.now() });
      if (ok === false) throw new Error(json === null ? "delete failed" : "this device may be out of storage space");
      if (json === null) seen.delete(path); else seen.set(path, json);
    });
    chain = p.catch(() => {}).finally(() => { pending--; if (!pending && reloadWanted) reloadFromStorage(); });
    return p.catch(e => { throw dbErr("unavailable", "Could not save: " + (e && e.message || e)); });
  }
  function changed(path) { later(() => { for (const l of [...listeners]) l(path); }); }

  // Called by All in One after a sync brought changes from another device
  async function reloadFromStorage() {
    if (!loaded) return;
    try { await loaded; } catch (e) { return; }
    await chain;
    if (pending) { reloadWanted = true; return; } // a new save started meanwhile; done again when it finishes
    let items; const w0 = writes;
    try { items = await readHubItems(); } catch (e) { return; }
    if (pending) { reloadWanted = true; return; }
    if (writes !== w0) return reloadFromStorage(); // a save happened while reading; read again
    reloadWanted = false;
    const now = new Map();
    for (const d of items) if (d.hub === "db" && typeof d.path === "string" && d.data && typeof d.data === "object") now.set(d.path, d);
    const touched = [];
    for (const [path, d] of now) {
      const j = JSON.stringify(d.data);
      if (seen.get(path) !== j) { docs.set(path, d.data); seen.set(path, j); touched.push(path); }
    }
    for (const path of [...docs.keys()]) if (!now.has(path)) { docs.delete(path); seen.delete(path); touched.push(path); }
    touched.forEach(changed);
  }
  window.hubWebReload = () => { reloadFromStorage(); };

  function snap(path, body) {
    const id = path.slice(path.lastIndexOf("/") + 1);
    const frozen = body === undefined ? undefined : Object.freeze(clone(body));
    return Object.freeze({ id, exists: body !== undefined, data: () => frozen, metadata: META });
  }
  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k], v) : v;
    }
    return out;
  }
  function body(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw dbErr("invalid_argument", "A document body must be an object");
    try { return clone(data); } catch { throw dbErr("invalid_argument", "A document body must be plain JSON"); }
  }

  async function write(path, b) {
    const had = docs.has(path), prev = docs.get(path);
    if (b === undefined) docs.delete(path); else docs.set(path, b); changed(path);
    try { await persist(path, b); }
    catch (e) { if (docs.get(path) === b) { if (had) docs.set(path, prev); else docs.delete(path); changed(path); } throw e; }
  }
  function docRef(path) {
    checkPath(path, true);
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      path,
      async get() { await load(); return snap(path, docs.get(path)); },
      async set(data) { const b = body(data); await load(); await write(path, b); },
      async update(data) {
        const b = body(data); await load();
        if (!docs.has(path)) throw dbErr("invalid_argument", `No document at ${path} to update`);
        const m = merge(docs.get(path), b); await write(path, m);
      },
      async delete() { await load(); if (!docs.has(path)) return; await write(path, undefined); },
      async acquire(o) { return { acquired: true, holder: o && o.holder, expiresAt: new Date(Date.now() + ((o && o.ttlMs) || 30000)).toISOString() }; },
      onSnapshot(next, error) {
        let on = true;
        const fire = () => { if (on) { try { next(snap(path, docs.get(path))); } catch (e) { console.error(e); } } };
        const l = p => { if (p === path) fire(); };
        load().then(() => { if (!on) return; listeners.add(l); fire(); }, e => { if (on && error) error(dbErr("unavailable", String(e))); });
        return () => { on = false; listeners.delete(l); };
      },
      collection(sub) { return colRef(path + "/" + sub); },
    };
  }

  const OPS = {
    "==": (a, b) => JSON.stringify(a) === JSON.stringify(b),
    "!=": (a, b) => JSON.stringify(a) !== JSON.stringify(b),
    "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
    "in": (a, b) => Array.isArray(b) && b.some(x => OPS["=="](a, x)),
    "not-in": (a, b) => Array.isArray(b) && !b.some(x => OPS["=="](a, x)),
    "array-contains": (a, b) => Array.isArray(a) && a.some(x => OPS["=="](x, b)),
  };
  function query(path, q) {
    const run = () => {
      let rows = [];
      for (const [p, d] of docs) if (parentOf(p) === path) rows.push([p, d]);
      for (const [f, op, v] of q.where) rows = rows.filter(([, d]) => d[f] !== undefined && OPS[op](d[f], v));
      if (q.order) {
        const [f, dir] = q.order, s = dir === "desc" ? -1 : 1;
        rows = rows.filter(([, d]) => d[f] !== undefined);
        rows.sort(([pa, a], [pb, b]) => (a[f] < b[f] ? -s : a[f] > b[f] ? s : pa < pb ? -1 : 1));
      } else rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (q.limit) rows = rows.slice(0, q.limit);
      return rows;
    };
    const qsnap = (rows, changes) => {
      const list = rows.map(([p, d]) => snap(p, d));
      return Object.freeze({ docs: list, size: list.length, empty: !list.length, docChanges: () => changes(list), metadata: META });
    };
    return {
      where(f, op, v) { if (!OPS[op]) throw dbErr("invalid_argument", "Unknown operator " + op); return query(path, { ...q, where: [...q.where, [f, op, v]] }); },
      orderBy(f, dir) { return query(path, { ...q, order: [f, dir || "asc"] }); },
      limit(n) { return query(path, { ...q, limit: n }); },
      async get() { await load(); return qsnap(run(), list => list.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i }))); },
      onSnapshot(next, error) {
        let on = true, prev = [];
        const fire = () => {
          if (!on) return;
          const rows = run();
          const before = prev;
          const s = qsnap(rows, list => {
            const out = [], oldIdx = new Map(before.map(([p, d], i) => [p, [i, d]]));
            const nowSet = new Set(rows.map(([p]) => p));
            before.forEach(([p, d], i) => { if (!nowSet.has(p)) out.push({ type: "removed", doc: snap(p, d), oldIndex: i, newIndex: -1 }); });
            rows.forEach(([p, d], i) => {
              const o = oldIdx.get(p);
              if (!o) out.push({ type: "added", doc: list[i], oldIndex: -1, newIndex: i });
              else if (o[1] !== d) out.push({ type: "modified", doc: list[i], oldIndex: o[0], newIndex: i });
            });
            return out;
          });
          prev = rows;
          try { next(s); } catch (e) { console.error(e); }
        };
        const l = p => { if (parentOf(p) === path) fire(); };
        load().then(() => { if (!on) return; listeners.add(l); fire(); }, e => { if (on && error) error(dbErr("unavailable", String(e))); });
        return () => { on = false; listeners.delete(l); };
      },
    };
  }
  function colRef(path) {
    checkPath(path, false);
    return Object.assign(query(path, { where: [], order: null, limit: 0 }), {
      path,
      doc(id) { return docRef(path + "/" + (id === undefined ? newId() : id)); },
      async add(data) { const r = docRef(path + "/" + newId()); await r.set(data); return r; },
    });
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  /* ---------- photos and files ---------- */
  // Blobs may come from another window (All in One itself), so they are recognized by shape, not instanceof
  const isBlob = d => !!d && typeof d === "object" && typeof d.arrayBuffer === "function" && typeof d.size === "number";
  const isBytes = d => !!d && (Object.prototype.toString.call(d) === "[object ArrayBuffer]" || ArrayBuffer.isView(d));
  const toBlob = (d, type) => isBlob(d) ? d : new Blob([isBytes(d) ? d : String(d)], { type });
  const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  function dataUrlToBlob(u) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(u || "");
    if (!m) return null;
    const type = m[1] || "application/octet-stream";
    if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
    const bin = atob(m[3]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const assets = Object.freeze({
    async upload(data, opts) {
      const type = (opts && opts.type) || (data && data.type) || "application/octet-stream";
      const blob = toBlob(data, type);
      if (blob.size > 20 * 1024 * 1024) throw Object.assign(new Error("Files can be up to 20 MB"), { code: "too_large" });
      const id = randomHex();
      const item = { id: FILE_PREFIX + id, hub: "file", dataUrl: await blobToDataUrl(blob.type ? blob : new Blob([blob], { type })),
        contentType: type, sizeBytes: blob.size, createdAt: new Date().toISOString() };
      if ((await P.saveDocToDB(item)) === false) throw Object.assign(new Error("This device may be out of storage space"), { code: "unavailable" });
      return { id, url: "_blob/" + id, sizeBytes: blob.size, contentType: type };
    },
    async list() {
      const files = (await readHubItems()).filter(d => d.hub === "file");
      const list = files.map(f => ({ id: f.id.slice(FILE_PREFIX.length), url: "_blob/" + f.id.slice(FILE_PREFIX.length),
        sizeBytes: f.sizeBytes || 0, contentType: f.contentType || "", createdAt: f.createdAt }));
      // "maxBytes" is the space this browser gives All in One (Fresh Start shows "N files · X of Y")
      let maxBytes = 0;
      try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; maxBytes = (est && est.quota) || 0; } catch (e) {}
      const bytes = list.reduce((n, a) => n + a.sizeBytes, 0);
      // No limit reported (some browsers): assume 1 GB rather than showing a full bar
      return { assets: list, usage: { files: list.length, count: list.length, bytes, maxBytes: Math.max(maxBytes || 1e9, bytes) } };
    },
    async delete(id) {
      const key = FILE_PREFIX + String(id);
      const had = await P.getDocFromDB(key);
      if (!had) throw Object.assign(new Error("No such file"), { code: "not_found" });
      if ((await P.deleteDocFromDB(key)) === false) throw Object.assign(new Error("Could not delete the file"), { code: "unavailable" });
      return { deleted: true };
    },
  });
  // A file's contents by id (null when it isn't on this device)
  async function fileBlob(id) {
    const item = await P.getDocFromDB(FILE_PREFIX + id);
    return item && item.dataUrl ? dataUrlToBlob(item.dataUrl) : null;
  }
  window.hubFileBlob = fileBlob;

  // The apps read photos and files with fetch("_blob/<id>"): answered here from storage
  const realFetch = window.fetch.bind(window);
  const blobIdOf = input => {
    try {
      const u = new URL(typeof input === "string" ? input : input && input.url, location.href);
      if (u.origin !== location.origin) return null;
      const m = /\/_blob\/([^/?#]+)$/.exec(u.pathname);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  };
  window.fetch = async function (input, init) {
    const id = blobIdOf(input);
    if (id === null) return realFetch(input, init);
    const blob = await fileBlob(id);
    if (!blob) return new Response("Not found", { status: 404 });
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    return new Response(method === "HEAD" ? null : blob, { status: 200, headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) } });
  };

  // <img src="_blob/<id>">: the offline helper (sw.js) answers these too; this covers a page it doesn't control yet
  const objectUrls = new Map();
  async function fixImg(img) {
    const src = img.getAttribute("src") || "";
    const id = blobIdOf(src);
    if (id === null || img.dataset.hubFixed === src) return;
    img.dataset.hubFixed = src;
    if (navigator.serviceWorker && navigator.serviceWorker.controller) return;
    // While the picture is being fetched from storage, a page's own "couldn't load" handler waits (data-hub-pending)
    img.dataset.hubPending = "1";
    let url = objectUrls.get(id);
    if (!url) {
      let b = null;
      try { b = await fileBlob(id); } catch (e) {}
      if (!b) { delete img.dataset.hubPending; img.dispatchEvent(new Event("error")); return; }
      url = URL.createObjectURL(b); objectUrls.set(id, url);
    }
    delete img.dataset.hubPending;
    if (img.getAttribute("src") === src) { img.src = url; img.dataset.hubFixed = url; }
  }
  function watch(root) {
    root.querySelectorAll && root.querySelectorAll("img[src*='_blob/']").forEach(fixImg);
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === "attributes" && m.target.tagName === "IMG") fixImg(m.target);
        m.addedNodes && m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n.tagName === "IMG") fixImg(n);
          n.querySelectorAll && n.querySelectorAll("img[src*='_blob/']").forEach(fixImg);
        });
      }
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  }
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () { const r = origAttach.apply(this, arguments); try { watch(r); } catch (e) {} return r; };
  document.addEventListener("DOMContentLoaded", () => watch(document.documentElement));

  /* ---------- saving a file the person asked for (PDFs, exports) ---------- */
  const downloads = Object.freeze({
    async save(req) {
      const name = String(req.filename || "file");
      const blob = toBlob(req.data, "application/octet-stream");
      let shareFailed = false; // the share sheet didn't open, so there is no way to know the file was kept
      // iPhone: the share sheet ("Save to Files") when it can take files
      try {
        const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
        if (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return { status: "saved" };
        }
      } catch (e) {
        if (e && e.name === "AbortError") throw Object.assign(new Error("The file was not saved."), { code: "declined" });
        shareFailed = true;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: shareFailed ? "unconfirmed" : "saved" };
    },
  });

  /* ---------- the person using the app: always the owner ---------- */
  const user = Object.freeze({
    id: async () => "local",
    me: async () => ({ id: "local", name: "", email: null }),
    isOwner: async () => true,
    canEdit: async () => true,
    can: async () => true,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, { id: i, name: "" }])),
    search: async () => [],
  });

  // Typing here counts as typing in All in One: its Google sign-in renewal reloads the page, so it waits
  ["keydown", "pointerdown", "input", "wheel", "touchstart"].forEach(ev => window.addEventListener(ev, () => {
    try { if (P.AllInOneSync && P.AllInOneSync.noteInput) P.AllInOneSync.noteInput(); } catch (e) {}
  }, { passive: true, capture: true }));

  const caps = { db, assets, downloads, user };
  window.claude = Object.freeze({
    use: name => Object.prototype.hasOwnProperty.call(caps, name) ? load().then(() => caps[name]) : Promise.resolve(null),
  });
  window.HUB_IN_ALL_IN_ONE = true;
})();
