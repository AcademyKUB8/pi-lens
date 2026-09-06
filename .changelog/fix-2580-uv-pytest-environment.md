---
section: Fixed
---

- **Run pytest in uv-managed project environments (closes #2580)** — pytest now honors `UV_PROJECT_ENVIRONMENT` and uv workspace environments for projects that actually have a `pyproject.toml`, with a relative `UV_PROJECT_ENVIRONMENT` resolved from the project's workspace root rather than the current directory. An exported `UV_PROJECT_ENVIRONMENT` (uv's documented CI and Docker recipe) no longer overrides an unrelated checkout's own `.venv` or activated `VIRTUAL_ENV`, and only a uv workspace's declared, non-excluded members inherit its `.venv` — independent nested projects and plain subdirectories keep their own environment. Pytest exit code 4 reports a configuration error, while exit code 2 reports an interrupted run.
