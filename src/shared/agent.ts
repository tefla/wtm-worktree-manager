export type AgentEvent =
  | {
      type: "start";
      requestId: string;
      messageId: string;
      createdAt: number;
    }
  | {
      type: "completion";
      requestId: string;
      messageId: string;
      text: string;
      createdAt: number;
    }
  | {
      type: "error";
      requestId: string;
      messageId: string;
      error: string;
      createdAt: number;
    }
  | {
      type: "tool_call";
      requestId: string;
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      createdAt: number;
    }
  | {
      type: "tool_result";
      requestId: string;
      callId: string;
      name: string;
      output: unknown;
      createdAt: number;
    };

export interface AgentRequest {
  message: string;
}
