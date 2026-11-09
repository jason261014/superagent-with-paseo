/** Browser entry for the standalone read-only flow canvas; keeps its token in sessionStorage after the hash is read. */
import { createRoot } from 'react-dom/client'
import { FlowCanvasApp, fetchItem, fetchOverview } from './App.tsx'

const params = new URLSearchParams(location.hash.slice(1))
const token = params.get('token')
if (token) { sessionStorage.setItem('flow-token', token); history.replaceState(null, '', location.pathname) }
const container = document.getElementById('root')
if (container) createRoot(container).render(<FlowCanvasApp loadOverview={fetchOverview} loadItem={fetchItem} />)
