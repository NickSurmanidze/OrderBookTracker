# Orderbook Feed Monorepo

This is a Turborepo monorepo containing a Vue.js frontend and a NestJS backend application.

## Applications

- **vue-app**: Vue.js application running on port 3000
- **nestjs-app**: NestJS backend application running on port 4000

## Getting Started

### Prerequisites

- Node.js (>=18)
- pnpm

### Installation

```bash
pnpm install
```

### Development

To run all applications in development mode:

```bash
pnpm dev
```

To run applications individually:

```bash
# Run only Vue.js app (port 3000)
pnpm dev:vue

# Run only NestJS app (port 4000)
pnpm dev:nestjs
```

You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

````
# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo build --filter=docs

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo build --filter=docs
yarn exec turbo build --filter=docs
pnpm exec turbo build --filter=docs
### Building

```bash
pnpm build
````

### Other Commands

```bash
# Lint all packages
pnpm lint

# Type checking
pnpm check-types

# Format code
pnpm format
```

## Project Structure

```
├── apps/
│   ├── vue-app/        # Vue.js frontend (port 3000)
│   └── nestjs-app/     # NestJS backend (port 4000)
├── packages/
│   ├── eslint-config/  # Shared ESLint configuration
│   ├── typescript-config/ # Shared TypeScript configuration
│   └── ui/             # Shared UI components
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Remote Caching

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

To enable Remote Caching:

```bash
pnpm dlx turbo login
pnpm dlx turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
