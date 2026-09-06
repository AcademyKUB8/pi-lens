---
section: Fixed
---

- **The bundled skills now actually load after an install (closes #2587)** —
  the `pi.skills` manifest entry pointed at `../../skills`, which resolves
  *outside* the published package on every install layout (npm, `git:` clones,
  managed extension caches), so pi silently registered none of the four
  shipped pi-lens skills — `pi-lens-ast-grep`, `pi-lens-lsp-navigation`,
  `pi-lens-write-ast-grep-rule`, `pi-lens-write-tree-sitter-rule` — on any
  release from 3.8.51 onward. pi resolves a non-glob manifest entry against
  the package root, so the entry is back to `./skills` and all four register
  again.
