import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

const container = document.getElementById('root')
if (container === null) throw new Error('cockpit: #root is missing from index.html')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
