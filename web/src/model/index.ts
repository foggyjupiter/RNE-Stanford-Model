// RRAM 모델 코어의 공개 API (UI와 무관).
export * from "./params";
export * from "./physics";
export * from "./simulate";
export * from "./jobs";
export { integrate, type IntegrateOptions, type IntegrateResult, type Rhs } from "./solver";
// ModelClient(Web Worker 래퍼)는 UI에서만 "./client"로 직접 가져온다.
