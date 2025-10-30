import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { agentAPI } from "../services/ipc";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import {
  clearDraft,
  ingestAgentEvent,
  pushUserMessage,
  resetSessionState,
  selectAgentState,
  setDraft,
  setOpen,
  toggleOpen,
} from "../store/slices/agentSlice";
import { cx } from "../utils/cx";
import { selectProjectState } from "../store/slices/projectSlice";

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export const AgentDock: React.FC = () => {
  const dispatch = useAppDispatch();
  const { open, draft, messages, sending, unreadCount, lastError } = useAppSelector(selectAgentState);
  const { agentApiKey } = useAppSelector(selectProjectState);
  const apiKeyConfigured = Boolean(agentApiKey && agentApiKey.trim());
  const messageContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const dispose = agentAPI.onEvent((event) => {
      dispatch(ingestAgentEvent(event));
    });
    return () => {
      dispose();
    };
  }, [dispatch]);

  useEffect(() => {
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleToggle = useCallback(() => {
    dispatch(toggleOpen());
  }, [dispatch]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      dispatch(setDraft(event.target.value));
    },
    [dispatch],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!draft.trim() || sending || !apiKeyConfigured) {
        return;
      }
      const text = draft.trim();
      const now = Date.now();
      const userMessageId = generateId();
      dispatch(pushUserMessage({ id: userMessageId, text, createdAt: now }));
      dispatch(clearDraft());
      try {
        await agentAPI.sendMessage({ message: text });
      } catch (error) {
        console.error("Agent request failed", error);
        const messageId = generateId();
        dispatch(
          ingestAgentEvent({
            type: "error",
            requestId: messageId,
            messageId,
            error:
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "Agent request failed.",
            createdAt: Date.now(),
          }),
        );
      }
    },
    [apiKeyConfigured, dispatch, draft, sending],
  );

  const handleReset = useCallback(async () => {
    dispatch(resetSessionState());
    dispatch(clearDraft());
    await agentAPI.resetSession().catch((error) => {
      console.error("Failed to reset agent session", error);
    });
  }, [dispatch]);

  const headerStatus = useMemo(() => {
    if (!apiKeyConfigured) {
      return "Add an OpenAI API key in Settings to begin.";
    }
    if (sending) {
      return "Thinking…";
    }
    if (lastError) {
      return "Encountered an error";
    }
    return "Ready";
  }, [lastError, sending]);

  return (
    <div className={cx("agent-dock", { open })}>
      <button className="agent-toggle" type="button" onClick={handleToggle}>
        <span>Agent</span>
        {unreadCount > 0 ? <span className="agent-unread">{unreadCount}</span> : null}
      </button>
      {open ? (
        <div className="agent-panel">
          <header className="agent-header">
            <div className="agent-header-text">
              <strong>WTM Copilot</strong>
              <span>{headerStatus}</span>
            </div>
            <div className="agent-header-actions">
              <button type="button" className="ghost-button" onClick={handleReset} disabled={sending}>
                Clear
              </button>
              <button type="button" className="ghost-button" onClick={() => dispatch(setOpen(false))}>
                Close
              </button>
            </div>
          </header>
          <div className="agent-messages" ref={messageContainerRef}>
            {messages.length === 0 ? (
              <div className="agent-empty">
                {apiKeyConfigured
                  ? "Ask about workspace status, terminal output, or request commands to run inside your worktrees."
                  : "Configure an OpenAI API key in Settings → OpenAI Agent to start chatting."}
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={cx("agent-message", message.role, message.status)}>
                  <span className="agent-message-role">{message.role}</span>
                  <p className="agent-message-text">{message.text || (message.status === "pending" ? "…" : "")}</p>
                </div>
              ))
            )}
          </div>
          <form className="agent-input" onSubmit={handleSubmit}>
            <textarea
              value={draft}
              onChange={handleChange}
              placeholder="Ask the agent…"
              rows={3}
              disabled={sending || !apiKeyConfigured}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="agent-input-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={sending || !draft.trim() || !apiKeyConfigured}
                title={apiKeyConfigured ? undefined : "Add an OpenAI API key in Settings to enable the agent."}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
};
