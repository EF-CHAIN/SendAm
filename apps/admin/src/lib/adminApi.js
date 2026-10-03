import api from '@shared/api';
import { getToken, setToken, removeToken } from './auth';
import { buildStepUpHeaders, buildStepUpPayload } from './webauthn';

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

export const getAdminUsers = async (params = {}) => {
  const { data } = await api.get('/admin/users', { params });
  return data;
};

// Single-user drill-down detail endpoint (#325).
export const getAdminUser = async (id) => {
  const { data } = await api.get(`/admin/users/${id}`);
  return data;
};

export const getAdminWallets = async (params = {}) => {
  const { data } = await api.get('/admin/wallets', { params });
  return data;
};

// Single-wallet fetch for the drill-down detail page (#326).
export const getAdminWallet = async (id) => {
  const { data } = await api.get(`/admin/wallets/${id}`);
  return data;
};

export const getAdminTransactions = async (params = {}) => {
  const { data } = await api.get('/admin/transactions', { params });
  return data;
};

// Single-transaction fetch for the drill-down detail page (#324).
export const getAdminTransaction = async (id) => {
  const { data } = await api.get(`/admin/transactions/${id}`);
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

export const exportAdminTransactions = async (params = {}) => {
  // Strip cursor/pagination params — exports always cover the full filtered set.
  const { after: _a, before: _b, limit: _l, ...filters } = params;
  const response = await api.get('/admin/transactions/export', { params: filters, responseType: 'blob' });
  triggerDownload(response.data, 'transactions-export.csv');
  return response.data;
};

export const fetchAdminKycExportData = async (params = {}, stepUp = {}) => {
  const { after: _a, before: _b, limit: _l, ...filters } = params;
  const response = await api.get('/admin/kyc/export', {
    params: filters,
    responseType: 'blob',
    headers: buildStepUpHeaders(stepUp),
  });
  return response.data;
};

export const exportAdminKyc = async (params = {}, stepUp = {}) => {
  const data = await fetchAdminKycExportData(params, stepUp);
  triggerDownload(data, 'kyc-export.csv');
  return data;
};

export const exportAdminAuditLogs = async (params = {}) => {
  // Strip cursor/pagination params — exports always cover the full filtered set.
  const { after: _a, before: _b, limit: _l, ...filters } = params;
  const response = await api.get('/admin/audit-logs/export', {
    params: filters,
    responseType: 'blob',
  });
  triggerDownload(response.data, 'audit-logs-export.csv');
  return response.data;
};

export const getAdminSystemHealth = async () => {
  const { data } = await api.get('/admin/system-health');
  return data;
};

// ── WebAuthn / Passkey step-up authentication ─────────────────────────────
// High-risk admin operations are gated behind a browser-native passkey
// assertion (see apps/admin/src/lib/webauthn.js). The API issues a one-time
// challenge, the operator's authenticator signs it, and the serialized
// assertion is attached to the mutation for server-side verification. Falls
// back to a locally generated challenge client-side when the endpoint is not
// deployed, so the biometric prompt still runs.
export const getPasskeyStepUpChallenge = async ({ action } = {}) => {
  const { data } = await api.post('/admin/webauthn/step-up/challenge', { action });
  return data?.data || null;
};

export const approveKyc = async (id, stepUp = {}) => {
  const { data } = await api.post(`/compliance/kyc/${id}/review`, {
    status: 'approved',
    ...buildStepUpPayload(stepUp),
  });
  return data;
};

export const rejectKyc = async (id, reason, stepUp = {}) => {
  const { data } = await api.post(`/compliance/kyc/${id}/review`, {
    status: 'rejected',
    reason,
    ...buildStepUpPayload(stepUp),
  });
  return data;
};

// ── #318: Workflow Events & Ledger Integrity ──────────────────────────────
export const getAdminWorkflowEvents = async (params = {}) => {
  const { data } = await api.get('/admin/events', { params });
  return data;
};

export const verifyAdminEventChain = async () => {
  const { data } = await api.get('/admin/events/verify');
  return data;
};

export const exportAdminWorkflowEvents = async (params = {}) => {
  const { after, before, limit, ...filters } = params;
  const response = await api.get('/admin/events/export', {
    params: filters,
    responseType: 'blob',
  });
  triggerDownload(response.data, 'workflow-events-export.csv');
  return response.data;
};

// ── #329: Compliance Evidence Export & Archive ───────────────────────────
export const getUserEvidencePackage = async (userId) => {
  const { data } = await api.get(`/admin/compliance/evidence/${userId}`);
  return data;
};

export const downloadUserEvidencePackage = async (userId, stepUp = {}) => {
  const response = await api.get(`/admin/compliance/evidence/${userId}/download`, {
    responseType: 'blob',
    headers: buildStepUpHeaders(stepUp),
  });
  triggerDownload(response.data, `evidence-${userId}-${Date.now()}.json`);
  return response.data;
};

export const exportAdminKycEvidence = async (params = {}) => {
  const { after, before, limit, ...filters } = params;
  const response = await api.get('/admin/compliance/kyc-evidence/export', {
    params: filters,
    responseType: 'blob',
  });
  triggerDownload(response.data, 'kyc-evidence-export.csv');
  return response.data;
};

export const exportAdminAccountStatusHistory = async (params = {}) => {
  const { after, before, limit, ...filters } = params;
  const response = await api.get('/admin/compliance/account-status/export', {
    params: filters,
    responseType: 'blob',
  });
  triggerDownload(response.data, 'account-status-export.csv');
  return response.data;
};

// ── #330: Customer Onboarding Status (Admin View) ────────────────────────
export const getUserOnboardingStatus = async (userId) => {
  const { data } = await api.get(`/admin/users/${userId}/onboarding`);
  return data;
};

// ── #332: Customer Account Deactivation / Reactivation ───────────────────
export const deactivateUserAccount = async (userId, { reason, notes, force, ...stepUp } = {}) => {
  const { data } = await api.post(`/admin/users/${userId}/deactivate`, {
    reason,
    notes,
    force,
    ...buildStepUpPayload(stepUp),
  });
  return data;
};

export const reactivateUserAccount = async (userId, { notes, approvedBy, ...stepUp } = {}) => {
  const { data } = await api.post(`/admin/users/${userId}/reactivate`, {
    notes,
    approvedBy,
    ...buildStepUpPayload(stepUp),
  });
  return data;
};

export const getUserAccountStatusHistory = async (userId) => {
  const { data } = await api.get(`/admin/users/${userId}/account-status`);
  return data;
};
