// types.ts
export enum ToolResultDirection {
    TO_SERVER = 1,
    TO_CLIENT = 2,
  }
  
  export interface ToolResult {
    text: string | object;
    destination: ToolResultDirection;
  }
  
  export interface Tool {
    target: (args: any) => Promise<ToolResult>;
    schema: any;
  }
  
  export interface RTToolCall {
    tool_call_id: string;
    previous_id: string;
  }
  
  export interface Session {
    instructions?: string;
    tools?: any[];
    voice?: string;
    tool_choice?: string;
    max_response_output_tokens?: number | null;
    temperature?: number;
    disable_audio?: boolean;
  }
  
  export interface RTMiddleTierConfig {
    endpoint: string;
    deployment: string;
    credentials: any; // Azure credentials
    voiceChoice?: string;
    model?: string;
    systemMessage?: string;
    temperature?: number;
    maxTokens?: number;
    disableAudio?: boolean;
  }
  