import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	extractTomlTableSection,
	hasTomlTable,
	parseTomlStringArray,
} from "./cargo-manifest.js";
import { minimatch } from "./deps/minimatch.js";
import { isAtOrAboveHomeDir, toPosix, walkUpDirs } from "./path-utils.js";

export type PythonEnvironmentSource =
	| "virtual-env"
	| "conda"
	| "project-dot-venv"
	| "project-venv"
	| "uv-project-environment"
	| "uv-workspace";

export interface PythonEnvironment {
	root: string;
	binDir: string;
	pythonPath: string;
	source: PythonEnvironmentSource;
}

interface UvWorkspace {
	/** The workspace root — the project itself unless an ancestor declares one. */
	root: string;
	/** True when {@link root} declares `[tool.uv.workspace]`. */
	explicit: boolean;
	/** The nearest ancestor (inclusive) holding a `pyproject.toml`. */
	projectRoot: string;
	members: string[];
	exclude: string[];
}

const UV_WORKSPACE_TABLE = "tool\\.uv\\.workspace";

/**
 * Resolve the uv workspace root using the same discovery shape as uv:
 * start at the nearest pyproject, then continue upward for an explicit
 * `[tool.uv.workspace]` declaration. A nearest pyproject without that table
 * is an implicit single-project workspace.
 *
 * The walk stops AT `homeDir` (`isAtOrAboveHomeDir`, the shared ceiling
 * primitive from #625) so a `pyproject.toml` sitting in `/tmp`, `/home`, or
 * `$HOME` itself cannot supply the environment for every project beneath it.
 * `homeDir` is injected rather than read from `os.homedir()` inside the walk
 * for the same reason every sibling walker takes it (#2536, #2544 F2): the
 * ceiling is otherwise untestable.
 */
async function findUvWorkspace(
	startDir: string,
	homeDir: string,
): Promise<UvWorkspace | undefined> {
	let nearestProject: string | undefined;
	for (const dir of walkUpDirs(startDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;

		let content: string;
		try {
			content = await readFile(path.join(dir, "pyproject.toml"), "utf8");
		} catch {
			continue;
		}

		if (!nearestProject) nearestProject = dir;
		if (hasTomlTable(content, UV_WORKSPACE_TABLE)) {
			const workspaceTable = extractTomlTableSection(
				content,
				UV_WORKSPACE_TABLE,
			);
			return {
				root: dir,
				explicit: true,
				projectRoot: nearestProject,
				members: parseTomlStringArray(workspaceTable, "members"),
				exclude: parseTomlStringArray(workspaceTable, "exclude"),
			};
		}
	}

	return nearestProject
		? {
				root: nearestProject,
				explicit: false,
				projectRoot: nearestProject,
				members: [],
				exclude: [],
			}
		: undefined;
}

/**
 * Apply uv's explicit-workspace membership rules before inheriting its root
 * environment. The workspace root is always a member; descendants must match
 * a declared member glob and must not match an exclusion glob.
 *
 * The glob dialect is pinned to uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
 * `crates/uv-workspace/src/workspace.rs` `is_included_in_workspace`: patterns
 * are normalized first (`normalize_path`, so a leading `./` is not part of the
 * pattern) and matched with `MatchOptions { require_literal_separator: true,
 * ..MatchOptions::new() }` — case-SENSITIVE on every platform, `*`/`?` confined
 * to one path component, and no literal-leading-dot requirement. minimatch's
 * defaults are that dialect exactly once `dot: true` is set, so no options
 * beyond `dot` are passed: a `nocase` flag here would diverge from uv on
 * Windows rather than match it.
 *
 * KNOWN LIMITATION (documented rather than implemented, same shape as
 * `matchesCargoWorkspacePattern`'s `**` note): uv matches `exclude` with
 * `Pattern::matches_path`, i.e. `MatchOptions::new()` defaults, where
 * `require_literal_separator` is FALSE and a `*` therefore crosses `/`.
 * minimatch cannot express that, so an exclusion glob relying on a
 * separator-crossing `*` (`exclude = ['packages/a*c']` for `packages/a/b/c`)
 * under-excludes: the project keeps its own environment instead of being
 * excluded from a workspace it was already not going to inherit. Both
 * outcomes fall back to the project's own `.venv`.
 */
function isUvWorkspaceMember(
	workspace: UvWorkspace,
	projectRoot: string,
): boolean {
	if (projectRoot === workspace.root) return true;

	const relative = toPosix(path.relative(workspace.root, projectRoot));
	if (
		relative.length === 0 ||
		relative === ".." ||
		relative.startsWith("../") ||
		path.isAbsolute(relative)
	) {
		return false;
	}

	const matches = (pattern: string): boolean =>
		minimatch(relative, path.posix.normalize(toPosix(pattern)), { dot: true });
	return !workspace.exclude.some(matches) && workspace.members.some(matches);
}

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
	homeDir: string = os.homedir(),
): Promise<PythonEnvironment | undefined> {
	const root = path.resolve(projectRoot);
	const uvWorkspace = await findUvWorkspace(root, homeDir);
	// Only a DECLARED, non-excluded member of an explicit workspace inherits
	// that workspace's `.venv` and resolves `UV_PROJECT_ENVIRONMENT` against
	// the workspace root; every other project is its own single-project
	// workspace rooted at its own `pyproject.toml`.
	const memberWorkspaceRoot =
		uvWorkspace?.explicit === true &&
		isUvWorkspaceMember(uvWorkspace, uvWorkspace.projectRoot)
			? uvWorkspace.root
			: undefined;
	// `UV_PROJECT_ENVIRONMENT` is a uv PROJECT setting: uv reads it only after
	// discovering a `pyproject.toml`, and resolves a relative value against
	// that project's workspace root — never against the cwd, and never for a
	// directory with no project above it. Exporting it process-wide is uv's
	// own documented CI/Docker recipe, so an unconditional candidate would let
	// one image-level variable hijack every unrelated checkout on the box.
	const uvEnvironmentRoot = uvWorkspace
		? (memberWorkspaceRoot ?? uvWorkspace.projectRoot)
		: undefined;
	const uvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
	// PEP 723 `uv run --script` environments are cache-keyed by script content;
	// without a stable project marker or explicit path, they remain undiscoverable.
	const candidates: Array<{
		root: string | undefined;
		source: PythonEnvironmentSource;
	}> = [
		...(uvEnvironmentRoot !== undefined && uvProjectEnvironment
			? [
					{
						// `path.resolve` leaves an absolute value untouched and
						// anchors a relative one at the project's workspace root.
						root: path.resolve(uvEnvironmentRoot, uvProjectEnvironment),
						source: "uv-project-environment" as const,
					},
				]
			: []),
		...(memberWorkspaceRoot !== undefined
			? [
					{
						root: path.join(memberWorkspaceRoot, ".venv"),
						source: "uv-workspace" as const,
					},
				]
			: []),
		{ root: process.env.VIRTUAL_ENV, source: "virtual-env" },
		{ root: process.env.CONDA_PREFIX, source: "conda" },
		{ root: path.join(root, ".venv"), source: "project-dot-venv" },
		{ root: path.join(root, "venv"), source: "project-venv" },
	];

	for (const candidate of candidates) {
		if (!candidate.root) continue;
		const binDir = path.join(
			candidate.root,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		try {
			await access(pythonPath);
			return {
				root: candidate.root,
				binDir,
				pythonPath,
				source: candidate.source,
			};
		} catch {
			// The marker can outlive its environment. Continue to the next candidate.
		}
	}

	return undefined;
}

/** Preserve the existing interpreter-only API used by LSP initialization. */
export async function detectPythonVenv(
	projectRoot: string,
): Promise<string | undefined> {
	return (await detectPythonEnvironment(projectRoot))?.pythonPath;
}

/**
 * Build a child-only environment for Python tools. The host process remains
 * unchanged, so another project can resolve a different environment.
 */
export function augmentPythonEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
	environment: PythonEnvironment | undefined,
): NodeJS.ProcessEnv {
	if (!environment) return baseEnvironment;

	const inheritedPath =
		baseEnvironment.PATH ?? baseEnvironment.Path ?? baseEnvironment.path ?? "";
	const augmentedPath = inheritedPath
		? `${environment.binDir}${path.delimiter}${inheritedPath}`
		: environment.binDir;
	const childEnvironment: NodeJS.ProcessEnv = {
		...baseEnvironment,
		PATH: augmentedPath,
		VIRTUAL_ENV: environment.root,
	};
	if (process.platform === "win32") childEnvironment.Path = augmentedPath;
	return childEnvironment;
}

/** Return explicit project-environment candidates before a bare PATH fallback. */
export function pythonEnvironmentToolCandidates(
	environment: PythonEnvironment | undefined,
	command: string,
): string[] {
	if (!environment) return [];
	if (process.platform !== "win32") {
		return [path.join(environment.binDir, command)];
	}
	return [
		path.join(environment.binDir, `${command}.exe`),
		path.join(environment.binDir, `${command}.cmd`),
		path.join(environment.binDir, command),
	];
}
