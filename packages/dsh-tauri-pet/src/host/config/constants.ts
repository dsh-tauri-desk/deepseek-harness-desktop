/** 推理文本滚动尾部窗口字符数：超出后丢弃最早内容，供气泡「思考 · text」实时滚动展示。 */
export const PET_REASONING_TAIL_WINDOW = 120

/** 推理文本推送间隔（毫秒）：状态实时累积，最多每 500ms 推送一次最新尾部，避免逐 token 洪泛。 */
export const PET_REASONING_PUSH_INTERVAL_MS = 500

/** 装配 effect 标签（禁止硬编码字符串）。 */
export const PET_ROUTES_EFFECT = 'dsh-tauri-pet: routes'
export const PET_HOST_RUNTIME_EFFECT = 'dsh-tauri-pet: host runtime'
