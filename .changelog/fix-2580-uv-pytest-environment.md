---
section: Fixed
---

- **Run pytest in uv-managed project environments (closes #2580)** — pytest now honors `UV_PROJECT_ENVIRONMENT` and uv workspace environments for a directory that is itself a uv project root, with a relative `UV_PROJECT_ENVIRONMENT` resolved from that project's workspace root rather than the current directory. A directory that merely sits *below* a Python project — a `frontend/` beside the `pyproject.toml`, a workspace root's `docs/` — inherits nothing from it and keeps its own `.venv`, an activated `VIRTUAL_ENV`, or the generic `python`. An exported `UV_PROJECT_ENVIRONMENT` (uv's documented CI and Docker recipe) therefore no longer captures unrelated checkouts and subdirectories, and only a uv workspace's declared, non-excluded members inherit its `.venv`. Pytest exit code 4 reports a configuration error, while exit code 2 reports an interrupted run.
