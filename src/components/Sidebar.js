export function Sidebar({ user, currentView, onNavigate, onLogout }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'
  const initials  = getInitials(user?.profile?.full_name || user?.email || '?')
  const level     = user?.profile?.level || 'employee'
  const location  = user?.profile?.location

  const managerNav = [
    { id: 'dashboard', icon: '◈', label: 'Dashboard'       },
    { id: 'team',      icon: '◉', label: 'Team Management' },
    { id: 'sops',      icon: '◎', label: 'Wissensdatenbank' },
  ]

  const employeeNav = [
    { id: 'my-performance', icon: '◈', label: 'Meine Performance' },
    { id: 'sops',           icon: '◎', label: 'Wissensdatenbank'  },
  ]

  const navItems = isManager ? managerNav : employeeNav

  function render() {
    const el = document.createElement('aside')
    el.className = 'sidebar'

    el.innerHTML = `
      <div class="sidebar-logo">
        <img src="/images/studio358-logo.png" alt="Studio 358" />
        <p>Performance Tracker</p>
      </div>

      <nav class="sidebar-nav">
        <span class="nav-section-label">Navigation</span>
        ${navItems.map(item => `
          <button class="nav-item ${currentView === item.id ? 'active' : ''}" data-view="${item.id}">
            <span class="nav-icon">${item.icon}</span>
            ${item.label}
          </button>
        `).join('')}
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <div class="sidebar-avatar">${initials}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${user?.profile?.full_name || user?.email}</div>
            <div class="sidebar-user-role">
              ${isManager
                ? 'Manager'
                : `${level.charAt(0).toUpperCase() + level.slice(1)}${location ? ' · ' + locationLabel(location) : ''}`
              }
            </div>
          </div>
        </div>
        <button class="nav-item" id="logout-btn">
          <span class="nav-icon">⎋</span>
          Abmelden
        </button>
      </div>
    `

    el.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => onNavigate(btn.dataset.view))
    })

    el.querySelector('#logout-btn').addEventListener('click', onLogout)

    return el
  }

  return { render }
}

function getInitials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0].toUpperCase()).join('')
}

function locationLabel(loc) {
  return { mitte: 'Mitte', kadewe: 'KaDeWe' }[loc] ?? loc
}
