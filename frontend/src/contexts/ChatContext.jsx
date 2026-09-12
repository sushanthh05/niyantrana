/**
 * Chat state, backed by the server-side Gemini proxy.
 *
 * Replaces a browser-side client that read `VITE_GEMINI_API_KEY`. Vite inlines
 * anything VITE_-prefixed into the bundle, so that key was readable by anyone
 * who opened devtools, and spendable against the project's quota. The key now
 * lives only on the server and the browser calls POST /api/chat.
 *
 * The old client also faked token-by-token streaming from seven canned strings
 * whenever the API failed, so a user could not tell a real answer from a stub.
 * A failure is now surfaced as a failure.
 *
 * NOTE: the frontend is being rebuilt. This module exists so the current tree
 * has no path that ships a secret, not as the final design.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const STORAGE_KEY = 'niyantrana_chat_history_v2';

const ChatContext = createContext(null);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used inside a ChatProvider');
  return context;
};

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState(loadHistory);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);

  const persist = useCallback((next) => {
    setMessages(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-40))); } catch { /* quota */ }
  }, []);

  const send = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || isSending) return;

    setError(null);
    setIsSending(true);
    const withUser = [...messages, { role: 'user', text: trimmed }];
    persist(withUser);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        credentials: 'include',        // session cookie, not a bearer token
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: withUser.slice(-12, -1),
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Surfaced, not papered over with a canned reply.
        setError(body.message || 'The assistant is unavailable right now.');
        return;
      }
      persist([...withUser, { role: 'model', text: body.reply }]);
    } catch (requestError) {
      setError(requestError.message || 'Could not reach the assistant.');
    } finally {
      setIsSending(false);
    }
  }, [messages, isSending, persist]);

  const clear = useCallback(() => {
    persist([]);
    setError(null);
  }, [persist]);

  const value = useMemo(
    () => ({ messages, isSending, error, send, clear }),
    [messages, isSending, error, send, clear],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export default ChatContext;
