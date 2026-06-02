import { supabase } from './supabase.js'

function parseUserAgent(ua) {
  const os =
    /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua)   ? 'Android'
    : /Windows/.test(ua)   ? 'Windows'
    : /Mac OS/.test(ua)    ? 'macOS'
    : /Linux/.test(ua)     ? 'Linux'
    : 'Unbekannt'
  const browser =
    /Edg\//.test(ua)         ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua)    ? 'Chrome'
    : /Firefox\//.test(ua)   ? 'Firefox'
    : /Safari\//.test(ua)    ? 'Safari'
    : 'Unbekannt'
  return `${os} / ${browser}`
}

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error

  const { error: logError } = await supabase.from('login_history').insert({
    user_id:      data.user?.id,
    email,
    logged_at:    new Date().toISOString(),
    device_info:  parseUserAgent(navigator.userAgent),
  })
  if (logError) {
    console.error('Kritischer Fehler beim Schreiben des Login-Protokolls:', logError)
  } else {
    console.log('Login-Protokoll erfolgreich in Supabase gespeichert!')
  }

  return data
}

export async function logout() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error) {
    console.error('Profil konnte nicht geladen werden:', error.message)
    return null
  }

  if (profile.is_active === false) {
    await supabase.auth.signOut()
    throw new Error('Dieser Account wurde deaktiviert. Bitte wende dich an den Admin.')
  }

  return { ...user, profile }
}

export async function isManager(user) {
  return user?.profile?.role === 'manager'
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session)
  })
}
