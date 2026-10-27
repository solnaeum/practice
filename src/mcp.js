// AI 도구용 MCP 서버 (Streamable HTTP, 세션 없음).
// POST /mcp 로 JSON-RPC 메시지를 받아 그래프 읽기·쓰기 도구를 제공한다.
// 읽기 도구는 누구나, 쓰기 도구는 MCP_TOKEN(Worker Secret)을 Bearer 토큰으로 보낸 클라이언트만 쓸 수 있다.

import { passwordMatches } from "./auth.js";
import {
  HttpError, assertNotLockedOut, recordLoginFailure, isRef,
  loadGraph, getNode, listNotes, listTrash, listHistory, revertHistory,
  createNode, updateNode, deleteNode, restoreNode,
  createEdge, deleteEdge, restoreEdge,
  createNote, updateNote, deleteNote, restoreNote,
} from "./store.js";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_ACTOR = "AI (MCP)";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};
const ONTOLOGY_TYPES = new Set(["rdf:Property", "rdfs:Class", "owl:Ontology"]);
const ID_PREFIX = {
  TVSeries: "work/", TVSeason: "work/", Book: "work/", ComicSeries: "work/", Periodical: "work/", CreativeWork: "work/",
  "giant:FictionalCharacter": "character/", Person: "person/", Organization: "org/", "giant:FictionalOrganization": "org/",
  Country: "place/", Place: "place/", "giant:FictionalPlace": "place/", "giant:Species": "species/", "giant:Theme": "theme/",
};

const INSTRUCTIONS = `「진격의 거인」과 「걸리버 여행기」의 거인 이야기를 schema.org 기반 JSON-LD 그래프로 담은 서버입니다.
노드 id는 'work/attack-on-titan', 'character/eren-yeager'처럼 종류/이름 형식이고, 관계 이름은 schema.org 속성(예: character, author)이나 'giant:' 접두사 속성(예: giant:hasTheme)입니다.
먼저 graph_overview나 search_nodes로 id를 찾은 뒤 get_node로 자세한 내용과 관계 id를 보세요.
쓰기 도구는 MCP 토큰이 필요하며, 삭제는 휴지통으로 가므로 restore_* 도구로 되돌릴 수 있습니다.`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
}

export async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") {
    return new Response("이 주소는 MCP 서버입니다. AI 도구에서 POST로 연결하세요. 연결 안내: /connect\n", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", allow: "POST, OPTIONS", ...CORS },
    });
  }

  const actor = await authorize(request, env);
  let message;
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON을 읽을 수 없습니다." } }, 400);
  }
  const batch = Array.isArray(message);
  const replies = [];
  for (const m of batch ? message : [message]) {
    const reply = await handleMessage(m, env, actor);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202, headers: CORS });
  return json(batch ? replies : replies[0]);
}

// No token means read-only access; a wrong token is rejected and counted like a failed login.
async function authorize(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || new URL(request.url).searchParams.get("token");
  if (!token) return null;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  await assertNotLockedOut(env, ip);
  if (!env.MCP_TOKEN || !(await passwordMatches(token, env.MCP_TOKEN))) {
    await recordLoginFailure(env, ip);
    throw new HttpError(401, env.MCP_TOKEN ? "MCP 토큰이 맞지 않습니다." : "이 서버에는 아직 MCP 토큰이 설정되지 않았습니다. 토큰 없이 연결하면 읽기 도구를 쓸 수 있습니다.");
  }
  return MCP_ACTOR;
}

async function handleMessage(msg, env, actor) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id ?? null, -32600, "잘못된 JSON-RPC 요청입니다.") : null;
  }
  const isNotification = !("id" in msg);
  const params = msg.params || {};
  let result;
  switch (msg.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      result = {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "titan-graph", title: "거인 이야기 그래프", version: "1.0.0" },
        instructions: INSTRUCTIONS + (actor ? "\n이 연결은 쓰기 권한이 있습니다." : "\n이 연결은 읽기 전용입니다 (토큰 없음)."),
      };
      break;
    }
    case "ping": result = {}; break;
    case "tools/list": result = { tools: TOOLS.map(({ run, write, ...t }) => t) }; break;
    case "tools/call": result = await callTool(params, env, actor); break;
    case "resources/list": result = { resources: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `지원하지 않는 메서드입니다: ${msg.method}`);
  }
  return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callTool(params, env, actor) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return toolError(`없는 도구입니다: ${params.name}`);
  if (tool.write && !actor) {
    return toolError("쓰기 도구는 MCP 토큰이 필요합니다. 연결 설정에 'Authorization: Bearer <MCP_TOKEN>' 헤더를 넣어 주세요.");
  }
  try {
    const result = await tool.run(env, params.arguments || {}, actor);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message);
    console.error(err);
    return toolError("서버 오류가 발생했습니다.");
  }
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------- Helpers ----------

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const plainName = (node) => asArray(node.name ?? node["rdfs:label"]).map((n) => (typeof n === "string" ? n : n?.["@value"])).find(Boolean) || node["@id"];
const typesOf = (node) => asArray(node["@type"]);
const isOntologyTerm = (node) => typesOf(node).some((t) => ONTOLOGY_TYPES.has(t));

function requireString(args, key) {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${key}가 필요합니다.`);
  return v.trim();
}

function literalData(raw) {
  const data = {};
  for (const [k, v] of Object.entries(JSON.parse(raw))) data[k] = v;
  return data;
}

// Set the plain (default language) value of a possibly multilingual field, keeping other languages.
function withPlain(value, text) {
  const others = asArray(value).filter((v) => typeof v !== "string");
  const list = text ? [text, ...others] : others;
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
}

function withEnglish(value, text) {
  const others = asArray(value).filter((v) => !(v && typeof v === "object" && v["@language"] === "en"));
  const list = text ? [...others, { "@value": text, "@language": "en" }] : others;
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
}

function summarize(node) {
  return { id: node["@id"], type: typesOf(node).join(", "), name: plainName(node) };
}

async function nodeView(env, id) {
  const { doc, edges } = await loadGraph(env);
  const node = doc["@graph"].find((n) => n["@id"] === id);
  if (!node) throw new HttpError(404, `노드를 찾을 수 없습니다: ${id}`);
  const byId = new Map(doc["@graph"].map((n) => [n["@id"], n]));
  const name = (x) => (byId.has(x) ? plainName(byId.get(x)) : x);
  const properties = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "@id") continue;
    const lits = asArray(v).filter((x) => !isRef(x));
    if (lits.length) properties[k] = Array.isArray(v) && lits.length > 1 ? lits : lits[0];
  }
  const notes = (await listNotes(env)).filter((n) => n.node_id === id).map(({ id: noteId, text, color }) => ({ id: noteId, text, color }));
  return {
    id,
    type: typesOf(node),
    name: plainName(node),
    properties,
    outgoing: edges.filter((e) => e.source === id).map((e) => ({ relation_id: e.id, prop: e.prop, target: e.target, target_name: name(e.target) })),
    incoming: edges.filter((e) => e.target === id).map((e) => ({ relation_id: e.id, prop: e.prop, source: e.source, source_name: name(e.source) })),
    notes,
  };
}

// ---------- Tools ----------

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description, minimum: 1 });

const TOOLS = [
  {
    name: "graph_overview",
    title: "그래프 개요",
    description: "그래프에 있는 노드를 종류별 개수와 함께 모두 나열합니다 (id, 종류, 이름). 온톨로지 정의(클래스·속성)는 개수만 보여 줍니다.",
    inputSchema: obj({}),
    annotations: READ,
    async run(env) {
      const { doc, edges } = await loadGraph(env);
      const entities = doc["@graph"].filter((n) => !isOntologyTerm(n));
      const byType = {};
      entities.forEach((n) => typesOf(n).forEach((t) => (byType[t] = (byType[t] || 0) + 1)));
      return {
        node_count: entities.length,
        relation_count: edges.length,
        ontology_term_count: doc["@graph"].length - entities.length,
        note_count: (await listNotes(env)).length,
        types: byType,
        nodes: entities.map(summarize),
      };
    },
  },
  {
    name: "search_nodes",
    title: "노드 검색",
    description: "이름(모든 언어), 다른 이름, 설명, id에서 검색어를 찾아 노드를 최대 20개 돌려줍니다.",
    inputSchema: obj({ query: str("검색어 (예: 거인, Eren, 걸리버)"), type: str("이 종류만 찾기 (선택, 예: giant:FictionalCharacter, Book)") }, ["query"]),
    annotations: READ,
    async run(env, args) {
      const q = requireString(args, "query").toLowerCase();
      const { doc } = await loadGraph(env);
      const hits = doc["@graph"].filter((n) => {
        if (isOntologyTerm(n)) return false;
        if (args.type && !typesOf(n).includes(args.type)) return false;
        const text = [n["@id"], n.name, n.alternateName, n.description].flatMap(asArray).map((v) => (typeof v === "string" ? v : v?.["@value"] || "")).join(" ").toLowerCase();
        return text.includes(q);
      });
      return { count: hits.length, results: hits.slice(0, 20).map(summarize) };
    },
  },
  {
    name: "get_node",
    title: "노드 자세히 보기",
    description: "노드의 속성, 나가는·들어오는 관계(relation_id 포함), 붙은 메모를 돌려줍니다.",
    inputSchema: obj({ id: str("노드 id (예: character/eren-yeager)") }, ["id"]),
    annotations: READ,
    run: (env, args) => nodeView(env, requireString(args, "id")),
  },
  {
    name: "list_notes",
    title: "메모 목록",
    description: "그래프에 붙은 포스트잇 메모를 모두 돌려줍니다.",
    inputSchema: obj({}),
    annotations: READ,
    run: async (env) => ({ notes: await listNotes(env) }),
  },
  {
    name: "list_trash",
    title: "휴지통 보기",
    description: "삭제된 노드, 관계, 메모 목록입니다. restore_* 도구로 되살릴 수 있습니다.",
    inputSchema: obj({}),
    annotations: READ,
    run: (env) => listTrash(env),
  },
  {
    name: "list_history",
    title: "변경 기록",
    description: "최근 변경 기록(누가, 언제, 무엇을)을 최신순으로 돌려줍니다. 수정 기록은 revert_change로 되돌릴 수 있습니다.",
    inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 200, description: "가져올 개수 (기본 30)" } }),
    annotations: READ,
    run: async (env, args) => ({ history: await listHistory(env, String(args.limit || 30)) }),
  },
  {
    name: "export_jsonld",
    title: "JSON-LD 내보내기",
    description: "현재 그래프 전체를 schema.org 기반 JSON-LD 문서로 돌려줍니다.",
    inputSchema: obj({}),
    annotations: READ,
    run: async (env) => (await loadGraph(env)).doc,
  },
  {
    name: "create_node",
    title: "노드 추가",
    write: true,
    description: "새 노드를 추가합니다. id를 생략하면 종류와 이름으로 만듭니다 (예: character/reiner-braun). 관계는 add_relation으로 따로 잇습니다.",
    inputSchema: obj({
      type: str("schema.org 또는 giant: 종류 (예: giant:FictionalCharacter, Person, Book, giant:FictionalPlace, giant:Species, giant:Theme)"),
      name: str("한국어 이름"),
      name_en: str("영어 이름 (선택)"),
      description: str("설명 (선택)"),
      id: str("노드 id (선택)"),
      properties: { type: "object", description: "그 밖의 리터럴 속성 (선택, 예: {\"startDate\": \"2013-04-07\"})" },
    }, ["type", "name"]),
    annotations: WRITE,
    async run(env, args, actor) {
      const type = requireString(args, "type");
      const name = requireString(args, "name");
      let id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : null;
      if (!id) {
        const slug = String(args.name_en || name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "n" + Date.now().toString(36);
        const prefix = ID_PREFIX[type] || "node/";
        id = prefix + slug;
        for (let i = 2; await getNode(env, id); i++) id = `${prefix}${slug}-${i}`;
      }
      const data = { ...(args.properties || {}), "@type": type, name: args.name_en ? [name, { "@value": args.name_en, "@language": "en" }] : name };
      if (args.description) data.description = args.description;
      await createNode(env, actor, { id, data });
      return nodeView(env, id);
    },
  },
  {
    name: "update_node",
    title: "노드 수정",
    write: true,
    description: "노드의 이름, 영어 이름, 설명, 그 밖의 리터럴 속성을 고칩니다. 넘긴 값만 바뀌고, 값을 null로 주면 그 속성을 지웁니다.",
    inputSchema: obj({
      id: str("노드 id"),
      name: { type: ["string", "null"], description: "한국어 이름" },
      name_en: { type: ["string", "null"], description: "영어 이름" },
      description: { type: ["string", "null"], description: "설명" },
      properties: { type: "object", description: "그 밖의 리터럴 속성. null 값은 삭제" },
    }, ["id"]),
    annotations: WRITE,
    async run(env, args, actor) {
      const id = requireString(args, "id");
      const row = await getNode(env, id);
      if (!row || row.deleted_at) throw new HttpError(404, `노드를 찾을 수 없습니다: ${id}`);
      const data = literalData(row.data);
      const set = (key, value) => { if (value === undefined || value === null) delete data[key]; else data[key] = value; };
      if ("name" in args) set("name", withPlain(data.name, args.name || null));
      if ("name_en" in args) set("name", withEnglish(data.name, args.name_en || null));
      if ("description" in args) set("description", args.description || undefined);
      for (const [k, v] of Object.entries(args.properties || {})) {
        if (k === "@id" || k === "@type") throw new HttpError(400, `${k}는 바꿀 수 없습니다.`);
        set(k, v);
      }
      await updateNode(env, actor, id, { data });
      return nodeView(env, id);
    },
  },
  {
    name: "delete_node",
    title: "노드 삭제",
    write: true,
    description: "노드를 휴지통으로 옮깁니다. 연결된 관계와 붙은 메모도 함께 옮겨지고, restore_node로 같이 되살아납니다.",
    inputSchema: obj({ id: str("노드 id") }, ["id"]),
    annotations: DELETE,
    run: (env, args, actor) => deleteNode(env, actor, requireString(args, "id")),
  },
  {
    name: "restore_node",
    title: "노드 복원",
    write: true,
    description: "휴지통의 노드를 함께 지워진 관계·메모와 함께 되살립니다.",
    inputSchema: obj({ id: str("노드 id") }, ["id"]),
    annotations: WRITE,
    run: (env, args, actor) => restoreNode(env, actor, requireString(args, "id")),
  },
  {
    name: "add_relation",
    title: "관계 추가",
    write: true,
    description: "두 노드를 관계로 잇습니다. target은 노드 id나 https:// 주소입니다. 예: source=work/attack-on-titan, prop=character, target=character/reiner-braun",
    inputSchema: obj({ source: str("출발 노드 id"), prop: str("관계 이름 (예: character, author, giant:hasTheme, knows)"), target: str("도착 노드 id 또는 https:// 주소") }, ["source", "prop", "target"]),
    annotations: WRITE,
    run: (env, args, actor) => createEdge(env, actor, { source: requireString(args, "source"), prop: requireString(args, "prop"), target: requireString(args, "target") }),
  },
  {
    name: "delete_relation",
    title: "관계 삭제",
    write: true,
    description: "관계를 휴지통으로 옮깁니다. relation_id(get_node에서 확인)나 source·prop·target으로 지정합니다.",
    inputSchema: obj({ relation_id: int("관계 id"), source: str("출발 노드 id"), prop: str("관계 이름"), target: str("도착 노드 id") }),
    annotations: DELETE,
    async run(env, args, actor) {
      let id = args.relation_id;
      if (!id) {
        const { edges } = await loadGraph(env);
        const found = edges.find((e) => e.source === args.source && e.prop === args.prop && e.target === args.target);
        if (!found) throw new HttpError(404, "그 관계를 찾을 수 없습니다.");
        id = found.id;
      }
      return deleteEdge(env, actor, id);
    },
  },
  {
    name: "restore_relation",
    title: "관계 복원",
    write: true,
    description: "휴지통의 관계를 되살립니다.",
    inputSchema: obj({ relation_id: int("관계 id") }, ["relation_id"]),
    annotations: WRITE,
    run: (env, args, actor) => restoreEdge(env, actor, args.relation_id),
  },
  {
    name: "add_note",
    title: "메모 붙이기",
    write: true,
    description: "포스트잇 메모를 붙입니다. node_id를 주면 그 노드 옆에 붙고, 없으면 그래프 가운데에 놓입니다. 화면에서 끌어 옮길 수 있습니다.",
    inputSchema: obj({ text: str("메모 내용 (2000자까지)"), node_id: str("붙일 노드 id (선택)"), color: { type: "string", enum: ["yellow", "pink", "blue", "green"], description: "색 (기본 yellow)" } }, ["text"]),
    annotations: WRITE,
    // x = y = 0 lets the page place the note next to its node (or in the middle) until someone moves it.
    run: (env, args, actor) => createNote(env, actor, { text: requireString(args, "text"), color: args.color, node_id: args.node_id || null, x: 0, y: 0 }),
  },
  {
    name: "update_note",
    title: "메모 수정",
    write: true,
    description: "메모의 내용, 색, 붙은 노드를 고칩니다. 넘긴 값만 바뀝니다.",
    inputSchema: obj({ note_id: int("메모 id"), text: str("새 내용"), color: { type: "string", enum: ["yellow", "pink", "blue", "green"] }, node_id: { type: ["string", "null"], description: "붙일 노드 id (null이면 떼기)" } }, ["note_id"]),
    annotations: WRITE,
    run: (env, args, actor) => updateNote(env, actor, args.note_id, { text: args.text, color: args.color, node_id: args.node_id }),
  },
  {
    name: "delete_note",
    title: "메모 삭제",
    write: true,
    description: "메모를 휴지통으로 옮깁니다.",
    inputSchema: obj({ note_id: int("메모 id") }, ["note_id"]),
    annotations: DELETE,
    run: (env, args, actor) => deleteNote(env, actor, args.note_id),
  },
  {
    name: "restore_note",
    title: "메모 복원",
    write: true,
    description: "휴지통의 메모를 되살립니다.",
    inputSchema: obj({ note_id: int("메모 id") }, ["note_id"]),
    annotations: WRITE,
    run: (env, args, actor) => restoreNote(env, actor, args.note_id),
  },
  {
    name: "revert_change",
    title: "수정 되돌리기",
    write: true,
    description: "변경 기록의 수정(update) 항목을 이전 값으로 되돌립니다. history_id는 list_history에서 확인합니다.",
    inputSchema: obj({ history_id: int("변경 기록 id") }, ["history_id"]),
    annotations: WRITE,
    run: (env, args, actor) => revertHistory(env, actor, args.history_id),
  },
];
