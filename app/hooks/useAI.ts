import { useCallback, useEffect, useRef } from 'react';
import { useConnection, Message } from '../contexts/ConnectionContext';
import type { AIEvent, AISession, AIMessage, AIAgent, AIProvider, ModelRef } from '../plugins/core/ai/types';

export interface AIEvents {
  onEvent?: (event: AIEvent) => void;
}

export function useAI(events?: AIEvents) {
  const { sendControl, onDataEvent, status } = useConnection();
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // Listen for AI events from data channel
  useEffect(() => {
    const unsubscribe = onDataEvent((message: Message) => {
      if (message.ns !== 'ai' || message.action !== 'event') return;
      if (eventsRef.current?.onEvent) {
        eventsRef.current.onEvent(message.payload as AIEvent);
      }
    });

    return unsubscribe;
  }, [onDataEvent]);

  const isConnected = status === 'connected';

  // Session management
  const createSession = useCallback(async (title?: string): Promise<AISession> => {
    const response = await sendControl('ai', 'createSession', { title });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to create session');
    return response.payload.session as AISession;
  }, [sendControl]);

  const listSessions = useCallback(async (): Promise<AISession[]> => {
    const response = await sendControl('ai', 'listSessions');
    if (!response.ok) throw new Error(response.error?.message || 'Failed to list sessions');
    return response.payload.sessions as AISession[];
  }, [sendControl]);

  const getSession = useCallback(async (id: string): Promise<AISession> => {
    const response = await sendControl('ai', 'getSession', { id });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get session');
    return response.payload.session as AISession;
  }, [sendControl]);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    const response = await sendControl('ai', 'deleteSession', { id });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to delete session');
  }, [sendControl]);

  const getMessages = useCallback(async (sessionId: string): Promise<AIMessage[]> => {
    const response = await sendControl('ai', 'getMessages', { id: sessionId });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get messages');
    return response.payload.messages as AIMessage[];
  }, [sendControl]);

  // Prompting
  const sendPrompt = useCallback(async (sessionId: string, text: string, model?: ModelRef): Promise<void> => {
    const response = await sendControl('ai', 'prompt', { sessionId, text, model });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to send prompt');
  }, [sendControl]);

  const abort = useCallback(async (sessionId: string): Promise<void> => {
    const response = await sendControl('ai', 'abort', { sessionId });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to abort');
  }, [sendControl]);

  // Configuration
  const getAgents = useCallback(async (): Promise<AIAgent[]> => {
    const response = await sendControl('ai', 'agents');
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get agents');
    return response.payload.agents as AIAgent[];
  }, [sendControl]);

  const getProviders = useCallback(async (): Promise<AIProvider[]> => {
    const response = await sendControl('ai', 'providers');
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get providers');
    return response.payload.providers as AIProvider[];
  }, [sendControl]);

  const setAuth = useCallback(async (providerId: string, key: string): Promise<void> => {
    const response = await sendControl('ai', 'setAuth', { providerId, key });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to set auth');
  }, [sendControl]);

  // Commands
  const runCommand = useCallback(async (sessionId: string, command: string): Promise<unknown> => {
    const response = await sendControl('ai', 'command', { sessionId, command });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to run command');
    return response.payload.result;
  }, [sendControl]);

  const revert = useCallback(async (sessionId: string, messageId: string): Promise<void> => {
    const response = await sendControl('ai', 'revert', { sessionId, messageId });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to revert');
  }, [sendControl]);

  const unrevert = useCallback(async (sessionId: string): Promise<void> => {
    const response = await sendControl('ai', 'unrevert', { sessionId });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to unrevert');
  }, [sendControl]);

  const share = useCallback(async (sessionId: string): Promise<{ url: string }> => {
    const response = await sendControl('ai', 'share', { sessionId });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to share');
    return response.payload.share as { url: string };
  }, [sendControl]);

  // Permissions
  const replyPermission = useCallback(async (sessionId: string, permissionId: string, approved: boolean): Promise<void> => {
    const response = await sendControl('ai', 'permission', { sessionId, permissionId, approved });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to reply permission');
  }, [sendControl]);

  return {
    isConnected,
    createSession,
    listSessions,
    getSession,
    deleteSession,
    getMessages,
    sendPrompt,
    abort,
    getAgents,
    getProviders,
    setAuth,
    runCommand,
    revert,
    unrevert,
    share,
    replyPermission,
  };
}
