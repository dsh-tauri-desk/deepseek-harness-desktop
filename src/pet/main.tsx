import React from 'react'
import ReactDOM from 'react-dom/client'
import { PetWindow } from './PetWindow'
import './pet.css'

/**
 * 桌宠窗口入口。
 *
 * 独立透明 WebView（`label: "pet"`）加载本入口。窗口本身透明、置顶、无边框，
 * 页面只渲染一只根据 `config::pet_state` 状态文件轮询切换动画的宠物。
 */
function main() {
  const root = document.getElementById('root') as HTMLElement
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <PetWindow />
    </React.StrictMode>,
  )
}

main()
