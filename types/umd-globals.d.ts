// Ambient globals used by the UMD wrappers in js/*.js (type-checking only).
declare var module: { exports: unknown } | undefined;
declare var exports: unknown;
declare var define: ((deps: string[], factory: () => unknown) => void) & { amd?: unknown };
