// titan-graph Worker: 그래프 데이터(D1)를 읽고 고치는 /api/*, 챗봇 /api/chat, 임베딩 지도용 /api/embeddings·/api/embed-chat,
// AI 도구용 MCP 서버 /mcp,
// 그리고 최신 그래프를 넣어 그려 보내는 첫 페이지(/)와 정적 파일을 함께 서비스한다.
// 읽기는 누구나, 쓰기는 편집 비밀번호로 로그인한 사용자(웹·챗봇)나 MCP 토큰을 가진 클라이언트만 할 수 있다.

import { SESSION_SECONDS, createSession, passwordMatches, readSession, sessionCookie } from "./auth.js";
import { handleMcp } from "./mcp.js";
import { handleChat } from "./chat.js";
import { embeddingsResponse, handleEmbedChat } from "./embed.js";
import {
  HttpError, assertNotLockedOut, recordLoginFailure, ensureSeeded,
  loadGraph, listNotes, listTrash, listHistory, revertHistory,
  createNode, updateNode, deleteNode, restoreNode,
  createEdge, deleteEdge, restoreEdge,
  createNote, updateNote, deleteNote, restoreNote,
} from "./store.js";

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isMcp = url.pathname === "/mcp" || url.pathname === "/mcp/";
    if (url.pathname === "/" && request.method === "GET") return renderHome(request, env);
    if (!url.pathname.startsWith("/api/") && !isMcp) return env.ASSETS.fetch(request);
    try {
      await ensureSeeded(env, request);
      if (isMcp) return await handleMcp(request, env);
      return await route(request, env, url, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "서버 오류가 발생했습니다." }, 500);
    }
  },
};

// ---------- Home page ----------

// The page ships with a snapshot of titan.jsonld; replace it with the live graph, relations and notes
// so the first paint already shows the current data. Falls back to the static page on any error.
async function renderHome(request, env) {
  const page = await env.ASSETS.fetch(request);
  if (!page.ok || !(page.headers.get("content-type") || "").includes("text/html")) return page;
  try {
    await ensureSeeded(env, request);
    const [{ doc, edges }, notes] = await Promise.all([loadGraph(env), listNotes(env)]);
    const safe = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
    const html = new HTMLRewriter()
      .on("script#titan-data", { element(el) { el.setInnerContent(safe(doc), { html: true }); } })
      .on("script#live-data", { element(el) { el.setInnerContent(safe({ edges, notes, renderedAt: new Date().toISOString() }), { html: true }); } })
      .transform(page);
    const headers = new Headers(html.headers);
    headers.set("cache-control", "no-store");
    headers.delete("etag");
    return new Response(html.body, { status: 200, headers });
  } catch (err) {
    console.error(err);
    return page;
  }
}

// ---------- Routing ----------

async function route(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const id = url.searchParams.get("id");

  if (method === "GET") {
    if (path === "/api/me") return json(await me(request, env));
    if (path === "/api/graph") return json(await loadGraph(env));
    if (path === "/api/notes") return json({ notes: await listNotes(env) });
    if (path === "/api/embeddings") return json(await embeddingsResponse(env));
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

  if (method === "POST" && path === "/api/login") return login(request, env);
  if (method === "POST" && path === "/api/chat") return handleChat(request, env, ctx, await currentUser(request, env), await readJson(request));
  if (method === "POST" && path === "/api/embed-chat") return handleEmbedChat(request, env, ctx, await currentUser(request, env), await readJson(request));
  if (method === "POST" && path === "/api/logout") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

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
  if (!env.EDIT_PASSWORD) return null;
  return readSession(request, env.EDIT_PASSWORD);
}

async function requireEditor(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(403, "편집하려면 먼저 편집 비밀번호로 로그인해야 합니다.");
  return user;
}

async function me(request, env) {
  const name = await currentUser(request, env);
  return { canEdit: !!name, name, passwordConfigured: !!env.EDIT_PASSWORD };
}

async function login(request, env) {
  if (!env.EDIT_PASSWORD) throw new HttpError(503, "편집 비밀번호가 아직 설정되지 않았습니다.");
  const body = await readJson(request);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  await assertNotLockedOut(env, ip);
  if (!(await passwordMatches(String(body.password || ""), env.EDIT_PASSWORD))) {
    await recordLoginFailure(env, ip);
    throw new HttpError(401, "비밀번호가 맞지 않습니다.");
  }
  const name = String(body.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "편집자";
  const token = await createSession(env.EDIT_PASSWORD, name);
  return json({ canEdit: true, name }, 200, { "set-cookie": sessionCookie(token, SESSION_SECONDS) });
}
