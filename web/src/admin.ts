/**
 * Who sees the developer controls: only `?admin=true`.
 *
 * This is presentation only. What an admin can actually DO is decided by the
 * server, which grants the admin role only to a connection presenting
 * ADMIN_TOKEN (see server.py); without the token the panel renders but every
 * privileged button is disabled. Localhost is no longer admin by default, so a
 * plain local visit shows exactly what the public sees.
 */
export function isAdmin(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('admin') === 'true'
  } catch {
    return false
  }
}
