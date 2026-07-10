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
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export const adminLogin = async (password) => {
  const { data } = await api.post('/admin/login', { password });
  const token = data?.data?.token;
  if (token) {
    setToken(token);
  }
  return token;
};

export const getAdminStats = async () => {
  const { data } = await api.get('/admin/stats');
  return data;
};

export const getAdminUsers = async () => {
  const { data } = await api.get('/admin/users');
  return data;
};

export const getAdminWallets = async () => {
  const { data } = await api.get('/admin/wallets');
  return data;
};

export const getAdminTransactions = async () => {
  const { data } = await api.get('/admin/transactions');
  return data;
};

export const getAdminEscrows = async () => {
  const { data } = await api.get('/admin/escrows');
  return data;
};

export const getAdminKyc = async () => {
  const { data } = await api.get('/admin/kyc');
  return data;
};

export const getAdminAuditLogs = async () => {
  const { data } = await api.get('/admin/audit-logs');
  return data;
};

export const getAdminSystemHealth = async () => {
  const { data } = await api.get('/admin/system-health');
  return data;
};
