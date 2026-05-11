import './style.css'
import { getCurrentUser, onAuthChange, logout } from './lib/auth.js'
import { Login }          from './views/Login.js'
import { Dashboard }      from './views/Dashboard.js'
import { EmployeeView }   from './views/EmployeeView.js'
import { TeamManagement } from './views/TeamManagement.js'
import { SOPView }        from './views/SOPView.js'
import { Sidebar }        from './components/Sidebar.js'

const app = document.getElementById('app')
let currentUser = null
let currentView = null
let viewContainer = null
let appLayout   = null

async function init() {
  renderLoading()
  currentUser = await getCurrentUser()

  if (!currentUser) { renderLogin(); return }

  const defaultView = isManager() ? 'dashboard' : 'my-performance'
  renderApp(defaultView)
}

function isManager() {
  return currentUser?.profile?.is_manager || currentUser?.profile?.role === 'manager'
}

function renderLoading() {
  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--aubergine)">
      <div style="text-align:center">
        <div class="spinner" style="border-top-color:var(--cream);margin:0 auto 16px"></div>
        <p style="color:rgba(245,237,228,0.6);font-size:0.875rem;letter-spacing:0.08em;text-transform:uppercase">Studio 358</p>
      </div>
    </div>
  `
}

function renderLogin() {
  app.innerHTML = ''
  app.appendChild(Login({
    onSuccess: async () => {
      currentUser = await getCurrentUser()
      if (currentUser) renderApp(isManager() ? 'dashboard' : 'my-performance')
    },
  }).render())
}

function renderApp(viewId) {
  currentView = viewId
  app.innerHTML = ''

  appLayout = document.createElement('div')
  appLayout.className = 'app-layout'

  appLayout.appendChild(buildSidebar())

  viewContainer = document.createElement('div')
  viewContainer.id = 'view-container'
  viewContainer.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column'
  appLayout.appendChild(viewContainer)

  app.appendChild(appLayout)
  loadView(viewId)
}

function buildSidebar() {
  return Sidebar({
    user: currentUser,
    currentView,
    onNavigate: navigateTo,
    onLogout:   handleLogout,
  }).render()
}

async function loadView(viewId) {
  if (!viewContainer) return
  viewContainer.innerHTML = '<div class="main-content"><div class="loader"><div class="spinner"></div></div></div>'

  let el

  if (viewId === 'dashboard') {
    el = await Dashboard({ user: currentUser }).render()
  } else if (viewId === 'team') {
    el = await TeamManagement({ user: currentUser }).render()
  } else if (viewId === 'my-performance') {
    el = await EmployeeView({ user: currentUser, onNavigate: navigateTo }).render()
  } else if (viewId === 'sops') {
    el = await SOPView({ user: currentUser }).render()
  }

  if (el) {
    viewContainer.innerHTML = ''
    viewContainer.appendChild(el)
  }
}

function navigateTo(viewId) {
  currentView = viewId
  updateSidebar()
  loadView(viewId)
}

function updateSidebar() {
  const old = appLayout?.querySelector('.sidebar')
  if (old) old.replaceWith(buildSidebar())
}

async function handleLogout() {
  try { await logout() } catch (_) {}
  currentUser = null
  renderLogin()
}

onAuthChange(session => {
  if (!session && currentUser) { currentUser = null; renderLogin() }
})

init()
