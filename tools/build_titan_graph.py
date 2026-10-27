"""titan.jsonld를 graph_template.html에 넣어 titan_graph.html을 만든다.

Cloudflare 배포용 public/ 폴더(index.html, titan.jsonld)도 함께 만든다.

사용법: python3 tools/build_titan_graph.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "titan.jsonld"
TEMPLATE = Path(__file__).resolve().parent / "graph_template.html"
OUTPUT = ROOT / "titan_graph.html"
PUBLIC = ROOT / "public"
PLACEHOLDER = "/*__TITAN_JSONLD__*/"


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    # Escape "</" so the JSON cannot close the surrounding <script> tag.
    payload = json.dumps(data, ensure_ascii=False, indent=2).replace("</", "<\\/")
    template = TEMPLATE.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        raise SystemExit(f"{TEMPLATE.name}에 {PLACEHOLDER} 자리 표시자가 없습니다.")
    html = template.replace(PLACEHOLDER, payload)
    OUTPUT.write_text(html, encoding="utf-8")
    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / "index.html").write_text(html, encoding="utf-8")
    (PUBLIC / "titan.jsonld").write_text(DATA.read_text(encoding="utf-8"), encoding="utf-8")
    for path in (OUTPUT, PUBLIC / "index.html", PUBLIC / "titan.jsonld"):
        print(f"{path.relative_to(ROOT)} 생성 완료")


if __name__ == "__main__":
    main()
