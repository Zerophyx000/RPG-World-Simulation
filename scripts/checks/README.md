# Step 9 checks

Small self-checks for the step-9 features, run by the local check runner. Each script:

- is run as `node scripts/checks/<name>.mjs <repoRoot> <dataDir>` (the data dir is a fresh, empty throwaway folder)
- may use `process.env.TEST_LLM_BASE_URL` (a mock LLM) but needs no LLM to pass
- prints one `PASS`/`FAIL` line per check and finally `N passed, M failed`, and exits non-zero on any failure
- never touches `data/world.db`

These are not a test framework, only scripts; they import modules with `import(\`file:///${root}/<path>\`)`.
