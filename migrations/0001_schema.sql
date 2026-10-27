-- 거인 이야기 그래프 저장소 (Cloudflare D1)
-- 노드의 리터럴 값은 nodes.data(JSON)에, 노드 사이의 참조는 edges에 둔다.
-- 삭제는 deleted_at만 채우는 소프트 삭제이고, 모든 변경은 history에 남긴다.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  prop TEXT NOT NULL,
  target TEXT NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (source, prop, target)
);
CREATE INDEX IF NOT EXISTS edges_source ON edges (source);
CREATE INDEX IF NOT EXISTS edges_target ON edges (target);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  node_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS notes_node ON notes (node_id);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS history_entity ON history (entity, entity_id);

-- 편집 비밀번호 로그인 실패 기록 (IP별 시도 제한). Worker가 없으면 스스로 만든다.
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
