// ESLint 扁平配置：基于 @antfu/eslint-config 预设
// 项目为 React + TypeScript + Vite 应用，显式开启 React 支持
// （React 插件依赖 @eslint-react/eslint-plugin 与 eslint-plugin-react-refresh）
import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  ignores: [
    'AGENTS.md',
    'docs',
    'src-tauri/resources/internal-plugins/**',
  ],
})
