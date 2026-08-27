/**
 * frontend/hooks/useWebSocket.ts
 * Native WebSocket hook with automatic reconnection and exponential backoff.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const WS_BASE_URL = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WS_URL) || 'ws://localhost:8080';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL_MS = 25000;

export interface UseWebSocketOptions {
  /** Called when a new message arrives. */
  onMessage: (data: string) => void;
  /** Called on open/close/error events. */
  onStatusChange?: (connected: boolean) => void;
  /** If true, don't auto-connect on mount. Call `connect()` manually. */
  manual?: boolean;
}

export interface UseWebSocketReturn {
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  send: (data: string) => void;
}

export function useWebSocket(
  path: string,
  options: UseWebSocketOptions
): UseWebSocketReturn {
  const { manual = false } = options;
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Store latest callbacks in refs so connect() doesn't need them in its dependencies
  const onMessageRef = useRef(options.onMessage);
  const onStatusChangeRef = useRef(options.onStatusChange);

  useEffect(() => {
    onMessageRef.current = options.onMessage;
    onStatusChangeRef.current = options.onStatusChange;
  });

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearTimers();
    reconnectAttemptRef.current = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnect');
      wsRef.current = null;
    }
    setIsConnected(false);
    onStatusChangeRef.current?.(false);
  }, [clearTimers]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearTimers();
    const url = `${WS_BASE_URL}${path}`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        reconnectAttemptRef.current = 0;
        setIsConnected(true);
        onStatusChangeRef.current?.(true);

        // Start ping/pong keepalive
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (mountedRef.current) {
          onMessageRef.current?.(event.data);
        }
      };

      ws.onclose = (event) => {
        clearTimers();
        setIsConnected(false);
        onStatusChangeRef.current?.(false);

        // Auto-reconnect with exponential backoff (unless intentional close)
        if (
          mountedRef.current &&
          event.code !== 1000 &&
          reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
        ) {
          const delay = RECONNECT_DELAYS_MS[
            Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)
          ];
          reconnectAttemptRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror
        ws.close();
      };
    } catch (err) {
      console.error('[WebSocket] Connection failed:', err);
    }
  }, [path, clearTimers]);

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptRef.current = 0;

    if (!manual) {
      connect();
    }

    return () => {
      mountedRef.current = false;
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
    };
  }, [connect, manual, clearTimers]);

  return { isConnected, connect, disconnect, send };
}
