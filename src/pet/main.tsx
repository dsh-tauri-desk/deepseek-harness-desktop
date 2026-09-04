import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import './main.css'

const root = document.getElementById('root') as HTMLElement
root.className = 'h-full w-full'

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
