import api from '@shared/api';
import { getToken, setToken, removeToken } from './auth';

// Attach the admin token to every request and centralise session expiry: any
// 401 from the API clears the token and bounces the user back to /login.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      removeToken();
      if (window.location.pathname !== '/login') {
        try {
          window.location.assign('/login');
        } catch {
          // Ignore JSDOM Not implemented errors
        }
      }
    }
    return Promise.reject(error);
  }
);

export const adminLogin = async (email, password) => {
  const { data } = await api.post('/admin/login', { email, password });
  const token = data?.data?.token;
  if (token) {
    setToken(token);
  }
  return data?.data || { token: null, mustChangePassword: false };
};

// The authenticated operator's identity + effective permissions, used by the
// UI to enforce role-based access and to detect a pending password change.
export const getAdminMe = async () => {
  const { data } = await api.get('/admin/me');
  return data?.data || null;
};

// Self-serve password rotation. Required first step after a bootstrap/temporary
// credential; also revokes all other active sessions for the operator.
export const changeAdminPassword = async ({ currentPassword, newPassword }) => {
  const { data } = await api.post('/admin/password', { currentPassword, newPassword });
  return data;
};

export const getAdminStats = async () => {
  const { data } = await api.get('/admin/stats');
  return data;
};

// Every admin list accepts the same cursor + filter `params` shape:
//   { limit, after, before, ...filters }  ->  { data, pagination, success }
// `after`/`before` are opaque cursors returned by the API; filter keys are
// forwarded as query params and resolved server-side.
export const getAdminUsers = async (params = {}) => {
  const { data } = await api.get('/admin/users', { params });
  return data;
};

export const getAdminWallets = async (params = {}) => {
  const { data } = await api.get('/admin/wallets', { params });
  return data;
};

export const getAdminTransactions = async (params = {}) => {
  const { data } = await api.get('/admin/transactions', { params });
  return data;
};

export const getAdminKyc = async (params = {}) => {
  const { data } = await api.get('/admin/kyc', { params });
  return data;
};

export const getAdminAuditLogs = async (params = {}) => {
  const { data } = await api.get('/admin/audit-logs', { params });
  return data;
};

// Sensitive exports are authorized server-side and recorded to the audit log.
// We stream the CSV response to a browser download.
const triggerDownload = (blob, filename) => {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
};

export const exportAdminKyc = async (params = {}) => {
  const { after, before, limit, ...filters } = params;
  const response = await api.get('/admin/kyc/export', { params: filters, responseType: 'blob' });
  triggerDownload(response.data, 'kyc-export.csv');
  return response.data;
};

export const exportAdminAuditLogs = async (params = {}) => {
  const { after, before, limit, ...filters } = params;
  const response = await api.get('/admin/audit-logs/export', { params: filters, responseType: 'blob' });
  triggerDownload(response.data, 'audit-logs-export.csv');
  return response.data;
};

export const getAdminSystemHealth = async () => {
  const { data } = await api.get('/admin/system-health');
  return data;
};

export const approveKyc = async (id) => {
  const { data } = await api.post(`/compliance/kyc/${id}/review`, { status: 'approved' });
  return data;
};

export const rejectKyc = async (id) => {
  const { data } = await api.post(`/compliance/kyc/${id}/review`, { status: 'rejected' });
  return data;
};
