/** 一次路径安全校验的结果。 */
export type PathSafety = { ok: true } | { ok: false, reason: string }
