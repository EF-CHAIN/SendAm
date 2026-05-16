import api from './api';

export const createWallet = async (payload) => {
  const { data } = await api.post('/wallet/create', payload);
  return data;
};

export const getBalance = async (phone) => {
  const { data } = await api.get(`/wallet/${phone}/balance`);
  return data;
};

export const sendXlm = async (payload) => {
  const { data } = await api.post('/wallet/send', payload);
  return data;
};
