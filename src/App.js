import './style.css'
import { getCurrentUser, onAuthChange, logout } from './lib/auth.js'
import { Login }           from './views/Login.js'
import { Dashboard }       from './views/Dashboard.js'
import { EmployeeView }    from './views/EmployeeView.js'
import { TeamManagement }  from './views/TeamManagement.js'
import { SOPView }         from './views/SOPView.js'
import { DailyCheckout }   from './views/DailyCheckout.js'
import { StudioAdmin }     from './views/StudioAdmin.js'
import { RevenueAnalytics }from './views/RevenueAnalytics.js'
import { Sidebar }         from './components/Sidebar.js'
import { MyProfile }      from './views/MyProfile.js'

const MOBILE_BP = 1024   // px — below this: no sidebar in DOM at all

const app = document.getElementById('app')
let currentUser   = null
let currentView   = null
let viewContainer = null
let appLayout     = null
let lastWasMobile = window.innerWidth < MOBILE_BP

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  renderLoading()
  try {
    currentUser = await getCurrentUser()
  } catch (_) {
    renderLogin()
    return
  }
  if (!currentUser) { renderLogin(); return }
  renderApp('checkout')
}

function isMobile() { return window.innerWidth < MOBILE_BP }

function isManager() {
  return currentUser?.profile?.is_manager || currentUser?.profile?.role === 'manager'
}

// ── Resize: re-render only when crossing the breakpoint ───────────────────────

window.addEventListener('resize', () => {
  const mobile = isMobile()
  if (mobile !== lastWasMobile) {
    lastWasMobile = mobile
    if (currentUser) renderApp(currentView ?? 'checkout')
  }
})

// ── Loading / Login screens ───────────────────────────────────────────────────

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
      if (!currentUser) throw new Error('Profil nicht gefunden. Bitte Administrator kontaktieren.')
      renderApp('checkout')
    },
  }).render())
}

// ── Core layout ────────────────────────────────────────────────────────────────
//
//  Desktop (>= 1024px):   [Sidebar | content-wrap]
//  Mobile  (<  1024px):   [content-wrap]  +  bottom-nav inside content-wrap
//
//  The sidebar is NEVER added to the DOM on mobile — no CSS tricks needed.

function renderApp(viewId) {
  currentView = viewId
  app.innerHTML = ''

  appLayout = document.createElement('div')
  appLayout.className = 'app-layout'

  if (!isMobile()) {
    // ── Desktop: sidebar lives in the DOM ──────────────────────────────────
    appLayout.appendChild(buildSidebar())
  }

  // ── Content wrapper ────────────────────────────────────────────────────────
  const contentWrap = document.createElement('div')
  contentWrap.className = 'main-content-wrap'
  // Takes all remaining width on desktop; is the only child on mobile.
  contentWrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden'

  if (isMobile()) {
    // ── Mobile: header with hamburger menu ────────────────────────────────
    const hdr = document.createElement('header')
    hdr.className = 'mobile-header'
    hdr.innerHTML = `
      <img src="/images/studio358-logo.png" class="mobile-header-logo" alt="" style="filter:brightness(0) invert(1)">
      <span class="mobile-header-title">${viewName(viewId)}</span>
      <button class="mobile-hamburger" aria-label="Menü öffnen">[ Menü ]</button>
    `
    hdr.querySelector('.mobile-hamburger').addEventListener('click', openMobileMenu)
    contentWrap.appendChild(hdr)
  }

  // ── Scrollable view area ───────────────────────────────────────────────────
  viewContainer = document.createElement('div')
  viewContainer.id = 'view-container'
  viewContainer.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch'
  contentWrap.appendChild(viewContainer)

  // Bottom-nav removed: navigation is now via hamburger overlay on mobile

  appLayout.appendChild(contentWrap)
  app.appendChild(appLayout)
  loadView(viewId)
}

// ── Bottom navigation (mobile only) ───────────────────────────────────────────

function createBottomNav() {
  const nav = document.createElement('nav')
  nav.className = 'bottom-nav'
  nav.id = 'bottom-nav'
  renderBottomNavItems(nav)
  return nav
}

function renderBottomNavItems(nav) {
  const mgr  = isManager()
  const tabs = mgr
    ? [
        { view: 'dashboard', label: 'Home',      svg: iconHome      },
        { view: 'checkout',  label: 'Abschluss', svg: iconCheckout  },
        { view: 'sops',      label: 'SOPs',      svg: iconSops      },
        { view: 'admin',     label: 'Profil',    svg: iconAdmin     },
      ]
    : [
        { view: 'checkout',       label: 'Home',      svg: iconHome     },
        { view: 'checkout',       label: 'Abschluss', svg: iconCheckout },
        { view: 'sops',           label: 'SOPs',      svg: iconSops     },
        { view: 'my-performance', label: 'Profil',    svg: iconProfile  },
      ]

  nav.innerHTML = tabs.map(t => `
    <button class="bottom-nav-item${currentView === t.view ? ' active' : ''}" data-view="${t.view}">
      ${t.svg}
      <span class="bottom-nav-label">${t.label}</span>
    </button>
  `).join('')

  nav.querySelectorAll('.bottom-nav-item[data-view]').forEach(btn =>
    btn.addEventListener('click', () => navigateTo(btn.dataset.view))
  )
}

// SVG icons (24×24, stroke-based, neutral on inactive, cream on active)
const iconHome      = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>`
const iconCheckout  = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h7M17.5 14v7"/></svg>`
const iconAnalytics = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>`
const iconSops      = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
const iconAdmin     = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
const iconProfile   = `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`

// ── Sidebar (desktop only) ─────────────────────────────────────────────────────

function buildSidebar() {
  return Sidebar({ user: currentUser, currentView, onNavigate: navigateTo, onLogout: handleLogout }).render()
}

function updateSidebar() {
  if (isMobile()) return   // sidebar is not in the DOM on mobile
  const old = appLayout?.querySelector('.sidebar')
  if (old) old.replaceWith(buildSidebar())
}

function openMobileMenu() {
  if (document.getElementById('mobile-menu-overlay')) return   // prevent double-open

  const overlay = document.createElement('div')
  overlay.id = 'mobile-menu-overlay'
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100dvh;z-index:7000;display:flex;align-items:stretch'

  const backdrop = document.createElement('div')
  backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.52)'

  const panel = document.createElement('div')
  panel.style.cssText = [
    'position:relative;z-index:1',
    'width:280px;max-width:82vw;height:100%',
    'display:flex;flex-direction:column;overflow-y:auto',
    'box-shadow:4px 0 32px rgba(0,0,0,0.38)',
    'transform:translateX(-100%)',
    'transition:transform 0.26s cubic-bezier(0.4,0,0.2,1)',
  ].join(';')

  function close() {
    panel.style.transform = 'translateX(-100%)'
    setTimeout(() => overlay.remove(), 270)
  }

  function navAndClose(viewId) { close(); setTimeout(() => navigateTo(viewId), 140) }
  function logoutAndClose()    { close(); setTimeout(handleLogout, 140) }

  const sidebarEl = Sidebar({
    user:       currentUser,
    currentView,
    onNavigate: navAndClose,
    onLogout:   logoutAndClose,
  }).render()

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕'
  closeBtn.style.cssText = [
    'position:absolute;top:14px;right:14px;z-index:2',
    'background:none;border:none',
    'color:rgba(245,237,228,0.7);font-size:1.25rem',
    'cursor:pointer;padding:6px;line-height:1;border-radius:4px',
  ].join(';')
  closeBtn.addEventListener('click', close)

  panel.appendChild(sidebarEl)
  panel.appendChild(closeBtn)
  overlay.appendChild(backdrop)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  requestAnimationFrame(() => { panel.style.transform = 'translateX(0)' })

  backdrop.addEventListener('click', close)
}

// ── View loader ────────────────────────────────────────────────────────────────

async function loadView(viewId) {
  if (!viewContainer) return
  viewContainer.innerHTML = '<div class="main-content"><div class="loader"><div class="spinner"></div></div></div>'

  try {
    let el
    if (viewId === 'checkout') {
      el = await DailyCheckout({ user: currentUser, onNavigate: navigateTo }).render()
    } else if (viewId === 'analytics' && isManager()) {
      el = await RevenueAnalytics({ user: currentUser }).render()
    } else if (viewId === 'dashboard' && isManager()) {
      el = await Dashboard({ user: currentUser }).render()
    } else if (viewId === 'team' && isManager()) {
      el = await TeamManagement({ user: currentUser }).render()
    } else if (viewId === 'my-performance') {
      el = await EmployeeView({ user: currentUser, onNavigate: navigateTo }).render()
    } else if (viewId === 'sops') {
      el = await SOPView({ user: currentUser }).render()
    } else if (viewId === 'admin' && isManager()) {
      el = await StudioAdmin({ user: currentUser }).render()
    } else if (viewId === 'profile') {
      el = MyProfile({ user: currentUser }).render()
    } else {
      el = await DailyCheckout({ user: currentUser, onNavigate: navigateTo }).render()
    }

    if (el) { viewContainer.innerHTML = ''; viewContainer.appendChild(el) }
  } catch (err) {
    console.error('[loadView] error:', err)
    viewContainer.innerHTML = `
      <div class="main-content">
        <div class="card" style="margin-top:32px;border-left:3px solid var(--terracotta)">
          <p style="color:var(--terracotta);font-weight:600">Fehler beim Laden</p>
          <p style="color:var(--text-mid);font-size:0.875rem">${err.message}</p>
          <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="location.reload()">Seite neu laden</button>
        </div>
      </div>
    `
  }
}

// ── View name map (used in mobile header) ─────────────────────────────────────

const VIEW_NAMES = {
  checkout:          'Tagesabschluss',
  analytics:         'Umsatz-Analytics',
  dashboard:         'Performance Tracker',
  team:              'Team',
  sops:              'Wissensdatenbank',
  'my-performance':  'Meine Performance',
  admin:             'Studio-Admin',
  profile:           'Mein Profil',
}
function viewName(id) { return VIEW_NAMES[id] ?? 'Studio 358' }

// ── Navigation ─────────────────────────────────────────────────────────────────

function navigateTo(viewId) {
  currentView = viewId
  updateSidebar()
  const hdrTitle = appLayout?.querySelector('.mobile-header-title')
  if (hdrTitle) hdrTitle.textContent = viewName(viewId)
  loadView(viewId)
}

// ── Auth ───────────────────────────────────────────────────────────────────────

async function handleLogout() {
  try { await logout() } catch (_) {}
  currentUser = null
  renderLogin()
}

onAuthChange(session => {
  if (!session && currentUser) { currentUser = null; renderLogin() }
})

init()
