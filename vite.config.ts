import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
      },
    }),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      '@': '/src',
    },
  },

  build: {
    rollupOptions: {
      // 多页入口：`pet.html` 是桌宠独立窗口（`WebviewUrl::App("pet.html")`）的入口，
      // 与 `index.html` 一起被打进产物，保证 Tauri 能按 URL 加载到独立窗口页面。
      input: {
        main: 'index.html',
        pet: 'pet.html',
      },
    },
  },

  // Vite options tailored for Tauri development.
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}))
