import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";

type SafeSpawnAsync = (
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
) => Promise<SpawnResult>;

const { findGlobalBinary, safeSpawnAsync } = vi.hoisted(() => ({
	findGlobalBinary: vi.fn(async () => undefined),
	safeSpawnAsync: vi.fn<SafeSpawnAsync>(async () => ({
		stdout: "1 passed in 0.01s\n",
		stderr: "",
		status: 0,
	})),
}));

vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findGlobalBinary,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { detectPythonEnvironment } from "../../clients/python-environment.js";
import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";

const tempDirs: string[] = [];
let originalVirtualEnv: string | undefined;
let originalCondaPrefix: string | undefined;
let originalUvProjectEnvironment: string | undefined;

function restoreEnvironmentVariable(
	name: "VIRTUAL_ENV" | "CONDA_PREFIX" | "UV_PROJECT_ENVIRONMENT",
	value: string | undefined,
): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function createTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Materialize a venv-shaped directory (the layout `detectPythonEnvironment` probes). */
function createEnvironment(root: string): {
	root: string;
	binDir: string;
	pythonPath: string;
} {
	const binDir = path.join(
		root,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const pythonPath = path.join(
		binDir,
		process.platform === "win32" ? "python.exe" : "python",
	);
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(pythonPath, "");
	return { root, binDir, pythonPath };
}

/** Materialize a `<dir>/tests/test_example.py` and return its path. */
function createTestFile(dir: string): string {
	const testFile = path.join(dir, "tests", "test_example.py");
	fs.mkdirSync(path.dirname(testFile), { recursive: true });
	fs.writeFileSync(testFile, "def test_example():\n    assert True\n");
	return testFile;
}

function createProject(withVenv: boolean): {
	root: string;
	testFile: string;
	pythonPath: string;
	binDir: string;
} {
	const root = createTempDir("pi-lens-pytest-environment-");
	const testFile = createTestFile(root);
	const dotVenv = path.join(root, ".venv");
	const binDir = path.join(
		dotVenv,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const pythonPath = path.join(
		binDir,
		process.platform === "win32" ? "python.exe" : "python",
	);
	if (withVenv) createEnvironment(dotVenv);
	return { root, testFile, pythonPath, binDir };
}

async function runPytest(
	testFile: string,
	projectRoot: string,
): Promise<{ command: string; options: SafeSpawnOptions }> {
	await new TestRunnerClient(false).runTestFileAsync(
		testFile,
		projectRoot,
		"pytest",
		RUNNERS.pytest,
	);
	const [command, , options] = safeSpawnAsync.mock.calls[0];
	if (!options) throw new Error("pytest spawn options were not supplied");
	return { command, options };
}

describe("pytest project environment", () => {
	beforeEach(() => {
		originalVirtualEnv = process.env.VIRTUAL_ENV;
		originalCondaPrefix = process.env.CONDA_PREFIX;
		originalUvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		delete process.env.UV_PROJECT_ENVIRONMENT;
		safeSpawnAsync.mockClear();
		findGlobalBinary.mockClear();
	});

	afterEach(() => {
		restoreEnvironmentVariable("VIRTUAL_ENV", originalVirtualEnv);
		restoreEnvironmentVariable("CONDA_PREFIX", originalCondaPrefix);
		restoreEnvironmentVariable(
			"UV_PROJECT_ENVIRONMENT",
			originalUvProjectEnvironment,
		);
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs pytest with an unactivated project .venv", async () => {
		const { root, testFile, pythonPath, binDir } = createProject(true);
		const inheritedPath = process.env.PATH;
		const result = await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(result.passed).toBe(1);
		expect(safeSpawnAsync).toHaveBeenCalledOnce();
		const [command, args, options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(pythonPath);
		expect(args).toEqual(["-m", "pytest", testFile, "--tb=short", "-q"]);
		expect(options.cwd).toBe(root);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(root, ".venv"));
		expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(binDir);
		expect(process.env.VIRTUAL_ENV).toBeUndefined();
		expect(process.env.PATH).toBe(inheritedPath);
		expect(findGlobalBinary).not.toHaveBeenCalled();
	});

	it("keeps the generic Python fallback when no project environment exists", async () => {
		const { root, testFile } = createProject(false);
		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(safeSpawnAsync).toHaveBeenCalledOnce();
		const [command, args, options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe("python");
		expect(args).toEqual(["-m", "pytest", testFile, "--tb=short", "-q"]);
		expect(options.env).toBeUndefined();
	});

	it("uses an absolute UV_PROJECT_ENVIRONMENT path for a uv project", async () => {
		const { root, testFile } = createProject(false);
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[project]\nname='app'\n",
		);
		const uvEnvironment = createEnvironment(
			createTempDir("pi-lens-uv-project-env-"),
		);
		process.env.UV_PROJECT_ENVIRONMENT = uvEnvironment.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(uvEnvironment.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(uvEnvironment.root);
		expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(
			uvEnvironment.binDir,
		);
	});

	// uv's documented CI/Docker recipe exports UV_PROJECT_ENVIRONMENT process-
	// wide (docs/concepts/projects/config.md). It is a uv *project* setting:
	// `uv` only honors it after discovering a pyproject.toml, so an exported
	// value must not hijack a directory that is not a uv project at all —
	// AGENTS.md defect shape 13 (an ambient signal outranking the specific
	// one). Guard for: an exported UV_PROJECT_ENVIRONMENT outranking a
	// non-uv project's own `.venv` / activated VIRTUAL_ENV (review round 2, F1).
	it("ignores an exported UV_PROJECT_ENVIRONMENT outside a uv project", async () => {
		const { root, testFile, pythonPath } = createProject(true);
		const exported = createEnvironment(createTempDir("pi-lens-uv-ci-env-"));
		process.env.UV_PROJECT_ENVIRONMENT = exported.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(root, ".venv"));
	});

	it("keeps an activated VIRTUAL_ENV over an exported UV_PROJECT_ENVIRONMENT outside a uv project", async () => {
		const { root, testFile } = createProject(false);
		const activated = createEnvironment(
			createTempDir("pi-lens-activated-env-"),
		);
		const exported = createEnvironment(createTempDir("pi-lens-uv-ci-env-"));
		process.env.VIRTUAL_ENV = activated.root;
		process.env.UV_PROJECT_ENVIRONMENT = exported.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(activated.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(activated.root);
	});

	// uv resolves a relative UV_PROJECT_ENVIRONMENT against the workspace root
	// of the project it discovered, never against the directory it was handed
	// (uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
	// crates/uv-workspace/src/workspace.rs). pi-lens hands this resolver a
	// dispatch cwd / LSP root, which can sit BELOW the pyproject.toml that
	// defines the project (review round 2, F2).
	it("resolves a relative UV_PROJECT_ENVIRONMENT from the discovered project root", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		// Not a member of the workspace above it, so it is its own single-
		// project workspace: `.uv-env` resolves against ITS root, not against
		// the `tests/` subdirectory pi-lens happens to hand the resolver.
		const standalone = path.join(workspace.root, "tools", "standalone");
		const testFile = createTestFile(standalone);
		fs.writeFileSync(
			path.join(standalone, "pyproject.toml"),
			"[project]\nname='standalone'\n",
		);
		const expected = createEnvironment(path.join(standalone, ".uv-env"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		const { command, options } = await runPytest(
			testFile,
			path.dirname(testFile),
		);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	// The resolver walks up for a pyproject.toml, so an ancestor project's
	// `.venv` is reachable from any descendant directory. Inheriting it is
	// wrong for every non-uv-workspace layout: a poetry (or plain PEP 621)
	// root does not lend its environment to a sibling subtree that is not a
	// Python project at all. Guard for: ancestor-`.venv` inheritance outside
	// an explicit uv workspace (review round 2, F3).
	it("does not inherit an ancestor project's .venv from a subdirectory", async () => {
		const { root } = createProject(false);
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[tool.poetry]\nname='mono'\n",
		);
		createEnvironment(path.join(root, ".venv"));
		const frontend = path.join(root, "frontend");
		const testFile = createTestFile(frontend);

		const { command, options } = await runPytest(testFile, frontend);

		expect(command).toBe("python");
		expect(options.env).toBeUndefined();
	});

	// `walkUpDirs` is unbounded, so without the HOME ceiling a pyproject.toml
	// sitting in `/tmp` (or any ancestor above the user's home) supplies the
	// environment for every project below it. `isAtOrAboveHomeDir` is the
	// shared ceiling primitive (#625), and `homeDir` is injected the way every
	// sibling walker takes it (#2536/#2544 F2). Guard for: the walk reading a
	// pyproject.toml at or above $HOME (review round 2, F6).
	it("stops the uv project walk at the home directory", async () => {
		const base = createTempDir("pi-lens-uv-home-ceiling-");
		const homeDir = path.join(base, "home");
		const project = path.join(homeDir, "project");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			path.join(base, "pyproject.toml"),
			"[project]\nname='above-home'\n",
		);
		createEnvironment(path.join(base, ".uv-env"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		expect(await detectPythonEnvironment(project, homeDir)).toBeUndefined();
	});

	// uv normalizes a member glob before matching it, so a leading `./` is not
	// part of the pattern (uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
	// `is_included_in_workspace` -> `normalize_path`, and the upstream fixture
	// `exclude_package_with_normalized_glob_and_escaped_root`).
	it("matches a uv member glob written with a leading ./", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['./packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("resolves a relative UV_PROJECT_ENVIRONMENT from the workspace root", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".uv-env"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("uses the uv workspace .venv for a member package", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("keeps an independent nested project on its own .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const nested = path.join(workspace.root, "tools", "standalone");
		const nestedTestFile = createTestFile(nested);
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='standalone'\n",
		);
		const expected = createEnvironment(path.join(nested, ".venv"));

		const { command, options } = await runPytest(nestedTestFile, nested);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("honors uv workspace exclusions over member globs", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\nexclude = ['packages/excluded']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const excluded = path.join(workspace.root, "packages", "excluded");
		const excludedTestFile = createTestFile(excluded);
		fs.writeFileSync(
			path.join(excluded, "pyproject.toml"),
			"[project]\nname='excluded'\n",
		);
		const expected = createEnvironment(path.join(excluded, ".venv"));

		const { command, options } = await runPytest(excludedTestFile, excluded);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("labels pytest usage errors and interruptions by their real exit codes", () => {
		const client = new TestRunnerClient(false) as any;
		// The label is derived from pytest's status enum, so keep output empty and
		// avoid pinning a hand-written tool transcript in this parser contract test.
		const usageError = client.parsePytestOutput(
			"",
			"",
			4,
			"/tmp/test_example.py",
			"/tmp",
			"pytest",
		);
		const interrupted = client.parsePytestOutput(
			"",
			"",
			2,
			"/tmp/test_example.py",
			"/tmp",
			"pytest",
		);

		expect(usageError.error).toBe("Pytest configuration error");
		expect(interrupted.error).toBe("Pytest interrupted");
	});
});
