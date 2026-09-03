# Product and distribution boundary

## Supported distribution today

Hyperfinite is a reviewed source distribution with two supported forms:

| Audience | Supported artifact | Supported entry point |
|---|---|---|
| Maintainer | Authoritative `IraLeeBell/hyperfinite` repository at an exact reviewed head | Clone the repository, install the locked toolchain and dependencies, and invoke documented `npm` scripts |
| Local evaluator | Authoritative repository clone at an exact reviewed head | Run deterministic validation, simulation, planning, and evidence commands without live effects |
| Customer sandbox operator | Verified customer-starter archive or reviewed file-only copy of an exact head | Populate a new private customer-owned Git repository, configure ownership, create the initial commit, repin selection evidence, and follow the evaluation guide |

Repository scripts are supported only in those documented repository contexts.
For a clean extracted customer-starter profile, the fixed profile catalog names
the scripts independently validated as runnable. A full customer evaluation
uses the new customer-owned Git history and the exact-head sequence in the
[customer evaluation guide](../../CUSTOMER_EVALUATION_GUIDE.md).

## Unsupported consumption models

| Consumption model | Status |
|---|---|
| npm registry install | Unsupported. `package.json` is `private`; its package name is retained technical metadata, not a publication claim. |
| TypeScript SDK or deep imports | Unsupported. `src/` and `src/index.ts` are internal repository implementation with no external API compatibility promise. |
| Packaged or general-purpose CLI | Unsupported. The package has no `bin` entry; documented commands are repository `npm` scripts. |
| Hosted service or SaaS | Unsupported. This repository operates no hosted control plane. |
| Deployable production service, image, or chart | Unsupported. The repository provides contracts and local references, not a service distribution. |
| Bundled administration or live effects | Unsupported. Project/App administration is human-owned, and live effects require independently deployed trust services and protected credentials. |
| Published release or production support commitment | Unsupported. Local release and starter artifacts are unsigned, non-authoritative evidence. |

An npm SDK, CLI package, hosted offering, deployable service, or production
distribution requires separate future product work. The absence of one of
these distributions must never be replaced by an ambient credential, inferred
target, local unsigned adapter, or success-shaped fallback.

## Boundary between artifacts

1. **Repository and hermetic evidence** proves deterministic behavior at one
   exact head. It does not prove a deployed service or live control.
2. **Customer-owned sandbox evaluation** begins only after source is placed in a
   new customer repository and customer owners configure and approve the
   documented prerequisites.
3. **Independent trust services** own credentials, protected time, conditional
   stores, signing, token brokerage, Single Writer effects, and authenticated
   readback. They are not shipped by this repository.
4. **Future product distributions** remain unimplemented until separately
   designed, reviewed, versioned, secured, and supported.

The retained `agentic-framework/v1alpha1` package, API, schema, publisher, and
cryptographic identity is unchanged. This distribution boundary adds no target,
credential, capability, transition, administrative action, or effect authority.

## Machine-readable contract

`config/v1alpha1/compatibility.json` records the closed `productBoundary`.
`schemas/v1alpha1/packaging.schema.json`, `src/packaging-types.ts`, and
deterministic packaging validation reject omitted, widened, or contradictory
values. Package validation also requires `private: true`, a metadata-only
`exports` map, no SDK entry metadata, no `bin`, and no publish/deploy script.

See [ADR 0020](../adr/0020-supported-distribution-is-repository-and-customer-starter-source-only.md),
the [compatibility guide](../compatibility.md), and the
[customer-starter preflight](../release/customer-starter-preflight.md).
