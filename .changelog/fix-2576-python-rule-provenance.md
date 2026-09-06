---
section: Fixed
---

- **Extend Python SQL-rule safe-builder recognition with same-file provenance (fixes #2576)** — valid SQLAlchemy imports and `select()` calls no longer receive unrelated diagnostics, and `stmt = select(User); db.execute(stmt)` is quiet when the receiver is a proven `Session`/`AsyncSession`. `Session.query` and psycopg identifier composition are suppressed only when same-file AST evidence proves the safe API; the existing `session.execute(...)` and builder-call exemptions are unchanged. Raw, dynamic, shadowed, and ambiguous SQL remains diagnostic.
