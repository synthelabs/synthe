// The names that the usual runners treat as tests, wherever they are (swarm/GOAL-3.md, stages 4b and 4c). Patterns
// alone cannot stop a new counted test, so the measure also names the test files that exist at init (testFiles).
export const TEST_FILE_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test_*.py", "**/*_test.py",
  "**/*-test.*", "**/*_test.*", "**/test-*.*", "**/test.*", "**/test/**"];

// Stage 4e: pytest takes its configuration from the common folder of its arguments, so a new pkg/pytest.ini could
// load a plugin. The measure names the root configuration with -c and the root with --rootdir, and protect holds
// these names at any depth. When the repository has no pytest configuration, init writes an empty one to name.
export const PYTEST_CONFIG_GLOBS = ["**/pytest.ini", "**/.pytest.ini", "**/pyproject.toml", "**/tox.ini", "**/setup.cfg"];
// Stage 4f: files that Python runs when it starts, before pytest can pin anything.
export const PYTHON_STARTUP_GLOBS = ["**/sitecustomize.py", "**/usercustomize.py", "**/*.pth"];

// The configuration names that the three runners read, at any depth. A configuration file that a proposal adds is
// never read by the measure, and protect refuses it too.
export const JS_CONFIG_GLOBS = ["**/jest.config.*", "**/vitest.config.*", "**/vite.config.*", "**/vitest.workspace.*", "**/.mocharc*"];

export const CONFTEST_GLOB = "**/conftest.py";
export const RUNNER_LOADED_GLOBS = [...TEST_FILE_GLOBS, "**/tests/**", CONFTEST_GLOB,
  ...PYTEST_CONFIG_GLOBS, ...PYTHON_STARTUP_GLOBS, ...JS_CONFIG_GLOBS];
