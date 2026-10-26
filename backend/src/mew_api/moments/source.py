"""What makes two moments "the same source" (K3/K8): the same YouTube video, the same PDF (by file
name), the same web page (site and path), or the same window of an app. Mirrors `sourceKey` in
packages/shared/src/destinations.ts; both are tested against source-key.cases.json."""

import re

_VIDEO = re.compile(r"^https://(?:www\.|m\.)?youtube\.com/watch\?(?:[^#]*&)?v=([\w-]{6,20})")
_SHORT = re.compile(r"^https://youtu\.be/([\w-]{6,20})")
_PAGE = re.compile(r"^https://([^/?#]+)(/[^?#]*)?")
_PDF_PATH = re.compile(r"([^/]+\.pdf)$", re.IGNORECASE)
_PDF_TITLE = re.compile(r'([^\\/:*?"<>|]+\.pdf)\b')


def source_key(app: str | None, title: str | None, url: str | None) -> str | None:
    link = url or ""
    video = _VIDEO.match(link) or _SHORT.match(link)
    if video:
        return f"youtube:{video.group(1)}"
    page = _PAGE.match(link)
    if page:
        path = page.group(2) or "/"
        file = _PDF_PATH.search(path)
        return f"pdf:{file.group(1).lower()}" if file else f"web:{page.group(1).lower()}{path}"
    name = (title or "").strip().lower()
    pdf = _PDF_TITLE.search(name) if name else None
    if pdf:
        return f"pdf:{pdf.group(1).strip()}"
    if app and name:
        return f"app:{app}:{name[:120]}"
    return None
