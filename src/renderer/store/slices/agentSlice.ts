import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AgentEvent } from "../../../shared/agent";

type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  text: string;
  createdAt: number;
  status: "pending" | "complete" | "error";
  metadata?: Record<string, unknown>;
}

export interface AgentFeatureState {
  open: boolean;
  draft: string;
  messages: AgentMessage[];
  sending: boolean;
  currentRequestId: string | null;
  activeAssistantMessageId: string | null;
  unreadCount: number;
  lastError: string | null;
}

const initialState: AgentFeatureState = {
  open: false,
  draft: "",
  messages: [],
  sending: false,
  currentRequestId: null,
  activeAssistantMessageId: null,
  unreadCount: 0,
  lastError: null,
};

function appendMessage(state: AgentFeatureState, message: AgentMessage): void {
  state.messages = [...state.messages, message];
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

const agentSlice = createSlice({
  name: "agent",
  initialState,
  reducers: {
    setOpen(state, action: PayloadAction<boolean>) {
      state.open = action.payload;
      if (state.open) {
        state.unreadCount = 0;
      }
    },
    toggleOpen(state) {
      state.open = !state.open;
      if (state.open) {
        state.unreadCount = 0;
      }
    },
    setDraft(state, action: PayloadAction<string>) {
      state.draft = action.payload;
    },
    clearDraft(state) {
      state.draft = "";
    },
    pushUserMessage(state, action: PayloadAction<{ id: string; text: string; createdAt: number }>) {
      appendMessage(state, {
        id: action.payload.id,
        role: "user",
        text: action.payload.text,
        createdAt: action.payload.createdAt,
        status: "complete",
      });
      state.draft = "";
      state.sending = true;
      state.lastError = null;
    },
    resetSessionState(state) {
      state.messages = [];
      state.currentRequestId = null;
      state.activeAssistantMessageId = null;
      state.lastError = null;
      state.unreadCount = 0;
    },
    ingestAgentEvent(state, action: PayloadAction<AgentEvent>) {
      const event = action.payload;
      switch (event.type) {
        case "start": {
          state.currentRequestId = event.requestId;
          state.activeAssistantMessageId = event.messageId;
          state.sending = true;
          appendMessage(state, {
            id: event.messageId,
            role: "assistant",
            text: "",
            createdAt: event.createdAt,
            status: "pending",
          });
          break;
        }
        case "completion": {
          if (state.activeAssistantMessageId === event.messageId) {
            state.activeAssistantMessageId = null;
          }
          if (state.currentRequestId === event.requestId) {
            state.currentRequestId = null;
          }
          state.sending = false;
          const target = state.messages.find((message) => message.id === event.messageId);
          if (target) {
            target.text = event.text;
            target.status = "complete";
            target.createdAt = event.createdAt;
          } else {
            appendMessage(state, {
              id: event.messageId,
              role: "assistant",
              text: event.text,
              createdAt: event.createdAt,
              status: "complete",
            });
          }
          if (!state.open) {
            state.unreadCount += 1;
          }
          state.lastError = null;
          break;
        }
        case "error": {
          if (state.activeAssistantMessageId === event.messageId) {
            const target = state.messages.find((message) => message.id === event.messageId);
            if (target) {
              target.status = "error";
              target.text = event.error;
              target.createdAt = event.createdAt;
            }
          } else {
            appendMessage(state, {
              id: event.messageId,
              role: "system",
              text: event.error,
              createdAt: event.createdAt,
              status: "error",
            });
          }
          state.sending = false;
          state.currentRequestId = null;
          state.activeAssistantMessageId = null;
          state.lastError = event.error;
          if (!state.open) {
            state.unreadCount += 1;
          }
          break;
        }
        case "tool_call": {
          appendMessage(state, {
            id: event.callId,
            role: "tool",
            text: `Requested tool '${event.name}' with arguments:\n${formatArgs(event.arguments)}`,
            createdAt: event.createdAt,
            status: "pending",
            metadata: { toolCallId: event.callId, name: event.name },
          });
          break;
        }
        case "tool_result": {
          const target = state.messages.find((message) => message.id === event.callId);
          const outputText =
            typeof event.output === "string" ? event.output : formatArgs(event.output as Record<string, unknown>);
          if (target) {
            target.status = "complete";
            target.text = `Tool '${event.name}' returned:\n${outputText}`;
            target.createdAt = event.createdAt;
          } else {
            appendMessage(state, {
              id: `${event.callId}-result`,
              role: "tool",
              text: `Tool '${event.name}' returned:\n${outputText}`,
              createdAt: event.createdAt,
              status: "complete",
              metadata: { toolCallId: event.callId, name: event.name },
            });
          }
          if (!state.open) {
            state.unreadCount += 1;
          }
          break;
        }
        default:
          break;
      }
    },
  },
});

export const {
  setOpen,
  toggleOpen,
  setDraft,
  clearDraft,
  pushUserMessage,
  resetSessionState,
  ingestAgentEvent,
} = agentSlice.actions;

export const agentReducer = agentSlice.reducer;

export const selectAgentState = (state: { agent: AgentFeatureState }) => state.agent;
