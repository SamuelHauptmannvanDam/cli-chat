// cli-chat online — the browser client (online.cli-chat.dev). A plain messenger
// over the same wire as the CLI: libsodium sealed boxes end-to-end, Ed25519
// signed requests, magic-link login, vault/history sync. No AI anywhere unless
// the user connects their own key (assist.ts) — by default this is just chat.
//
// Reuses the CLI's own modules (src/crypto.ts, auth.ts, canonical.ts,
// mailbox-client.ts, account-client.ts, key-code.ts) verbatim; browser-only
// parts live next to this file (store-web, blob-crypto-web, envelope).

import { initCrypto, generateIdentity, seal, open, type Identity } from "../../src/crypto.ts";
import { makeAuthHeaders } from "../../src/auth.ts";
import {
  createMailboxClient,
  type FriendRequest,
  type MailboxClient,
  type NetworkPerson,
} from "../../src/mailbox-client.ts";
import { createAccountClient, type AccountClient } from "../../src/account-client.ts";
import { isHandle, parseKey, randomHandle } from "../../src/key-code.ts";
import type { WireMessage } from "../../src/identity.ts";
import { packBody, unpackBody } from "./envelope.ts";
import { decryptBlob, encryptBlob } from "./blob-crypto-web.ts";
import { store, type Row, type WebBook, type WebContact, type WebSession } from "./store-web.ts";
import { draftReply, hasAssist, PROVIDERS, providerById } from "./assist.ts";

// ---------------------------------------------------------------- config ----

const DEFAULT_MAILBOX = "https://mailbox.cli-chat.dev";

function mailboxUrl(): string {
  const q = new URLSearchParams(location.search).get("mailbox");
  if (q) {
    localStorage.setItem("cco.mailboxUrl", JSON.stringify(q));
    return q;
  }
  try {
    const saved = localStorage.getItem("cco.mailboxUrl");
    if (saved) return JSON.parse(saved) as string;
  } catch {
    /* fall through */
  }
  return DEFAULT_MAILBOX;
}

const BASE = mailboxUrl();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ----------------------------------------------------------------- state ----

interface State {
  identity: Identity | null;
  session: WebSession | null;
  book: WebBook | null;
  rows: Row[];
  activeThread: string | null; // signPub of the open conversation
  vaultDirty: boolean;
}

const state: State = {
  identity: store.loadIdentity(),
  session: store.loadSession(),
  book: store.loadBook(),
  rows: store.loadRows(),
  activeThread: null,
  vaultDirty: false,
};

const acct: AccountClient = createAccountClient(BASE);
let mailbox: MailboxClient | null = null;

function client(): MailboxClient {
  if (!state.identity) throw new Error("no identity");
  if (!mailbox) mailbox = createMailboxClient(BASE, state.identity, () => Date.now());
  return mailbox;
}

function me(): Identity {
  if (!state.identity) throw new Error("no identity");
  return state.identity;
}

function persist(): void {
  if (state.identity) store.saveIdentity(state.identity);
  if (state.session) store.saveSession(state.session);
  if (state.book) store.saveBook(state.book);
  store.saveRows(state.rows);
}

// ------------------------------------------------------------------- dom ----

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  setTimeout(() => (el.className = "toast"), 3500);
}

// -------------------------------------------------------------- contacts ----

function contactByKey(signPub: string): WebContact | undefined {
  return state.book?.contacts.find((c) => c.signPub === signPub);
}

function labelFor(signPub: string): string {
  if (signPub === state.identity?.signPub) return "me";
  const c = contactByKey(signPub);
  if (!c) return signPub.slice(0, 8) + "…";
  // An auto-saved sender's `name` is what THEY claim — show handle alongside.
  if (c.auto && c.handle) return `${c.name} (${c.handle})`;
  return c.name;
}

function rememberContact(add: WebContact): WebContact {
  const book = state.book!;
  const existing = add.signPub ? book.contacts.find((c) => c.signPub === add.signPub) : undefined;
  if (existing) {
    if (add.handle && !existing.handle) existing.handle = add.handle;
    if (add.selfName && add.selfName !== existing.selfName) existing.selfName = add.selfName;
    return existing;
  }
  book.contacts.push(add);
  state.vaultDirty = true;
  // Contribute the new edge to the contacts-of-contacts graph (mirrors the
  // CLI's onEdgeAdd). Best-effort — never blocks the save.
  if (add.signPub) void client().pushEdges([add.signPub]).catch(() => {});
  return add;
}

// --------------------------------------------------------------- threads ----

interface Thread {
  peer: string; // signPub
  rows: Row[];
  last: Row | null;
  unread: number;
}

function threads(): Thread[] {
  const mine = state.identity?.signPub;
  if (!mine) return [];
  const byPeer = new Map<string, Row[]>();
  for (const r of state.rows) {
    // Self-mail (sender == recipient == me) lands under the own key, so notes
    // to self still show as a thread.
    const peer: string = r.sender === mine ? r.recipient : r.sender;
    if (!byPeer.has(peer)) byPeer.set(peer, []);
    byPeer.get(peer)!.push(r);
  }
  // Contacts without any messages yet still get a (empty) thread entry.
  for (const c of state.book?.contacts ?? []) {
    if (c.signPub && !byPeer.has(c.signPub) && c.gated !== "dismissed") byPeer.set(c.signPub, []);
  }
  const out: Thread[] = [];
  for (const [peer, rows] of byPeer) {
    const c = contactByKey(peer);
    if (c?.gated === "dismissed") continue;
    rows.sort((a, b) => a.created_at - b.created_at);
    out.push({
      peer,
      rows,
      last: rows[rows.length - 1] ?? null,
      unread: rows.filter((r) => r.sender !== mine && r.read_at == null).length,
    });
  }
  // Pinned contacts first, then most recent activity.
  out.sort(
    (a, b) =>
      (pins.has(b.peer) ? 1 : 0) - (pins.has(a.peer) ? 1 : 0) ||
      (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0),
  );
  return out;
}

// ------------------------------------------------------------------ pins ----

const pins = new Set<string>(store.loadPins());

function togglePin(peer: string): void {
  if (pins.has(peer)) pins.delete(peer);
  else pins.add(peer);
  store.savePins([...pins]);
  renderAll();
}

// Tiny right-click menu for the sidebar (pin/unpin). One menu element, moved
// to the cursor; any click or Escape closes it.
function showContextMenu(x: number, y: number, peer: string): void {
  const menu = $("#ctx");
  const pinned = pins.has(peer);
  menu.innerHTML = `<button id="ctx-pin">${pinned ? "unpin" : "pin to top"}</button>`;
  menu.style.left = `${Math.min(x, innerWidth - 160)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 60)}px`;
  menu.classList.add("show");
  $("#ctx-pin").onclick = (ev) => {
    ev.stopPropagation();
    hideContextMenu();
    togglePin(peer);
  };
}

function hideContextMenu(): void {
  $("#ctx").classList.remove("show");
}

function markThreadRead(peer: string): void {
  const mine = state.identity?.signPub;
  let changed = false;
  for (const r of state.rows) {
    if (r.sender === peer && r.recipient === mine && r.read_at == null) {
      r.read_at = Date.now();
      changed = true;
    }
  }
  if (changed) persist();
  updateTitle();
}

// ---------------------------------------------- contacts of contacts ----

// Second-degree network + connect requests (in-memory; refreshed per session).
let network: NetworkPerson[] = [];
let incoming: FriendRequest[] = [];

function viaNames(vias: (string | null | undefined)[]): string {
  const names = vias
    .map((v) => (v ? state.book?.contacts.find((c) => c.signPub === v)?.name : undefined))
    .filter(Boolean);
  return names.length ? `via ${names.join(", ")}` : "";
}

async function refreshNetwork(): Promise<void> {
  if (!state.identity) return;
  try {
    const [people, reqs, accepts] = await Promise.all([
      client().getNetwork(),
      client().getRequests(),
      client().takeAccepts(),
    ]);
    // People who accepted MY request arrive as full contacts — save them.
    for (const a of accepts) {
      rememberContact({
        name: a.name || a.signPub.slice(0, 8) + "…",
        signPub: a.signPub,
        boxPub: a.boxPub,
      });
      toast(`${a.name ?? "someone"} accepted — added to your contacts`);
    }
    network = people.filter((p) => !contactByKey(p.signPub));
    incoming = reqs.filter((r) => !contactByKey(r.fromSignPub));
    renderNetwork();
    if (accepts.length) {
      persist();
      void syncVaultWeb();
      renderAll();
    }
  } catch {
    /* offline — section just stays as it was */
  }
}

function renderNetwork(): void {
  const el = $("#network");
  let html = "";
  if (incoming.length) {
    html +=
      `<div class="net-head">connect requests</div>` +
      incoming
        .map(
          (r, i) => {
            const name = r.fromName ?? r.fromSignPub.slice(0, 8) + "…";
            const via = viaNames([r.viaSignPub]);
            return `<div class="net-row">
            <div class="n-id" title="${esc(via ? `${name} ${via}` : name)}">
              <span class="n-name">${esc(name)}</span>
              <span class="n-via">${esc(via)}</span>
            </div>
            <button class="mini" data-acc="${i}">accept</button>
            <button class="mini ghost" data-dec="${i}">decline</button>
          </div>`;
          },
        )
        .join("");
  }
  if (network.length) {
    html +=
      `<div class="net-head">contacts of contacts</div>` +
      network
        .slice(0, 12)
        .map(
          (p, i) => {
            const name = p.name ?? p.signPub.slice(0, 8) + "…";
            const via = viaNames(p.via);
            return `<div class="net-row">
            <div class="n-id" title="${esc(via ? `${name} ${via}` : name)}">
              <span class="n-name">${esc(name)}</span>
              <span class="n-via">${esc(via)}</span>
            </div>
            <button class="mini ghost" data-req="${i}">request</button>
          </div>`;
          },
        )
        .join("");
  }
  el.innerHTML = html;

  for (const btn of el.querySelectorAll<HTMLButtonElement>("[data-req]")) {
    btn.onclick = async () => {
      const p = network[Number(btn.dataset.req)];
      if (!p) return;
      btn.disabled = true;
      try {
        const outcome = await client().requestContact(p.signPub, p.via[0] ?? null);
        if (outcome === "ok") toast(`connect request sent to ${p.name ?? "them"} — you can chat once they accept`);
        else if (outcome === "exists") toast("request already pending");
        else if (outcome === "already_friends") toast("you're already connected");
        else toast(`couldn't send the request (${outcome})`, "err");
      } catch (e) {
        toast(`request failed: ${(e as Error).message}`, "err");
        btn.disabled = false;
        return;
      }
      network = network.filter((x) => x !== p);
      renderNetwork();
    };
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("[data-acc]")) {
    btn.onclick = async () => {
      const r = incoming[Number(btn.dataset.acc)];
      if (!r) return;
      btn.disabled = true;
      try {
        const contact = await client().acceptRequest(r.fromSignPub);
        if (contact) {
          const saved = rememberContact({
            name: contact.name || contact.signPub.slice(0, 8) + "…",
            signPub: contact.signPub,
            boxPub: contact.boxPub,
          });
          persist();
          void syncVaultWeb();
          incoming = incoming.filter((x) => x !== r);
          renderNetwork();
          renderAll();
          openThread(saved.signPub!);
          toast(`connected with ${saved.name}`);
        }
      } catch (e) {
        toast(`accept failed: ${(e as Error).message}`, "err");
        btn.disabled = false;
      }
    };
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("[data-dec]")) {
    btn.onclick = async () => {
      const r = incoming[Number(btn.dataset.dec)];
      if (!r) return;
      try {
        await client().declineRequest(r.fromSignPub);
      } catch {
        /* best-effort */
      }
      incoming = incoming.filter((x) => x !== r);
      renderNetwork();
    };
  }
}

function updateTitle(): void {
  const unread = threads().reduce((n, t) => n + t.unread, 0);
  document.title = (unread ? `(${unread}) ` : "") + "cli-chat online";
}

// ---------------------------------------------------------------- render ----

function show(view: "login" | "app"): void {
  // Explicit values: both elements carry stylesheet display rules, so clearing
  // the inline style alone wouldn't override them.
  $("#login").style.display = view === "login" ? "flex" : "none";
  $("#app").style.display = view === "app" ? "flex" : "none";
}

function renderSidebar(): void {
  const list = $("#threads");
  const items = threads();
  if (!items.length) {
    list.innerHTML = `<div class="empty">no conversations yet —<br>write someone by their 6-char code or email ↑</div>`;
    return;
  }
  list.innerHTML = items
    .map((t) => {
      const c = contactByKey(t.peer);
      const label = labelFor(t.peer);
      const preview = t.last ? (t.last.body.split("\n")[0] ?? "").slice(0, 48) : "";
      const gated = c?.gated === "pending" ? `<span class="badge new">new</span>` : "";
      const unread = t.unread ? `<span class="badge">${t.unread}</span>` : "";
      const active = state.activeThread === t.peer ? " active" : "";
      const pin = pins.has(t.peer) ? `<span class="pin" title="pinned">▴</span>` : "";
      return `<button class="thread${active}" data-peer="${esc(t.peer)}">
        <span class="t-name">${pin}${esc(label)}${gated}${unread}</span>
        <span class="t-preview">${esc(preview)}</span>
      </button>`;
    })
    .join("");
  for (const btn of list.querySelectorAll<HTMLButtonElement>(".thread")) {
    btn.onclick = () => openThread(btn.dataset.peer!);
    btn.oncontextmenu = (ev) => {
      ev.preventDefault();
      showContextMenu(ev.clientX, ev.clientY, btn.dataset.peer!);
    };
  }
}

function renderThread(): void {
  const main = $("#messages");
  const head = $("#thread-head");
  const composer = $("#composer");
  const peer = state.activeThread;
  if (!peer) {
    head.innerHTML = `<span class="dim">pick a conversation</span>`;
    main.innerHTML = `<div class="empty big">✉<small>pick a conversation — or write someone new</small></div>`;
    composer.style.display = "none";
    return;
  }
  composer.style.display = "";
  const c = contactByKey(peer);
  // The self-thread (notes to self / escalations) has no contact entry — show
  // the user's own handle, never a raw key prefix.
  const sub =
    peer === state.identity?.signPub
      ? state.identity?.handle ?? "you"
      : c?.handle ?? c?.email ?? peer.slice(0, 12) + "…";
  head.innerHTML = `<span class="t-name">${esc(labelFor(peer))}</span> <span class="dim">· ${esc(sub)}</span>`;

  const gateBanner =
    c?.gated === "pending"
      ? `<div class="gate">🆕 first-time sender — they're not in your contacts yet.
         <button id="gate-accept">accept</button>
         <button id="gate-dismiss" class="ghost">dismiss</button></div>`
      : "";

  const t = threads().find((x) => x.peer === peer);
  const mine = state.identity!.signPub;
  const rows = t?.rows ?? [];
  main.innerHTML =
    gateBanner +
    (rows.length
      ? rows
          .map((r) => {
            const out = r.sender === mine;
            const assistant = r.answered_by === "assistant";
            const who = out ? "you" : labelFor(r.sender) + (assistant ? "'s assistant" : "");
            return `<div class="msg ${out ? "out" : "in"}">
              <div class="m-meta">${esc(who)} · ${fmtTime(r.created_at)}</div>
              <div class="m-body">${esc(r.body)}</div>
            </div>`;
          })
          .join("")
      : `<div class="empty">say hi — messages are sealed end-to-end</div>`);
  main.scrollTop = main.scrollHeight;

  if (c?.gated === "pending") {
    $("#gate-accept").onclick = () => {
      delete c.gated;
      state.vaultDirty = true;
      persist();
      renderAll();
      void syncVaultWeb();
      toast(`accepted ${c.name}`);
    };
    $("#gate-dismiss").onclick = () => {
      c.gated = "dismissed";
      state.activeThread = null;
      state.vaultDirty = true;
      persist();
      renderAll();
      void syncVaultWeb();
    };
  }
  $<HTMLButtonElement>("#ai-draft").style.display = hasAssist() ? "" : "none";
}

function renderMe(): void {
  const id = state.identity;
  if (!id) return;
  $("#me-name").textContent = id.name ?? "me";
  $("#me-handle").textContent = id.handle ?? "";
}

function renderAll(): void {
  renderMe();
  renderSidebar();
  renderThread();
  updateTitle();
}

function openThread(peer: string): void {
  state.activeThread = peer;
  markThreadRead(peer);
  renderAll();
  $<HTMLTextAreaElement>("#input").focus();
}

// ------------------------------------------------------------------ send ----

async function sendCurrent(): Promise<void> {
  const input = $<HTMLTextAreaElement>("#input");
  const text = input.value.trim();
  const peer = state.activeThread;
  if (!text || !peer) return;
  const c = contactByKey(peer);
  if (!c?.boxPub || !c.signPub) {
    toast("can't message this contact — no key on file", "err");
    return;
  }
  const id = me();
  const wire: WireMessage = {
    id: crypto.randomUUID(),
    recipient: c.signPub,
    sender: id.signPub,
    body: seal(packBody({ boxPub: id.boxPub, name: id.name, handle: id.handle }, text), c.boxPub),
    tags: null,
    created_at: Date.now(),
    in_reply_to: null,
  };
  input.disabled = true;
  try {
    await client().send(wire);
  } catch (e) {
    toast(`send failed: ${(e as Error).message}`, "err");
    input.disabled = false;
    return;
  }
  input.disabled = false;
  input.value = "";
  input.focus();
  // Writing a held sender counts as accepting them (mirrors the CLI rule).
  if (c.gated === "pending") {
    delete c.gated;
    state.vaultDirty = true;
    void syncVaultWeb();
  }
  c.sentCount = (c.sentCount ?? 0) + 1;
  c.lastMessageAt = wire.created_at;
  const row: Row = {
    id: wire.id,
    recipient: c.signPub,
    sender: id.signPub,
    body: text,
    tags: null,
    created_at: wire.created_at,
    fetched_at: wire.created_at,
    read_at: wire.created_at,
    in_reply_to: null,
    answered_by: null,
  };
  state.rows.push(row);
  queueHistory(row);
  persist();
  renderAll();
}

// --------------------------------------------------------- start new chat ----

async function startNewChat(raw: string): Promise<void> {
  const q = raw.trim();
  if (!q) return;
  let keys: { signPub: string; boxPub: string } | null = null;
  let handle: string | undefined;
  let email: string | undefined;

  try {
    if (isHandle(q)) {
      keys = await client().resolveHandle(q);
      handle = q;
      if (!keys) {
        toast("nobody has that code (or they accept connect requests only)", "err");
        return;
      }
    } else if (EMAIL_RE.test(q)) {
      keys = await client().resolveEmail(q);
      email = q.toLowerCase();
      if (!keys) {
        toast("that address accepts connect requests only", "err");
        return;
      }
    } else if (parseKey(q)) {
      keys = parseKey(q);
    } else {
      toast("enter a 6-char code, an email address, or a full key", "err");
      return;
    }
  } catch (e) {
    toast(`lookup failed: ${(e as Error).message}`, "err");
    return;
  }

  const existing = state.book!.contacts.find((c) => c.signPub === keys!.signPub);
  if (existing) {
    if (existing.gated === "dismissed") delete existing.gated;
    openThread(existing.signPub!);
    return;
  }
  const name = prompt("name for this contact?", handle ?? email ?? "")?.trim();
  const contact = rememberContact({
    name: name || handle || email || keys!.signPub.slice(0, 8),
    signPub: keys!.signPub,
    boxPub: keys!.boxPub,
    handle,
    email,
  });
  persist();
  void syncVaultWeb();
  openThread(contact.signPub!);
  toast(`saved ${contact.name}`);
}

// ------------------------------------------------------------ history sync ----

function queueHistory(row: Row): void {
  const outbox = store.loadOutbox();
  outbox.push(row);
  store.saveOutbox(outbox);
  scheduleHistoryPush();
}

let historyTimer: number | null = null;
function scheduleHistoryPush(): void {
  if (historyTimer != null) return;
  historyTimer = window.setTimeout(() => {
    historyTimer = null;
    void pushHistoryNow();
  }, 2000);
}

async function pushHistoryNow(): Promise<void> {
  const s = state.session;
  if (!s?.token || !s.dataKey) return;
  let outbox = store.loadOutbox();
  while (outbox.length) {
    const batch = outbox.slice(0, 200);
    try {
      const blob = await encryptBlob(JSON.stringify({ v: 1, rows: batch }), s.dataKey);
      const res = await acct.pushHistory(s.token, [blob]);
      if (typeof res === "string") return; // unauthorized / payment gate — leave queued
    } catch {
      return; // network — retry on next schedule
    }
    outbox = outbox.slice(batch.length);
    store.saveOutbox(outbox);
  }
}

async function pullHistoryNow(): Promise<void> {
  const s = state.session;
  if (!s?.token || !s.dataKey) return;
  let cursor = s.historyCursor ?? 0;
  const known = new Set(state.rows.map((r) => r.id));
  let added = 0;
  try {
    for (;;) {
      const page = await acct.pullHistory(s.token, cursor);
      if (typeof page === "string") return;
      for (const chunk of page.chunks) {
        try {
          const plain = await decryptBlob(chunk.blob, s.dataKey);
          const parsed = JSON.parse(plain) as { v: 1; rows: Row[] };
          for (const row of parsed.rows ?? []) {
            if (!row?.id || known.has(row.id)) continue;
            known.add(row.id);
            // Born read: history from other devices is recall, not new mail.
            state.rows.push({
              ...row,
              fetched_at: row.fetched_at ?? row.created_at,
              read_at: row.read_at ?? row.created_at,
            });
            added++;
          }
        } catch {
          /* undecryptable chunk — skip, don't wedge the cursor */
        }
        cursor = Math.max(cursor, chunk.seq);
      }
      s.historyCursor = cursor;
      store.saveSession(s);
      if (!page.chunks.length || cursor >= page.last) break;
    }
  } catch {
    /* network — next pass covers it */
  }
  if (added) {
    persist();
    renderAll();
  }
}

// -------------------------------------------------------------- mail sync ----

async function drainMail(): Promise<void> {
  if (!state.identity) return;
  let blobs: WireMessage[];
  try {
    blobs = await client().drain();
  } catch {
    return;
  }
  if (!blobs.length) return;
  const known = new Set(state.rows.map((r) => r.id));
  const id = me();
  let added = 0;
  for (const b of blobs) {
    if (known.has(b.id)) continue;
    let plain: string;
    try {
      plain = open(b.body, id.boxPub, id.boxSec);
    } catch {
      continue; // sealed to another identity — skip, never surface garbage
    }
    const env = unpackBody(plain);
    const fromSelf = b.sender === id.signPub;
    if (!fromSelf && env.boxPub && !contactByKey(b.sender)) {
      // First-time sender: save their self-intro, HELD behind the gate (same as
      // the CLI). The web user is a human reading directly, so the thread shows
      // with an accept/dismiss banner rather than being invisible.
      rememberContact({
        name: env.name || env.handle || b.sender.slice(0, 8) + "…",
        signPub: b.sender,
        boxPub: env.boxPub,
        handle: env.handle,
        selfName: env.name,
        auto: true,
        gated: "pending",
      });
    } else if (!fromSelf) {
      const c = contactByKey(b.sender);
      if (c) {
        if (env.handle && !c.handle) c.handle = env.handle;
        if (env.name && env.name !== c.selfName) c.selfName = env.name;
      }
    }
    const row: Row = {
      id: b.id,
      recipient: id.signPub,
      sender: b.sender,
      body: env.text,
      tags: b.tags,
      created_at: b.created_at,
      fetched_at: Date.now(),
      read_at: state.activeThread === b.sender && !document.hidden ? Date.now() : null,
      in_reply_to: b.in_reply_to,
      answered_by: env.answered_by ?? null,
    };
    state.rows.push(row);
    queueHistory(row);
    added++;
  }
  if (added) {
    persist();
    renderAll();
  }
}

// -------------------------------------------------------------- vault sync ----

function buildVaultBlob(): string {
  const baseRaw = store.loadVaultBase();
  let base: Record<string, unknown> = { v: 1, settings: null, files: {} };
  if (baseRaw) {
    try {
      base = JSON.parse(baseRaw) as Record<string, unknown>;
    } catch {
      /* keep fresh base */
    }
  }
  base.v = 1;
  base.identity = state.identity;
  base.contacts = state.book;
  return JSON.stringify(base);
}

function adoptVault(raw: string, version: number): void {
  const blob = JSON.parse(raw) as { identity?: Identity; contacts?: WebBook };
  if (blob.identity?.signPub) {
    state.identity = blob.identity;
    mailbox = null; // re-key the signed client
  }
  if (blob.contacts?.contacts) state.book = blob.contacts;
  store.saveVaultBase(raw);
  if (state.session) {
    state.session.vaultVersion = version;
    store.saveSession(state.session);
  }
  persist();
}

// Contacts merge for the concurrent-edit case: union by signPub, local wins,
// tags unioned — the same shape as src/vault.ts mergeVaults, minus the fs.
function mergeContacts(localRaw: string, serverRaw: string): string {
  const local = JSON.parse(localRaw) as Record<string, any>;
  const server = JSON.parse(serverRaw) as Record<string, any>;
  const byKey = new Map<string, any>();
  for (const c of server.contacts?.contacts ?? []) byKey.set(c.signPub ?? c.handle, c);
  for (const c of local.contacts?.contacts ?? []) {
    const k = c.signPub ?? c.handle;
    const prev = byKey.get(k);
    byKey.set(
      k,
      prev ? { ...prev, ...c, tags: [...new Set([...(prev.tags ?? []), ...(c.tags ?? [])])] } : c,
    );
  }
  const contacts = { ...(server.contacts ?? {}), ...(local.contacts ?? {}), contacts: [...byKey.values()] };
  const files = { ...(server.files ?? {}), ...(local.files ?? {}) };
  return JSON.stringify({ ...server, ...local, contacts, files });
}

async function syncVaultWeb(): Promise<void> {
  const s = state.session;
  if (!s?.token) return;
  try {
    const pulled = await acct.pullVault(s.token);
    if (typeof pulled === "string") return;
    const serverAhead = pulled.version > s.vaultVersion && pulled.blob != null;
    if (serverAhead) {
      const raw = await decryptBlob(pulled.blob!, s.dataKey);
      if (!state.vaultDirty) {
        adoptVault(raw, pulled.version);
        renderAll();
        return;
      }
      const merged = mergeContacts(buildVaultBlob(), raw);
      adoptVault(merged, pulled.version);
      await pushVaultAt(merged, pulled.version + 1);
      renderAll();
      return;
    }
    if (state.vaultDirty || pulled.blob == null) {
      await pushVaultAt(buildVaultBlob(), Math.max(pulled.version, s.vaultVersion) + 1);
    }
  } catch {
    /* offline — stays dirty, next pass pushes */
  }
}

async function pushVaultAt(raw: string, version: number): Promise<void> {
  const s = state.session!;
  const sealed = s.dataKey ? await encryptBlob(raw, s.dataKey) : raw;
  const res = await acct.pushVault(s.token, sealed, version, state.identity!.signPub);
  if (res.ok) {
    s.vaultVersion = res.version;
    store.saveSession(s);
    store.saveVaultBase(raw);
    state.vaultDirty = false;
    return;
  }
  if (res.reason === "stale") {
    const serverRaw = await decryptBlob(res.current.blob, s.dataKey);
    const merged = mergeContacts(raw, serverRaw);
    adoptVault(merged, res.current.version);
    const retry = await acct.pushVault(
      s.token,
      s.dataKey ? await encryptBlob(merged, s.dataKey) : merged,
      res.current.version + 1,
      state.identity!.signPub,
    );
    if (retry.ok) {
      s.vaultVersion = retry.version;
      store.saveSession(s);
      state.vaultDirty = false;
    }
  }
}

// ------------------------------------------------------------- live socket ----

let ws: WebSocket | null = null;
let wsBackoff = 1000;
let pingTimer: number | null = null;

function connectSocket(): void {
  if (!state.identity) return;
  const id = me();
  const now = Date.now();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/connect", "", now);
  const url = new URL(BASE.replace(/^http/, "ws") + "/connect");
  url.searchParams.set("x-pubkey", h["x-pubkey"]);
  url.searchParams.set("x-timestamp", h["x-timestamp"]);
  url.searchParams.set("x-signature", h["x-signature"]);
  try {
    ws = new WebSocket(url.toString());
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsBackoff = 1000;
    setLive(true);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 30_000);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string" || ev.data === "pong") return;
    try {
      const frame = JSON.parse(ev.data) as { t?: string };
      if (frame.t === "mail") void drainMail();
      else if (frame.t === "vault") void syncVaultWeb();
      else if (frame.t === "history") void pullHistoryNow();
    } catch {
      /* ignore unknown frames */
    }
  };
  ws.onclose = () => {
    setLive(false);
    scheduleReconnect();
  };
  ws.onerror = () => ws?.close();
}

function scheduleReconnect(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  setTimeout(connectSocket, wsBackoff);
  wsBackoff = Math.min(wsBackoff * 2, 30_000);
}

function setLive(on: boolean): void {
  $("#live-dot").className = `dot ${on ? "on" : ""}`;
  $("#live-label").textContent = on ? "live" : "polling";
}

// ------------------------------------------------------------------ login ----

let pollAbort = false;

async function loginFlow(): Promise<void> {
  const emailInput = $<HTMLInputElement>("#login-email");
  const email = emailInput.value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    toast("that doesn't look like an email address", "err");
    return;
  }
  $("#login-step1").style.display = "none";
  $("#login-wait").style.display = "block";
  let start;
  try {
    start = await acct.startLogin(email);
  } catch (e) {
    toast(`couldn't reach the server: ${(e as Error).message}`, "err");
    $("#login-step1").style.display = "";
    $("#login-wait").style.display = "none";
    return;
  }
  if (start.devLink) {
    $("#dev-link").innerHTML = `<a href="${esc(start.devLink)}" target="_blank" rel="noopener">dev: open the magic link</a>`;
  }
  pollAbort = false;
  const interval = start.interval_ms || 2000;
  for (;;) {
    if (pollAbort) return;
    await new Promise((r) => setTimeout(r, interval));
    let res;
    try {
      res = await acct.poll(start.poll_id);
    } catch {
      continue;
    }
    if (res.status === "pending") continue;
    if (res.status === "expired") {
      toast("the link expired — try again", "err");
      $("#login-step1").style.display = "";
      $("#login-wait").style.display = "none";
      return;
    }
    // ready
    const dataKey = res.account.dataKey ?? (await fetchKeySafe(res.session_token));
    state.session = {
      token: res.session_token,
      email: res.account.email,
      dataKey,
      vaultVersion: 0,
      historyCursor: 0,
    };
    store.saveSession(state.session);
    if (res.account.hasVault) {
      const pulled = await acct.pullVault(res.session_token);
      if (typeof pulled !== "string" && pulled.blob) {
        const raw = await decryptBlob(pulled.blob, dataKey);
        adoptVault(raw, pulled.version);
        finishLogin(`welcome back — you're ${state.identity?.name ?? "set up"} (${state.identity?.handle ?? ""})`);
        return;
      }
    }
    // New account (or empty vault): need a name, then mint/adopt identity.
    $("#login-wait").style.display = "none";
    $("#login-name").style.display = "block";
    $<HTMLInputElement>("#name-input").focus();
    $<HTMLFormElement>("#name-form").onsubmit = (ev) => {
      ev.preventDefault();
      const name = $<HTMLInputElement>("#name-input").value.trim();
      if (!name) return;
      void createIdentity(name, res.account.stub);
    };
    return;
  }
}

async function fetchKeySafe(token: string): Promise<string | undefined> {
  try {
    const k = await acct.fetchDataKey(token);
    return k === "unauthorized" ? undefined : k;
  } catch {
    return undefined;
  }
}

async function createIdentity(
  name: string,
  stub?: { signPub: string; signSec: string; boxPub: string; boxSec: string },
): Promise<void> {
  // Adopt the stub identity when mail already waited on this address
  // (EMAIL-SEND.md) so those sealed messages stay openable.
  const id: Identity = stub ? { ...stub } : generateIdentity();
  id.name = name;
  state.identity = id;
  mailbox = null;
  // Claim a free 6-char handle (the CLI's provision.ts loop, WebCrypto RNG).
  try {
    for (let i = 0; i < 8; i++) {
      const candidate = randomHandle(crypto.getRandomValues(new Uint8Array(8)));
      if ((await client().registerHandle(candidate, name)) === "ok") {
        id.handle = candidate;
        break;
      }
    }
  } catch (e) {
    toast(`couldn't register: ${(e as Error).message}`, "err");
    return;
  }
  if (!id.handle) {
    toast("couldn't find a free code — try again", "err");
    return;
  }
  state.book = { me: id.signPub, contacts: [] };
  // Every new account knows the project's own inbox (same seed as the CLI).
  try {
    const fb = await client().resolveHandle("FeedBk");
    if (fb) {
      state.book.contacts.push({
        name: "cli-chat feedback",
        handle: "FeedBk",
        signPub: fb.signPub,
        boxPub: fb.boxPub,
      });
    }
  } catch {
    /* seeding is best-effort */
  }
  state.vaultDirty = true;
  persist();
  await syncVaultWeb();
  finishLogin(`you're set up — your code is ${id.handle}. share it so people can write you.`);
}

function finishLogin(message: string): void {
  persist();
  show("app");
  renderAll();
  toast(message);
  void startEngine();
}

// ------------------------------------------------------------------- boot ----

async function startEngine(): Promise<void> {
  await drainMail();
  await pullHistoryNow();
  await pushHistoryNow();
  await syncVaultWeb();
  // Converge the CoC graph with the whole book (mirrors the CLI's session-start
  // bulk push), then load the network sections.
  const keys = (state.book?.contacts ?? [])
    .map((c) => c.signPub)
    .filter((k): k is string => !!k);
  if (keys.length) void client().pushEdges(keys).catch(() => {});
  void refreshNetwork();
  connectSocket();
  // Fallback cadence: the socket is an accelerator, polling is the floor.
  setInterval(() => {
    if (ws?.readyState !== 1) void drainMail();
  }, 30_000);
  setInterval(() => void pullHistoryNow(), 120_000);
  setInterval(() => void refreshNetwork(), 300_000);
  window.addEventListener("focus", () => {
    void drainMail();
    if (state.activeThread) markThreadRead(state.activeThread);
  });
}

async function logout(): Promise<void> {
  if (!confirm("log out on this browser? your account stays intact — log in again anytime.")) return;
  try {
    if (state.session?.token) await acct.logout(state.session.token);
  } catch {
    /* best-effort */
  }
  store.wipe();
  location.reload();
}

async function main(): Promise<void> {
  await initCrypto();

  $<HTMLFormElement>("#login-form").onsubmit = (ev) => {
    ev.preventDefault();
    void loginFlow();
  };
  $("#login-restart").onclick = () => {
    pollAbort = true;
    $("#login-step1").style.display = "";
    $("#login-wait").style.display = "none";
  };
  $<HTMLFormElement>("#new-chat-form").onsubmit = (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>("#new-chat");
    void startNewChat(input.value).then(() => (input.value = ""));
  };
  const input = $<HTMLTextAreaElement>("#input");
  input.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendCurrent();
    }
  };
  $("#send").onclick = () => void sendCurrent();
  $("#logout").onclick = () => void logout();
  $("#me-copy").onclick = () => {
    const h = state.identity?.handle;
    if (h) {
      void navigator.clipboard.writeText(h);
      toast(`copied ${h} — share it so people can write you`);
    }
  };
  $("#settings-btn").onclick = () => $("#settings").classList.toggle("show");
  document.addEventListener("click", hideContextMenu);
  document.addEventListener("keydown", (ev) => ev.key === "Escape" && hideContextMenu());
  window.addEventListener("blur", hideContextMenu);

  // Provider picker: presets fill base URL + default model; "custom" exposes
  // the base-URL field for any OpenAI-compatible endpoint.
  const providerSel = $<HTMLSelectElement>("#ai-provider");
  providerSel.innerHTML = PROVIDERS.map(
    (p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`,
  ).join("");
  const syncProviderFields = (keepModel: boolean) => {
    const p = providerById(providerSel.value);
    $("#ai-baseurl-row").style.display = providerSel.value === "custom" ? "flex" : "none";
    const modelInput = $<HTMLInputElement>("#ai-model");
    if (!keepModel) modelInput.value = p?.defaultModel ?? "";
    modelInput.placeholder = p?.defaultModel ? `model (default ${p.defaultModel})` : "model";
  };
  providerSel.onchange = () => syncProviderFields(false);
  {
    const saved = store.loadAssist();
    if (saved) {
      providerSel.value = saved.provider;
      $<HTMLInputElement>("#ai-key").value = saved.apiKey;
      $<HTMLInputElement>("#ai-model").value = saved.model ?? "";
      $<HTMLInputElement>("#ai-baseurl").value = saved.baseUrl ?? "";
    }
    syncProviderFields(!!saved?.model);
  }
  $("#ai-key-save").onclick = () => {
    const apiKey = $<HTMLInputElement>("#ai-key").value.trim();
    if (!apiKey) {
      toast("paste an API key first (or disconnect)", "err");
      return;
    }
    const provider = providerSel.value;
    const model = $<HTMLInputElement>("#ai-model").value.trim() || undefined;
    const baseUrl =
      provider === "custom"
        ? $<HTMLInputElement>("#ai-baseurl").value.trim() || undefined
        : undefined;
    if (provider === "custom" && !baseUrl) {
      toast("custom provider needs a base URL", "err");
      return;
    }
    store.saveAssist({ provider, apiKey, model, baseUrl });
    toast(`assistant connected (${providerById(provider)?.label ?? provider}) — drafts stay on this device`);
    $("#settings").classList.remove("show");
    renderThread();
  };
  $("#ai-clear").onclick = () => {
    store.saveAssist(null);
    $<HTMLInputElement>("#ai-key").value = "";
    toast("assistant disconnected — back to plain chat");
    $("#settings").classList.remove("show");
    renderThread();
  };
  $("#ai-draft").onclick = async () => {
    const peer = state.activeThread;
    if (!peer) return;
    const t = threads().find((x) => x.peer === peer);
    if (!t?.rows.length) return;
    const btn = $<HTMLButtonElement>("#ai-draft");
    btn.disabled = true;
    btn.textContent = "drafting…";
    try {
      const draft = await draftReply(
        t.rows.slice(-12).map((r) => ({
          from: r.sender === state.identity!.signPub ? "me" : labelFor(r.sender),
          text: r.body,
        })),
        state.identity?.name,
      );
      const input = $<HTMLTextAreaElement>("#input");
      input.value = draft;
      input.focus();
    } catch (e) {
      toast(`draft failed: ${(e as Error).message}`, "err");
    }
    btn.disabled = false;
    btn.textContent = "✦ draft";
  };
  if (state.identity && state.session?.token) {
    show("app");
    renderAll();
    void startEngine();
  } else {
    show("login");
  }
}

void main();
