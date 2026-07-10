// Admin session token storage. The token is an HMAC-signed session token from
// POST /api/admin/login (see adminApi.js); it's kept in localStorage for the
// MVP — revisit (e.g. httpOnly cookie) if XSS exposure becomes a concern.
export const setToken = (token) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem('adminToken', token);
  }
};

export const getToken = () => {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('adminToken');
  }
  return null;
};

export const removeToken = () => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('adminToken');
  }
};

export const isAuthenticated = () => {
  return !!getToken();
};
