/**
 * Authentication state, backed by real server sessions.
 *
 * Three defects from the previous version are fixed here:
 *
 * 1. **Double-wrapped user on reload.** `checkAuth` did `setUser(response.data)`
 *    while the mock returned `{ data: { user } }`, so after any page refresh
 *    `user` became `{ user: {...} }` and `user.name`, `user.points` and
 *    `user.fattyLiverIndex` were all undefined. The dashboard silently fell
 *    back to defaults on every reload.
 * 2. **Wrong auth shape.** It stored `authToken` / `refreshToken` in
 *    localStorage, but the backend uses Passport **session cookies**. Nothing
 *    was ever sent to a server, and the scaffolding could not have worked.
 * 3. **Any password accepted.** The mock commented "accept any email/password
 *    combination". Credentials are now verified server-side with bcrypt.
 *
 * NOTE: the frontend is being rebuilt. This exists so the current tree has a
 * working, honest auth path, not as the final design.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import apiService, { ApiError } from '../services/apiService.jsx';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * Resolve the session from the server.
   *
   * The session cookie is HttpOnly, so the browser cannot inspect it; asking
   * the server is the only way to know whether one is valid. A 401 simply means
   * "not signed in" and is not an error worth surfacing.
   */
  const refresh = useCallback(async () => {
    try {
      const response = await apiService.auth.me();
      setUser(response.user ?? null);
      return response.user ?? null;
    } catch (requestError) {
      if (!(requestError instanceof ApiError) || requestError.status !== 401) {
        setError(requestError.message);
      }
      setUser(null);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email, password) => {
    setError(null);
    try {
      await apiService.auth.login(email, password);
      return { success: true, user: await refresh() };
    } catch (requestError) {
      setError(requestError.message);
      return { success: false, error: requestError.message };
    }
  }, [refresh]);

  const signup = useCallback(async (email, password) => {
    setError(null);
    try {
      await apiService.auth.register(email, password);
      await apiService.auth.login(email, password);
      return { success: true, user: await refresh() };
    } catch (requestError) {
      setError(requestError.message);
      return { success: false, error: requestError.message };
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiService.auth.logout();
    } finally {
      // Clear locally even if the request failed, so the UI cannot show a
      // signed-in state the server disagrees with.
      setUser(null);
    }
  }, []);

  const saveProfile = useCallback(async (profile) => {
    setError(null);
    try {
      const response = await apiService.user.saveProfile(profile);
      await refresh();
      return { success: true, staticData: response.staticData };
    } catch (requestError) {
      setError(requestError.message);
      return { success: false, error: requestError.message, details: requestError.details };
    }
  }, [refresh]);

  const value = useMemo(() => ({
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    error,
    login,
    signup,
    logout,
    saveProfile,
    refresh,
  }), [user, isLoading, error, login, signup, logout, saveProfile, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default AuthContext;
