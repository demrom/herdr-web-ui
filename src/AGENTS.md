# src/

- The auth token lives only in the HttpOnly cookie, never in localStorage or sessionStorage.
- A new setting needs its default and type check in `sanitizeSettings`, or it is silently dropped.
- Secret input stays in the DOM input only: never React state, a draft, a queue or a retry.
- Import only types from `shared/protocol.ts`: importing a value reads the server's environment.
