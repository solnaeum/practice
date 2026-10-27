// 그래프 저장소: D1에 있는 노드, 관계, 메모, 변경 기록을 읽고 고친다.
// 웹 API(index.js)와 MCP 서버(mcp.js)가 함께 쓴다. actor는 변경 기록에 남을 이름이다.

const NOTE_COLORS = ["yellow", "pink", "blue", "green"];
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,199}$/;
const PROP_PATTERN = /^[A-Za-z][A-Za-z0-9_:.-]{0,99}$/;
const MAX_NOTE_LENGTH = 2000;
const MAX_DATA_BYTES = 20000;
export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const now = () => new Date().toISOString();

// ---------- First-run seeding ----------

// An empty database is filled from the deployed titan.jsonld on the first API request.
let seeded = false;

export async function ensureSeeded(env, request) {
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

export const isRef = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "@id" in v;

// ---------- Login attempt limits ----------

// Failed password or token attempts are counted per IP so secrets cannot be guessed quickly.
export async function assertNotLockedOut(env, ip) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at TEXT NOT NULL)").run();
  const { n } = await env.DB.prepare("SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?").bind(ip, since).first();
  if (n >= MAX_LOGIN_FAILURES) throw new HttpError(429, "로그인 시도가 너무 많습니다. 15분 뒤에 다시 해 주세요.");
}

export async function recordLoginFailure(env, ip) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(ip, now()),
    env.DB.prepare("DELETE FROM login_failures WHERE at <= ?").bind(since),
  ]);
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

export async function listHistory(env, limitParam) {
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
export async function revertHistory(env, actor, historyId) {
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

export async function getNode(env, id) {
  return env.DB.prepare("SELECT id, data, deleted_at FROM nodes WHERE id = ?").bind(id).first();
}

async function requireLiveNode(env, id, label = "노드") {
  const row = await getNode(env, id);
  if (!row || row.deleted_at) throw new HttpError(404, `${label}를 찾을 수 없습니다: ${id}`);
  return row;
}

export async function loadGraph(env) {
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

export async function createNode(env, actor, body) {
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

export async function updateNode(env, actor, id, body, action = "update") {
  const row = await requireLiveNode(env, id);
  const data = validateData(body.data);
  await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(data, now(), actor, id),
    historyStmt(env, actor, "node", id, action === "revert" ? "update" : action, { data: JSON.parse(row.data) }, { data: JSON.parse(data) }),
  ]);
  return { id };
}

// Deleting a node also hides its edges and attached notes, stamped with the same time so restore can bring them back together.
export async function deleteNode(env, actor, id) {
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

export async function restoreNode(env, actor, id) {
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

export async function createEdge(env, actor, body) {
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

export async function getEdge(env, id) {
  return env.DB.prepare("SELECT id, source, prop, target, deleted_at FROM edges WHERE id = ?").bind(id).first();
}

export async function deleteEdge(env, actor, id) {
  const edge = await getEdge(env, id);
  if (!edge || edge.deleted_at) throw new HttpError(404, "관계를 찾을 수 없습니다.");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE edges SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, ts, actor, id),
    historyStmt(env, actor, "edge", id, "delete", { source: edge.source, prop: edge.prop, target: edge.target }, { deleted_at: ts }),
  ]);
  return { id };
}

export async function restoreEdge(env, actor, id) {
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

export async function listNotes(env) {
  const { results } = await env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE deleted_at IS NULL ORDER BY id`).all();
  return results;
}

export async function getNote(env, id) {
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

export async function createNote(env, actor, body) {
  const fields = noteFields(body, { text: "", color: "yellow", x: 0, y: 0, node_id: null });
  if (fields.node_id) await requireLiveNode(env, fields.node_id);
  const ts = now();
  const note = await env.DB.prepare(
    `INSERT INTO notes (text, color, x, y, node_id, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${NOTE_COLUMNS}`,
  ).bind(fields.text, fields.color, fields.x, fields.y, fields.node_id, ts, ts, actor).first();
  await historyStmt(env, actor, "note", note.id, "create", null, fields).run();
  return { note };
}

export async function updateNote(env, actor, id, body, action = "update") {
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

export async function deleteNote(env, actor, id) {
  const note = await getNote(env, id);
  if (!note || note.deleted_at) throw new HttpError(404, "메모를 찾을 수 없습니다.");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE notes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(ts, ts, actor, id),
    historyStmt(env, actor, "note", id, "delete", { text: note.text, color: note.color, x: note.x, y: note.y, node_id: note.node_id }, { deleted_at: ts }),
  ]);
  return { id };
}

export async function restoreNote(env, actor, id) {
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

export async function listTrash(env) {
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
