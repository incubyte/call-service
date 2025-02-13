// RTMiddleTier.ts
import WebSocket from 'ws';
import { Tool, ToolResult, RTToolCall, Session, RTMiddleTierConfig, ToolResultDirection } from './types';
import { WebSocketServer } from 'ws';
import { WebSocket as WSClient } from 'ws';

async function referToMedicalDatabase(user_query: string): Promise<ToolResult> {

  console.log("--------------------------------");
  console.log("user_query | referToMedicalDatabase", user_query);
  console.log("--------------------------------");

  try {
      console.log('Referring to medical database for: ', user_query);
      let response = "";
      if (user_query.match(/appointment/i)) {
          response = "You have an appointment with Dr. Smith on 12th August 2021 at 10:00 AM";
      } else if (user_query.match(/prescription/i)) {
          response = "You have a prescription for 5mg of Lisinopril";
      } else if (user_query.match(/lab results/i)) {
          response = "Your lab results are normal";
      } else {
          response = "Please call back after some time";
      }
      return {
          text: response,
          destination: ToolResultDirection.TO_CLIENT
      };
  } catch (error) {
      console.error('Error referring to medical database:', error);
      throw error;
  }
}

const referToMedicalDatabaseToolSchema = {
  type: "function",
  name: "referToMedicalDatabase",
  description: "You can call this function to get the refer to medical database when asked for appointment, prescription or lab results.",
  parameters: {
      type: "object",
      properties: {
          user_query: {
              type: "string",
              description: "User query to refer to medical database"
          }    
      },
      required: ["user_query"],
      additionalProperties: false
  }
};

export class RTMiddleTier {
  private endpoint: string;
  private deployment: string;
  private key?: string;
  private tools: Map<string, Tool> = new Map();
  private model?: string;
  private systemMessage?: string;
  private temperature?: number;
  private maxTokens?: number;
  private disableAudio?: boolean;
  private voiceChoice?: string;
  private apiVersion: string = '2024-10-01-preview';
  private toolsPending: Map<string, RTToolCall> = new Map();
  private tokenProvider?: () => string;

  constructor(config: RTMiddleTierConfig) {
    this.endpoint = config.endpoint;
    this.deployment = config.deployment;
    this.voiceChoice = config.voiceChoice;
    this.model = config.model;
    this.systemMessage = config.systemMessage;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.disableAudio = config.disableAudio;

    this.tools.set('referToMedicalDatabase', {
      target: referToMedicalDatabase,
      schema: referToMedicalDatabaseToolSchema
    });

    if (config.credentials.key) {
      this.key = config.credentials.key;
    } else {
      this.tokenProvider = () => {
        // Implementation for Azure token provider
        return '';
      };
    }
  }

  private async processMessageToClient(
    message: any,
    clientWs: WebSocket,
    serverWs: WebSocket
  ): Promise<string | null> {
    let updatedMessage = JSON.stringify(message);

    if(!message.type.startsWith("input_audio_buffer")) {
      // console.log("--------------------------------");
      // console.log("message.type | client", message.type);
      // console.log("--------------------------------");
    }

    switch (message.type) {
      case 'session.created':
        console.log("[SESSION] Creating new session with tools");
        const session = message.session;
        session.instructions = `You are an AI assistant that helps people find information about their medical records. 
        You MUST ALWAYS use the referToMedicalDatabase function when users ask about:
        - appointments
        - prescriptions
        - lab results

        DO NOT make up responses. ALWAYS use the function to get accurate information.
        First, say Hello and ask for the person's name. After they respond, ask how you can help them.`;
        session.tools = [
          referToMedicalDatabaseToolSchema
        ];
        console.log("[SESSION] Tools configured:", session.tools);
        session.voice = this.voiceChoice;
        session.tool_choice = 'auto';
        session.max_response_output_tokens = null;
        updatedMessage = JSON.stringify(message);
        break;

      case 'response.output_item.added':
        if (message.item?.type === 'function_call') {
          updatedMessage = null;
        }
        break;

      case 'conversation.item.created':
        console.log("[CONVERSATION] Full message:", JSON.stringify(message, null, 2));
        console.log("[CONVERSATION] Item created:", {
          type: message.item?.type,
          name: message.item?.name,
          content: message.item?.content,
          role: message.item?.role
        });

        if (message.item?.type === 'function_call') {
          const item = message.item;
          console.log("[TOOL] Function call received:", {
            name: item.name,
            arguments: item.arguments,
            call_id: item.call_id
          });
          
          if (!this.toolsPending.has(item.call_id)) {
            console.log("[TOOL] Adding to pending tools");
            this.toolsPending.set(item.call_id, {
              tool_call_id: item.call_id,
              previous_id: message.previous_item_id,
            });
          }
          updatedMessage = null;
        } else if (message.item?.type === 'function_call_output') {
          console.log(message.item.output);
          updatedMessage = null;
        }
        break;

      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        updatedMessage = null;
        break;

      case 'response.output_item.done':
        console.log("[RESPONSE] Output item done:", {
          type: message.item?.type,
          name: message.item?.name,
          content: message.item?.content
        });

        if (message.item?.type === 'function_call') {
          console.log("[TOOL] Processing function call completion:", message.item.name);
          const item = message.item;
          const toolCall = this.toolsPending.get(item.call_id);
          const tool = this.tools.get(item.name);

          if (toolCall && tool) {
            console.log("[TOOL] Executing tool:", item.name);
            const args = JSON.parse(item.arguments);
            const result = await tool.target(args);
            console.log("[TOOL] Tool execution completed");

            // Send result back to server
            if (result.destination === ToolResultDirection.TO_SERVER) {
              console.log("[TOOL] Sending result to server");
              await this.sendJson(serverWs, {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: this.resultToText(result)
                }
              });
            }

            // Send result to client if needed
            if (result.destination === ToolResultDirection.TO_CLIENT) {
              console.log("[TOOL] Sending result to client:", result);
              await this.sendJson(clientWs, {
                type: 'extension.middle_tier_tool_response',
                previous_item_id: toolCall.previous_id,
                tool_name: item.name,
                tool_result: this.resultToText(result)
              });
            }
          } else {
            console.log("[TOOL] Tool call or tool not found:", item.name);
          }
          updatedMessage = null;
        }
        break;

      case 'response.done':
        if (this.toolsPending.size > 0) {
          this.toolsPending.clear();
          await this.sendJson(serverWs, {
            type: 'response.create',
          });
        }
        if (message.response) {
          let replace = false;
          const outputs = message.response.output;
          for (let i = outputs.length - 1; i >= 0; i--) {
            if (outputs[i].type === 'function_call') {
              outputs.splice(i, 1);
              replace = true;
            }
          }
          if (replace) {
            updatedMessage = JSON.stringify(message);
          }
        }
        break;
    }

    return updatedMessage;
  }

  private async processMessageToServer(
    message: any,
  ): Promise<string | null> {
    let updatedMessage = JSON.stringify(message);

    if(!message.type.startsWith("input_audio_buffer")) {
      // console.log("--------------------------------");
      // console.log("message.type | server", message.type);
      // console.log("--------------------------------");
    }

    if (message.type === 'session.update') {
      console.log("[SESSION] Processing session update");
      const session: Session = message.session;
      if (this.systemMessage) {
        console.log("[SESSION] Applying system message override");
        session.instructions = this.systemMessage;
      }
      if (this.temperature) session.temperature = this.temperature;
      if (this.maxTokens) session.max_response_output_tokens = this.maxTokens;
      if (this.disableAudio !== undefined) session.disable_audio = this.disableAudio;
      if (this.voiceChoice) session.voice = this.voiceChoice;
      if (this.tools.size > 0) {
        console.log("[SESSION] Configuring tools:", Array.from(this.tools.keys()));
        session.tool_choice = 'auto';
        session.tools = Array.from(this.tools.values()).map(tool => tool.schema);
      }
      // console.log("--------------------------------");
      // console.log("session.tool_choice | server", session.tool_choice);
      // console.log("--------------------------------");
      updatedMessage = JSON.stringify(message);
      console.log(updatedMessage);
    }

    return updatedMessage;
  }

  private async handleConnection(serverWs: WebSocket): Promise<void> {
    console.log("[CONNECT] New client connection attempting to establish");
    
    const openaiWs = new WebSocket(
      `${this.endpoint}/openai/realtime?api-version=${this.apiVersion}&deployment=${this.deployment}`,
      {
        headers: this.getHeaders(),
      }
    );

    // Wait for server connection
    await new Promise((resolve, reject) => {
      openaiWs.on('open', () => {
        console.log("[CONNECT] Server WebSocket connection established");
        resolve(true);
      });
      openaiWs.on('error', (error) => {
        console.error("[ERROR] Server WebSocket connection failed:", error);
        reject(error);
      });
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    const handleClientMessages = async () => {
      serverWs.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log("[CLIENT->SERVER] Message type:", msg.type);
          
          const processedMsg = await this.processMessageToServer(msg);
          if (processedMsg && openaiWs.readyState === WebSocket.OPEN) {
            console.log("[CLIENT->SERVER] Forwarding processed message");
            openaiWs.send(processedMsg);
          } else {
            console.log("[CLIENT->SERVER] Message dropped or connection closed");
          }
        } catch (error) {
          console.error("[ERROR] Processing client message:", error);
        }
      });

      serverWs.on('close', () => {
        console.log("[DISCONNECT] Client connection closed");
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      });
    };

    const handleServerMessages = async () => {
      openaiWs.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log("[SERVER->CLIENT] Message type:", msg.type);
          
          if (msg.type === 'conversation.item.created' && msg.item?.type === 'function_call') {
            console.log("[TOOL] Function call detected:", msg.item.name);
          }

          const processedMsg = await this.processMessageToClient(msg, serverWs, openaiWs);
          if (processedMsg && serverWs.readyState === WebSocket.OPEN) {
            console.log("[SERVER->CLIENT] Forwarding processed message");
            serverWs.send(processedMsg);
          } else {
            console.log("[SERVER->CLIENT] Message dropped or connection closed");
          }
        } catch (error) {
          console.error("[ERROR] Processing server message:", error);
        }
      });
    };

    try {
      await Promise.all([handleClientMessages(), handleServerMessages()]);
    } catch (error) {
      console.error("[ERROR] WebSocket handling error:", error);
      if (serverWs.readyState === WebSocket.OPEN) serverWs.close();
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  }

  public attachToServer(server: any, path: string): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: any, socket: any, head: any) => {
      if (request.url === path) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          this.handleConnection(ws);
        });
      }
    });
  }

  private async sendJson(ws: WebSocket, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify(data), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private resultToText(result: ToolResult): string {
    if (result.text === null) return '';
    return typeof result.text === 'string'
      ? result.text
      : JSON.stringify(result.text);
  }

  // Method to add tools
  public addTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  private getHeaders(): { [key: string]: string } {
    const headers: { [key: string]: string } = {};
    if (this.key) {
      headers['api-key'] = this.key;
    } else if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${this.tokenProvider()}`;
    }
    return headers;
  }
}
