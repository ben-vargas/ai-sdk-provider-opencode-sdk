# ai-sdk-provider-opencode-sdk

AI SDK v6 provider for OpenCode via `@opencode-ai/sdk`. Implements `LanguageModelV3` interface.

## Commands

### File-scoped (preferred)

```bash
# Type check single file
npx tsc --noEmit src/opencode-provider.ts

# Lint single file
npx eslint src/opencode-provider.ts

# Test single file
npx vitest run src/opencode-provider.test.ts

# Format single file
npx prettier --write src/opencode-provider.ts
```

### Project-wide

```bash
npm run build          # Build with tsup (CJS + ESM)
npm test               # Run all tests once
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage
npm run lint           # Lint src/
npm run format         # Format all files
npm run typecheck      # Type check without emit
npm run ci             # typecheck + lint + test
```

## Tech Stack

- **TypeScript** 5.6.3 with strict mode
- **Node.js** >=18
- **@ai-sdk/provider** ^3.0.0 (LanguageModelV3)
- **@ai-sdk/provider-utils** ^4.0.0
- **@opencode-ai/sdk** ^1.0.137
- **Vitest** 3.2.4
- **tsup** 8.5.0 (bundler)
- **ESLint** 9.28.0 (flat config)

## Project Structure

```
src/
├── index.ts                      # Public exports
├── opencode-provider.ts          # createOpencode() factory
├── opencode-language-model.ts    # LanguageModelV3 implementation
├── opencode-client-manager.ts    # SDK client lifecycle
├── convert-to-opencode-messages.ts   # AI SDK → OpenCode
├── convert-from-opencode-events.ts   # OpenCode → AI SDK streams
├── map-opencode-finish-reason.ts     # Finish reason mapping
├── types.ts                      # Shared types
├── validation.ts                 # Input validation
├── errors.ts                     # Error utilities
├── logger.ts                     # Logging utilities
└── *.test.ts                     # Co-located tests
examples/                         # Usage examples
dist/                             # Build output (CJS + ESM)
```

## Code Style

### Imports - CRITICAL

**Always use `.js` extension** in relative imports (ESM requirement):

```typescript
// ✅ Correct
import { Logger } from "./types.js";
import { createOpencode } from "./opencode-provider.js";

// ❌ Wrong - will fail at runtime
import { Logger } from "./types";
```

### Naming

| Type                | Convention | Example                 |
| ------------------- | ---------- | ----------------------- |
| Files               | kebab-case | `opencode-provider.ts`  |
| Classes             | PascalCase | `OpencodeLanguageModel` |
| Interfaces/Types    | PascalCase | `OpencodeSettings`      |
| Functions/Variables | camelCase  | `createOpencode`        |
| Constants           | PascalCase | `OpencodeModels`        |

### TypeScript

```typescript
// Prefix unused params with underscore
function handle(_unused: string, value: number) { ... }

// Use unknown over any
function parse(data: unknown): Result { ... }

// Non-null assertion for array access (noUncheckedIndexedAccess)
const first = items[0]!;  // or check explicitly
```

### Good Examples

- **Provider factory**: `src/opencode-provider.ts`
- **LanguageModelV3 impl**: `src/opencode-language-model.ts`
- **Stream conversion**: `src/convert-from-opencode-events.ts`
- **Test mocking**: `src/opencode-provider.test.ts` (lines 6-33)

## Testing

Co-located tests with `.test.ts` suffix. Uses Vitest.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpencode } from "./opencode-provider.js";

// Mock external SDK
vi.mock("./opencode-client-manager.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./opencode-client-manager.js")>();
  return {
    ...original,
    createClientManagerFromSettings: vi.fn().mockReturnValue({
      getClient: vi.fn().mockResolvedValue({}),
      dispose: vi.fn(),
    }),
  };
});

describe("opencode-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create provider", () => {
    const provider = createOpencode();
    expect(provider).toBeDefined();
  });
});
```

## Git Workflow

### Commit format

```
feat(provider): add session persistence
fix(stream): handle empty delta events
docs: update AGENTS.md
test(validation): add edge cases
refactor(errors): simplify error wrapping
```

### PR checklist

- [ ] `npm run ci` passes (typecheck + lint + test)
- [ ] Tests added for new functionality
- [ ] No `any` types (ESLint warns)
- [ ] `.js` extensions in all imports

## Boundaries

### Always do

- Use `.js` extensions in relative imports
- Run `npm run ci` before committing
- Mock `@opencode-ai/sdk` in tests (never call real API)
- Use `unknown` instead of `any`
- Prefix unused parameters with `_`

### Ask first

- Add new dependencies
- Change public API exports in `index.ts`
- Modify tsconfig.json compiler options
- Update @ai-sdk/provider version

### Never do

- Commit without `.js` extensions (breaks ESM)
- Use `any` to bypass type errors
- Remove or skip failing tests
- Call real OpenCode API in tests
- Commit secrets or API keys

## Gotchas

1. **Import extensions**: Forgetting `.js` is the #1 build failure cause
2. **Server-side tools**: OpenCode executes tools server-side; custom tool definitions are ignored
3. **File inputs**: Only base64 data URLs work; HTTP URLs are not supported
4. **Session persistence**: Use `sessionId` setting to maintain conversation context
5. **noUncheckedIndexedAccess**: Array access returns `T | undefined`; use `!` or check explicitly
