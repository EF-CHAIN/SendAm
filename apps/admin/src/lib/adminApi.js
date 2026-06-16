import api from '@shared/api';

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
