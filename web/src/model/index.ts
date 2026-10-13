// Public API of the RRAM model core (UI-independent).
export * from "./params";
export * from "./physics";
export * from "./simulate";
export * from "./jobs";
export { integrate, type IntegrateOptions, type IntegrateResult, type Rhs } from "./solver";
// ModelClient (Web Worker wrapper) is imported from "./client" by the UI only.
