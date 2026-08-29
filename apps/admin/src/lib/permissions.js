// Client-side mirror of the server-authoritative permission set (see
// apps/api/src/services/adminAuth.service.js ROLE_PERMISSIONS). The UI uses
// this only to hide/reveal actions; every route is independently authorized
// server-side by requireAdmin.
export const hasPermission = (permissions, permission) =>
  Boolean(permissions?.includes('*') || permissions?.includes(permission));
