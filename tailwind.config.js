/** @type {import("tailwindcss").Config} */
export default {
  content: ['./index.html', './pet.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 主题色通过 CSS 变量定义（见 src/style/main.css），
        // 由 <html data-theme="light"> 在浅色/深色之间切换
        'canvas': 'var(--color-canvas)',
        'panel': 'var(--color-panel)',
        'panel2': 'var(--color-panel-2)',
        'panel-hover': 'var(--color-panel-hover)',
        'line': 'var(--color-line)',
        'line-strong': 'var(--color-line-strong)',
        'ink': 'var(--color-ink)',
        'muted': 'var(--color-muted)',
        'accent': 'var(--color-accent)',
        'accent2': 'var(--color-accent-2)',
        'danger': 'var(--color-danger)',
        'ok': 'var(--color-ok)',
        'log-bg': 'var(--color-log-bg)',
        'log-ink': 'var(--color-log-ink)',
        // 加载页 token：与主色不同，必须在此注册才会生成对应工具类
        // （漏掉会整条回退 currentColor，spinner 变成同色整圈、看不出旋转）
        'load-bg': 'var(--color-load-bg)',
        'load-ink': 'var(--color-load-ink)',
        'load-muted': 'var(--color-load-muted)',
        'load-ring': 'var(--color-load-ring)',
        // 按钮 token：官方 dsw alias 中性色（非蓝色），同样需注册才能生成工具类
        'btn-fill': 'var(--color-btn-fill)',
        'btn-fill-hover': 'var(--color-btn-fill-hover)',
        'btn-ink': 'var(--color-btn-ink)',
        'btn-border': 'var(--color-btn-border)',
        'btn-hover': 'var(--color-btn-hover)',
        'btn-active': 'var(--color-btn-active)',
        'btn-danger-hover': 'var(--color-btn-danger-hover)',
      },
      fontFamily: {
        // 与官方 --dsw-font-family 保持一致
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        // 与官方 --ds-font-family-code 保持一致（刻意省略裸 monospace，
        // 避免 Windows 中文字体回退到 SimSun）
        mono: [
          '"SF Mono"',
          '"JetBrains Mono"',
          '"Fira Code"',
          'Consolas',
          '"Liberation Mono"',
          'Menlo',
          'Courier',
          '"PingFang SC"',
          '"Microsoft YaHei"',
        ],
      },
    },
  },
  darkMode: 'class',
}
