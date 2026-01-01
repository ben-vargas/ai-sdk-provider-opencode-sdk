# AGENTS.md

## Project Overview

This repository provides an AI SDK v5 compatible provider for **OpenCode**, leveraging the `@opencode-ai/sdk`. It allows developers to use OpenCode models within the Vercel AI SDK ecosystem.

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js (>=18)
- **Bundler**: [tsup](https://tsup.egoist.dev/)
- **Testing**: [Vitest](https://vitest.dev/)
- **Linting**: [ESLint](https://eslint.org/)
- **Formatting**: [Prettier](https://prettier.io/)
- **Key Libraries**: `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@opencode-ai/sdk`, `zod`

## Project Structure

- `src/`: Core logic and implementation
  - `opencode-provider.ts`: Entry point for creating the provider instance
  - `opencode-language-model.ts`: Implementation of the `LanguageModelV3` interface
  - `opencode-client-manager.ts`: Manages the lifecycle of the OpenCode SDK client
  - `convert-*.ts`: Transformation logic between AI SDK and OpenCode formats
  - `validation.ts`: Configuration and input validation
  - `logger.ts`: Internal logging utility
- `examples/`: Code samples demonstrating various features (streaming, tool observation, image input, etc.)
- `dist/`: Compiled output (ESM and CJS)

## Development Commands

- `npm run build`: Compiles the project using tsup
- `npm run dev`: Starts tsup in watch mode
- `npm run clean`: Deletes the `dist` directory
- `npm run test`: Executes all tests once
- `npm run test:watch`: Starts Vitest in watch mode
- `npm run test:coverage`: Generates test coverage report
- `npm run lint`: Runs ESLint on the source directory
- `npm run format`: Formats code with Prettier
- `npm run typecheck`: Performs TypeScript type checking without emitting files

## Code Conventions

### TypeScript

- **Strict Mode**: Enabled with `strict: true` in `tsconfig.json`.
- **Type Safety**: Use `noUncheckedIndexedAccess` and `noImplicitReturns`.
- **Avoid `any`**: Prefer specific types or `unknown`. If `any` is necessary, it will trigger an ESLint warning.

### Naming Conventions

- **Files**: `kebab-case.ts` (e.g., `opencode-provider.ts`)
- **Classes**: `PascalCase` (e.g., `OpencodeLanguageModel`)
- **Interfaces/Types**: `PascalCase` (e.g., `OpencodeSettings`)
- **Functions/Variables**: `camelCase` (e.g., `createOpencode`)
- **Constants**: `PascalCase` or `UPPER_SNAKE_CASE` (e.g., `OpencodeModels`)

### Import Style

- **Extensions**: **MANDATORY** use of `.js` extensions in all relative imports (e.g., `import { ... } from './types.js'`). This is required for ESM compatibility.
- **Organization**: Group imports: built-in modules, external dependencies, internal modules.

## Testing

- **Framework**: Vitest.
- **Location**: Test files reside alongside the source code with the `.test.ts` suffix.
- **Patterns**:
  - Use `describe` for grouping and `it` for individual test cases.
  - Use `vi.mock()` for external dependencies (especially `@opencode-ai/sdk`).
  - Follow the Arrange-Act-Assert pattern.
- **Coverage**: Coverage is tracked via v8. Aim for high coverage of conversion and validation logic.

## Linting & Formatting

- **ESLint**: Uses the flat config (`eslint.config.js`). Ignores `dist`, `node_modules`, and `examples`.
- **Prettier**: standard configuration for code formatting.

## Build Process

- **Tool**: `tsup`.
- **Formats**: Generates both CommonJS (`.cjs`) and ES Modules (`.js`).
- **Target**: Node 18.
- **Output**: Generates declaration files (`.d.ts`) and sourcemaps.

## Git Conventions

- **Commit Messages**: Use Conventional Commits (`type(scope): subject`).
  - `feat`: New features
  - `fix`: Bug fixes
  - `docs`: Documentation changes
  - `test`: Adding or updating tests
  - `refactor`: Code changes that neither fix a bug nor add a feature

## Common Patterns

- **Provider Factory**: `createOpencode()` is the primary way to instantiate the provider.
- **Singleton Client**: `OpencodeClientManager` uses a singleton-like pattern (via `getInstance`) to manage the SDK client across multiple model instances if needed.
- **Unsupported Feature Logging**: Use `logger.ts` utilities (e.g., `logUnsupportedFeature`) to notify users when AI SDK options are not applicable to OpenCode.

## Gotchas & Notes

- **Server-Side Tools**: OpenCode executes tools server-side. Custom tool definitions passed via the AI SDK are currently ignored and will trigger warnings.
- **File Inputs**: Only base64-encoded file inputs are supported. URL-based file inputs are not supported by the OpenCode SDK.
- **Session Persistence**: Use `sessionId` in settings to maintain conversation context across multiple `generateText` or `streamText` calls.
- **Import Extensions**: Forgetting the `.js` extension in imports is the most common cause of build/runtime failures in this project.
