/**
 * AquaShield 3D — auth API (local official accounts).
 * Multipart register (with document upload); JSON login.
 */

import { TOKEN_KEY, storedToken } from './client';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  designation?: string;
  dam_id?: string | null;
  document?: string | null;
  role: string;
  status: string;
}

async function authFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  const token = storedToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/v1/auth${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth error ${res.status}: ${body}`);
  }
  return res.json();
}

export const authApi = {
  register: (form: FormData) =>
    authFetch<{ status: string; message: string; user: AuthUser }>('/register', {
      method: 'POST', body: form,
    }),
  login: (email: string, password: string) =>
    authFetch<{ access_token: string; user: AuthUser }>('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  me: () => authFetch<AuthUser>('/me'),
  users: () => authFetch<{ total: number; users: AuthUser[] }>('/users'),
  approve: (id: string, role = 'official') =>
    authFetch<{ status: string }>(`/users/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }),
  reject: (id: string) =>
    authFetch<{ status: string }>(`/users/${id}/reject`, { method: 'POST' }),
  documentUrl: (filename: string) => `${BASE_URL}/api/v1/auth/documents/${filename}`,
  logout: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* noop */ }
  },
};

