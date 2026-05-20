export function Sidebar({ user, currentView, onNavigate, onLogout }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'
  const initials  = getInitials(user?.profile?.full_name || user?.email || '?')
  const level     = user?.profile?.level || 'employee'
  const location  = user?.profile?.location

  const managerNav = [
    { id: 'checkout',  label: 'Tagesabschluss'    },
    { id: 'analytics', label: 'Umsatz Cockpit'     },
    { id: 'dashboard', label: 'Performance Tracker' },
    { id: 'team',      label: 'Team Management'    },
    { id: 'sops',      label: 'Studio Guide'       },
    { id: 'admin',     label: 'Studio Admin'        },
  ]

  const employeeNav = [
    { id: 'checkout',       label: 'Tagesabschluss'    },
    { id: 'my-performance', label: 'Performance Tracker' },
    { id: 'sops',           label: 'Studio Guide'       },
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
