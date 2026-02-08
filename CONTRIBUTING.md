# Contributing to TypeGraph

Thank you for your interest in contributing to TypeGraph! We welcome contributions from the
community to help make this the best embedded knowledge graph for TypeScript.

## Getting Started

### Prerequisites

- **Node.js**: Version 22 or higher.
- **pnpm**: We use pnpm for package management.

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/nicia-ai/typegraph.git
   cd typegraph
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

## Development Workflow

### Project Structure

This is a monorepo managed by [Turbo](https://turbo.build/).

- `packages/typegraph`: The core library.
- `packages/benchmarks`: Benchmark runner (private).
- `apps/docs`: Documentation (Astro/Starlight).
- `packages/typegraph/examples`: Runnable usage examples.

### Running Tests

We use [Vitest](https://vitest.dev/) for testing.

- **Run all unit tests:**

  ```bash
  pnpm test
  ```

- **Run property-based tests:**

  ```bash
  pnpm test:property
  ```

- **Run PostgreSQL integration tests:**
  (Requires Docker)

  ```bash
  pnpm test:postgres
  ```

### Building

To build the package for distribution:

```bash
pnpm build
```

## Making Changes

1. **Branch:** Create a new branch for your feature or fix.
2. **Code:** Implement your changes. Please adhere to the existing coding style (Prettier/ESLint will help).
3. **Test:** Add unit tests for new features or bug fixes. Ensure all tests pass.
4. **Lint:** Run `pnpm lint` to check for style issues.
5. **Commit:** We use [Changesets](https://github.com/changesets/changesets) for versioning.
   - If your change affects the published package, run `pnpm changeset` and follow the prompts
     to add a changeset file describing your modification.

## Pull Requests

1. Push your branch to GitHub.
2. Open a Pull Request against the `main` branch.
3. Describe your changes and link to any relevant issues.

By participating in this project, you agree to abide by the Code of Conduct
(`CODE_OF_CONDUCT.md`).

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
