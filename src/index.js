// titan-graph Worker: 그래프 데이터(D1)를 읽고 고치는 /api/* 와 정적 페이지를 함께 서비스한다.
// 읽기는 누구나, 쓰기는 Cloudflare Access로 로그인한 사용자만 할 수 있다.

import { verifyAccessJwt } from "./access.js";

const NOTE_COLORS = ["yellow", "pink", "blue", "green"];
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,199}$/;
const PROP_PATTERN = /^[A-Za-z][A-Za-z0-9_:.-]{0,99}$/;
const MAX_NOTE_LENGTH = 2000;
const MAX_DATA_BYTES = 20000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const now = () => new Date().toISOString();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSeeded(env, request);
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "서버 오류가 발생했습니다." }, 500);
    }
  },
};

// ---------- First-run seeding ----------

// An empty database is filled from the deployed titan.jsonld on the first API request.
let seeded = false;

async function ensureSeeded(env, request) {
  if (seeded) return;
  const meta = await env.DB.prepare("SELECT 1 FROM meta WHERE key = 'context'").first();
  if (meta) { seeded = true; return; }
  const res = await env.ASSETS.fetch(new URL("/titan.jsonld", request.url));
  if (!res.ok) throw new Error("초기 데이터(titan.jsonld)를 읽지 못했습니다.");
  const doc = await res.json();
  const ts = now();
  const nodeStmts = [];
  const edgeStmts = [];
  for (const node of doc["@graph"]) {
    const data = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "@id") continue;
      const values = Array.isArray(value) ? value : [value];
      const literals = values.filter((v) => !isRef(v));
      for (const v of values) {
        if (isRef(v)) {
          edgeStmts.push(env.DB.prepare("INSERT OR IGNORE INTO edges (source, prop, target, updated_at, updated_by) VALUES (?, ?, ?, ?, 'seed')").bind(node["@id"], key, v["@id"], ts));
        }
      }
      if (literals.length) data[key] = Array.isArray(value) && literals.length > 1 ? literals : literals[0];
    }
    nodeStmts.push(env.DB.prepare("INSERT OR IGNORE INTO nodes (id, data, updated_at, updated_by) VALUES (?, ?, ?, 'seed')").bind(node["@id"], JSON.stringify(data), ts));
  }
  // meta last: it marks the seed as complete.
  const stmts = [...nodeStmts, ...edgeStmts];
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('context', ?)").bind(JSON.stringify(doc["@context"])));
  await env.DB.batch(stmts);
  seeded = true;
}

const isRef = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "@id" in v;

// ---------- Routing ----------

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const id = url.searchParams.get("id");

  if (method === "GET") {
    if (path === "/api/me") return json(await me(request, env));
    if (path === "/api/graph") return json(await loadGraph(env));
    if (path === "/api/notes") return json({ notes: await listNotes(env) });
    if (path === "/api/export.jsonld") {
      const { doc } = await loadGraph(env);
      return new Response(JSON.stringify(doc, null, 2), {
        headers: {
          "content-type": "application/ld+json; charset=utf-8",
          "content-disposition": 'attachment; filename="titan.jsonld"',
          "cache-control": "no-store",
        },
      });
    }
    if (path === "/api/trash") return json(await listTrash(env));
    if (path === "/api/history") return json({ history: await listHistory(env, url.searchParams.get("limit")) });
    throw new HttpError(404, "없는 주소입니다.");
  }

  const actor = await requireEditor(request, env);
  const body = method === "DELETE" ? {} : await readJson(request);

  switch (`${method} ${path}`) {
    case "POST /api/nodes": return json(await createNode(env, actor, body), 201);
    case "PUT /api/nodes": return json(await updateNode(env, actor, required(id), body));
    case "DELETE /api/nodes": return json(await deleteNode(env, actor, required(id)));
    case "POST /api/nodes/restore": return json(await restoreNode(env, actor, required(id)));
    case "POST /api/edges": return json(await createEdge(env, actor, body), 201);
    case "DELETE /api/edges": return json(await deleteEdge(env, actor, intId(id)));
    case "POST /api/edges/restore": return json(await restoreEdge(env, actor, intId(id)));
    case "POST /api/notes": return json(await createNote(env, actor, body), 201);
    case "PUT /api/notes": return json(await updateNote(env, actor, intId(id), body));
    case "DELETE /api/notes": return json(await deleteNote(env, actor, intId(id)));
    case "POST /api/notes/restore": return json(await restoreNote(env, actor, intId(id)));
    case "POST /api/history/revert": return json(await revertHistory(env, actor, intId(id)));
  }
  throw new HttpError(404, "없는 주소입니다.");
}

function required(id) {
  if (!id) throw new HttpError(400, "id가 필요합니다.");
  return id;
}

function intId(id) {
  const n = Number(required(id));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "id가 올바르지 않습니다.");
  return n;
}

async function readJson(request) {
  // JSON만 받아서, 다른 사이트의 단순 폼 전송으로 쓰기가 일어나지 않게 한다.
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    throw new HttpError(415, "Content-Type은 application/json이어야 합니다.");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "JSON 본문을 읽을 수 없습니다.");
  }
}

// ---------- Auth ----------

async function currentUser(request, env) {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const payload = await verifyAccessJwt(token, env.TEAM_DOMAIN, env.POLICY_AUD);
  return payload ? payload.email || payload.sub || "access-user" : null;
}

async function requireEditor(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(403, "편집하려면 Cloudflare Access로 로그인해야 합니다.");
  return user;
}

async function me(request, env) {
  const email = await currentUser(request, env);
  return { canEdit: !!email, email, accessConfigured: !!(env.TEAM_DOMAIN && env.POLICY_AUD) };
}

// ---------- History ----------

function historyStmt(env, actor, entity, entityId, action, before, after) {
  return env.DB.prepare(
    "INSERT INTO history (at, actor, entity, entity_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    now(),
    actor,
    entity,
    String(entityId),
    action,
    before === undefined || before === null ? null : JSON.stringify(before),
    after === undefined || after === null ? null : JSON.stringify(after),
  );
}

async function listHistory(env, limitParam) {
  const limit = Math.min(Math.max(parseInt(limitParam || "50", 10) || 50, 1), 200);
  const { results } = await env.DB.prepare(
    "SELECT id, at, actor, entity, entity_id, action, before, after FROM history ORDER BY id DESC LIMIT ?",
  ).bind(limit).all();
  return results.map((r) => ({
    ...r,
    before: r.before ? JSON.parse(r.before) : null,
    after: r.after ? JSON.parse(r.after) : null,
  }));
}

// Only edits can be reverted; deletions are undone from the trash.
async function revertHistory(env, actor, historyId) {
  const entry = await env.DB.prepare("SELECT * FROM history WHERE id = ?").bind(historyId).first();
  if (!entry) throw new HttpError(404, "기록을 찾을 수 없습니다.");
  if (entry.action !== "update" || !entry.before) throw new HttpError(400, "수정 기록만 되돌릴 수 있습니다.");
  const before = JSON.parse(entry.before);
  if (entry.entity === "node") return updateNode(env, actor, entry.entity_id, { data: before.data }, "revert");
  if (entry.entity === "note") {
    const { text, color, x, y, node_id } = before;
    return updateNote(env, actor, Number(entry.entity_id), { text, color, x, y, node_id }, "revert");
  }
  throw new HttpError(400, "되돌릴 수 없는 기록입니다.");
}

// ---------- Graph ----------

async function getNode(env, id) {
  return env.DB.prepare("SELECT id, data, deleted_at FROM nodes WHERE id = ?").bind(id).first();
}

async function requireLiveNode(env, id, label = "노드") {
  const row = await getNode(env, id);
  if (!row || row.deleted_at) throw new HttpError(404, `${label}를 찾을 수 없습니다: ${id}`);
  return row;
}

async function loadGraph(env) {
  const [meta, nodeRows, edgeRows] = await env.DB.batch([
    env.DB.prepare("SELECT value FROM meta WHERE key = 'context'"),
    env.DB.prepare("SELECT id, data, deleted_at FROM nodes ORDER BY rowid"),
    env.DB.prepare("SELECT id, source, prop, target FROM edges WHERE deleted_at IS NULL ORDER BY id"),
  ]);
  const context = meta.results[0] ? JSON.parse(meta.results[0].value) : {};
  const live = new Map();
  const deleted = new Set();
  for (const row of nodeRows.results) {
    if (row.deleted_at) deleted.add(row.id);
    else live.set(row.id, { "@id": row.id, ...JSON.parse(row.data) });
  }
  const edges = [];
  for (const e of edgeRows.results) {
    const node = live.get(e.source);
    // Skip edges whose endpoint is a deleted node; external IRIs (not in nodes) stay.
    if (!node || deleted.has(e.target)) continue;
    const ref = { "@id": e.target };
    const current = node[e.prop];
    if (current === undefined) node[e.prop] = ref;
    else node[e.prop] = (Array.isArray(current) ? current : [current]).concat(ref);
    edges.push(e);
  }
  return { doc: { "@context": context, "@graph": [...live.values()] }, edges };
}

function validateData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "data는 객체여야 합니다.");
  if (!data["@type"]) throw new HttpError(400, "data에 @type이 필요합니다.");
  for (const [key, value] of Object.entries(data)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some(isRef)) {
      throw new HttpError(400, `참조(${key})는 data가 아니라 관계로 추가해야 합니다.`);
    }
  }
  const text = JSON.stringify(data);
  if (text.length > MAX_DATA_BYTES) throw new HttpError(413, "노드 데이터가 너무 큽니다.");
  return text;
}

async function createNode(env, actor, body) {
  const id = String(body.id || "");
  if (!NODE_ID_PATTERN.test(id)) throw new HttpError(400, "노드 id 형식이 올바르지 않습니다.");
  const data = validateData(body.data);
  const existing = await getNode(env, id);
  if (existing) {
    throw new HttpError(409, existing.deleted_at ? "같은 id의 노드가 휴지통에 있습니다. 복원해 주세요." : "같은 id의 노드가 이미 있습니다.");
  }
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO nodes (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?)").bind(id, data, ts, actor),
    historyStmt(env, actor, "node", id, "create", null, { data: JSON.parse(data) }),
  ]);
  return { id };
}

async function updateNode(env, actor, id, body, action = "update") {
  const row = await requireLiveNode(env, id);
  const data = validateData(body.data);
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(data, now(), actor, id),
    historyStmt(env, actor, "node", id, action === "revert" ? "update" : action, { data: JSON.parse(row.data) }, { data: JSON.parse(data) }),
  ]);
  return { id };
}

// Deleting a node also hides its edges and attached notes, stamped with the same time so restore can bring them back together.
async function deleteNode(env, actor, id) {
  const row = await requireLiveNode(env, id);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, ts, actor, id),
    env.DB.prepare("UPDATE edges SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE (source = ? OR target = ?) AND deleted_at IS NULL").bind(ts, ts, actor, id, id),
    env.DB.prepare("UPDATE notes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE node_id = ? AND deleted_at IS NULL").bind(ts, ts, actor, id),
    historyStmt(env, actor, "node", id, "delete", { data: JSON.parse(row.data) }, { deleted_at: ts }),
  ]);
  return { id, deleted_at: ts };
}

async function restoreNode(env, actor, id) {
  const row = await getNode(env, id);
  if (!row || !row.deleted_at) throw new HttpError(404, "휴지통에 그 노드가 없습니다.");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, actor, id),
    env.DB.prepare("UPDATE edges SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE (source = ? OR target = ?) AND deleted_at = ?").bind(ts, actor, id, id, row.deleted_at),
    env.DB.prepare("UPDATE notes SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE node_id = ? AND deleted_at = ?").bind(ts, actor, id, row.deleted_at),
    historyStmt(env, actor, "node", id, "restore", { deleted_at: row.deleted_at }, { data: JSON.parse(row.data) }),
  ]);
  return { id };
}

async function createEdge(env, actor, body) {
  const source = String(body.source || "");
  const prop = String(body.prop || "");
  const target = String(body.target || "");
  if (!PROP_PATTERN.test(prop)) throw new HttpError(400, "관계 이름 형식이 올바르지 않습니다.");
  await requireLiveNode(env, source, "출발 노드");
  if (/^https?:\/\//.test(target)) {
    if (target.length > 500) throw new HttpError(400, "주소가 너무 깁니다.");
  } else {
    await requireLiveNode(env, target, "도착 노드");
  }
  const existing = await env.DB.prepare("SELECT id, deleted_at FROM edges WHERE source = ? AND prop = ? AND target = ?").bind(source, prop, target).first();
  if (existing && !existing.deleted_at) throw new HttpError(409, "같은 관계가 이미 있습니다.");
  const ts = now();
  const snapshot = { source, prop, target };
  if (existing) {
    await env.DB.batch([
      env.DB.prepare("UPDATE edges SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, actor, existing.id),
      historyStmt(env, actor, "edge", existing.id, "restore", { deleted_at: existing.deleted_at }, snapshot),
    ]);
    return { id: existing.id };
  }
  const inserted = await env.DB.prepare(
    "INSERT INTO edges (source, prop, target, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) RETURNING id",
  ).bind(source, prop, target, ts, actor).first();
  await historyStmt(env, actor, "edge", inserted.id, "create", null, snapshot).run();
  return { id: inserted.id };
}

async function getEdge(env, id) {
  return env.DB.prepare("SELECT id, source, prop, target, deleted_at FROM edges WHERE id = ?").bind(id).first();
}

async function deleteEdge(env, actor, id) {
  const edge = await getEdge(env, id);
  if (!edge || edge.deleted_at) throw new HttpError(404, "관계를 찾을 수 없습니다.");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE edges SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, ts, actor, id),
    historyStmt(env, actor, "edge", id, "delete", { source: edge.source, prop: edge.prop, target: edge.target }, { deleted_at: ts }),
  ]);
  return { id };
}

async function restoreEdge(env, actor, id) {
  const edge = await getEdge(env, id);
  if (!edge || !edge.deleted_at) throw new HttpError(404, "휴지통에 그 관계가 없습니다.");
  await requireLiveNode(env, edge.source, "출발 노드");
  if (!/^https?:\/\//.test(edge.target)) await requireLiveNode(env, edge.target, "도착 노드");
  await env.DB.batch([
    env.DB.prepare("UPDATE edges SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(now(), actor, id),
    historyStmt(env, actor, "edge", id, "restore", { deleted_at: edge.deleted_at }, { source: edge.source, prop: edge.prop, target: edge.target }),
  ]);
  return { id };
}

// ---------- Notes ----------

const NOTE_COLUMNS = "id, text, color, x, y, node_id, created_at, updated_at, updated_by";

async function listNotes(env) {
  const { results } = await env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE deleted_at IS NULL ORDER BY id`).all();
  return results;
}

async function getNote(env, id) {
  return env.DB.prepare(`SELECT ${NOTE_COLUMNS}, deleted_at FROM notes WHERE id = ?`).bind(id).first();
}

function noteFields(body, current) {
  const merged = { ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
  const text = String(merged.text ?? "");
  if (text.length > MAX_NOTE_LENGTH) throw new HttpError(413, `메모는 ${MAX_NOTE_LENGTH}자까지 쓸 수 있습니다.`);
  const color = NOTE_COLORS.includes(merged.color) ? merged.color : "yellow";
  const x = Number(merged.x);
  const y = Number(merged.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, "메모 위치가 올바르지 않습니다.");
  const node_id = merged.node_id ? String(merged.node_id) : null;
  return { text, color, x, y, node_id };
}

async function createNote(env, actor, body) {
  const fields = noteFields(body, { text: "", color: "yellow", x: 0, y: 0, node_id: null });
  if (fields.node_id) await requireLiveNode(env, fields.node_id);
  const ts = now();
  const note = await env.DB.prepare(
    `INSERT INTO notes (text, color, x, y, node_id, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${NOTE_COLUMNS}`,
  ).bind(fields.text, fields.color, fields.x, fields.y, fields.node_id, ts, ts, actor).first();
  await historyStmt(env, actor, "note", note.id, "create", null, fields).run();
  return { note };
}

async function updateNote(env, actor, id, body, action = "update") {
  const current = await getNote(env, id);
  if (!current || current.deleted_at) throw new HttpError(404, "메모를 찾을 수 없습니다.");
  const fields = noteFields(body, current);
  if (fields.node_id && fields.node_id !== current.node_id) await requireLiveNode(env, fields.node_id);
  const before = { text: current.text, color: current.color, x: current.x, y: current.y, node_id: current.node_id };
  const ts = now();
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE notes SET text = ?, color = ?, x = ?, y = ?, node_id = ?, updated_at = ?, updated_by = ? WHERE id = ? RETURNING ${NOTE_COLUMNS}`)
      .bind(fields.text, fields.color, fields.x, fields.y, fields.node_id, ts, actor, id),
    historyStmt(env, actor, "note", id, action === "revert" ? "update" : action, before, fields),
  ]);
  return { note: updated.results[0] };
}

async function deleteNote(env, actor, id) {
  const note = await getNote(env, id);
  if (!note || note.deleted_at) throw new HttpError(404, "메모를 찾을 수 없습니다.");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE notes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, ts, actor, id),
    historyStmt(env, actor, "note", id, "delete", { text: note.text, color: note.color, x: note.x, y: note.y, node_id: note.node_id }, { deleted_at: ts }),
  ]);
  return { id };
}

async function restoreNote(env, actor, id) {
  const note = await getNote(env, id);
  if (!note || !note.deleted_at) throw new HttpError(404, "휴지통에 그 메모가 없습니다.");
  if (note.node_id) await requireLiveNode(env, note.node_id, "메모가 붙은 노드");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE notes SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, actor, id),
    historyStmt(env, actor, "note", id, "restore", { deleted_at: note.deleted_at }, { text: note.text }),
  ]);
  return { note: { ...note, deleted_at: undefined } };
}

// ---------- Trash ----------

async function listTrash(env) {
  const [nodes, edges, notes] = await env.DB.batch([
    env.DB.prepare("SELECT id, data, deleted_at, updated_by FROM nodes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    // Edges hidden only because their node was deleted come back with that node, so list the rest.
    env.DB.prepare(
      `SELECT e.id, e.source, e.prop, e.target, e.deleted_at, e.updated_by FROM edges e
       WHERE e.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id IN (e.source, e.target) AND n.deleted_at IS NOT NULL)
       ORDER BY e.deleted_at DESC`,
    ),
    env.DB.prepare(
      `SELECT t.id, t.text, t.color, t.node_id, t.deleted_at, t.updated_by FROM notes t
       WHERE t.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = t.node_id AND n.deleted_at IS NOT NULL)
       ORDER BY t.deleted_at DESC`,
    ),
  ]);
  return {
    nodes: nodes.results.map((r) => ({ ...r, data: JSON.parse(r.data) })),
    edges: edges.results,
    notes: notes.results,
  };
}
