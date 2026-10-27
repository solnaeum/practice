-- 임베딩 지도(/embed)용 벡터 캐시. key는 항목 id(node:…, note:…, doc:…), hash는 모델과 내용의 해시다.
-- vector는 int8로 줄인 벡터의 base64. Worker가 없으면 스스로 만든다.
CREATE TABLE IF NOT EXISTS embeddings (
  key TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  vector TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
