---
name: test-first-change
description: How to make any code change safely - reproduce or specify with a failing test, make the smallest fix, verify the full suite. Use for bug fixes, features and refactors in an existing codebase.
---

# Test-first change

## 1. Understand before touching anything
- Find the entry points and the tests for the area: `grep`/`glob` for the function, then read its callers.
- Find how tests run: look for `pyproject.toml`, `package.json` scripts, `Makefile`, CI config. Run the existing suite once to get a baseline. Note any tests that already fail so you don't get blamed for them, and don't hide them either.

## 2. Pin the behavior with a test
- **Bug:** write a test that reproduces it and fails for the right reason. Run it and see it fail.
- **Feature:** write tests for the acceptance criteria, including one edge case and one failure path.
- **Refactor:** make sure existing tests cover the behavior you're moving; add characterization tests if they don't.

## 3. Make the smallest change that passes
- Match the surrounding style, naming and error-handling patterns.
- No drive-by rewrites. If you spot other problems, list them in your report instead.

## 4. Verify
- Run the new tests, then the full suite, then the linter/type checker if the project has one.
- Actually run the program or endpoint if the change is user-visible.

## 5. Report
- Files changed, what each change does, test commands run and their results, and anything risky or left undone.
