/**
 * DamSafe Twin — auth context (local official accounts + dev fallback).
 * A stored JWT means a verified official/admin; otherwise the app runs in
 * the historical dev-operator mode so nothing breaks without login.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { TOKEN_KEY } from '../api/client';
import { authApi, type AuthUser } from '../api/auth';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  /** Dam this account may RUN simulations on (null = unrestricted). */
  scopeDamId: string | null;
  isAdmin: boolean;
  isOfficial: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null, token: null, loading: true,
  login: async () => {}, logout: () => {}, refresh: async () => {},
  scopeDamId: null, isAdmin: false, isOfficial: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    authApi.logout();
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(TOKEN_KEY);
    } catch { /* noop */ }
    if (!stored) {
      setToken(null);
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await authApi.me();
      setToken(stored);
      setUser(me);
    } catch {
      logout();
    }
    setLoading(false);
  }, [logout]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    try {
      localStorage.setItem(TOKEN_KEY, res.access_token);
    } catch { /* noop */ }
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const isAdmin = user?.role === 'admin';
  const isOfficial = !!user && !isAdmin;

  return (
    <AuthContext.Provider
      value={{
        user, token, loading, login, logout, refresh,
        scopeDamId: user?.dam_id ?? null,
        isAdmin, isOfficial,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
