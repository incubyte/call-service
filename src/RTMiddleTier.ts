// RTMiddleTier.ts
import WebSocket from 'ws';
import { Tool, ToolResult, RTToolCall, Session, RTMiddleTierConfig, ToolResultDirection } from './types';
import { WebSocketServer } from 'ws';
import { WebSocket as WSClient } from 'ws';

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

    switch (message.type) {
      case 'session.created':
        const session = message.session;
        session.instructions = '';
        session.tools = [];
        session.voice = this.voiceChoice;
        session.tool_choice = 'none';
        session.max_response_output_tokens = null;
        updatedMessage = JSON.stringify(message);
        break;

      case 'response.output_item.added':
        if (message.item?.type === 'function_call') {
          updatedMessage = null;
        }
        break;

      case 'conversation.item.created':
        if (message.item?.type === 'function_call') {
          const item = message.item;
          if (!this.toolsPending.has(item.call_id)) {
            this.toolsPending.set(item.call_id, {
              tool_call_id: item.call_id,
              previous_id: message.previous_item_id,
            });
          }
          updatedMessage = null;
        } else if (message.item?.type === 'function_call_output') {
          updatedMessage = null;
        }
        break;

      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        updatedMessage = null;
        break;

      case 'response.output_item.done':
        if (message.item?.type === 'function_call') {
          const item = message.item;
          const toolCall = this.toolsPending.get(item.call_id);
          const tool = this.tools.get(item.name);

          if (toolCall && tool) {
            const args = JSON.parse(item.arguments);
            const result = await tool.target(args);

            await this.sendJson(serverWs, {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output:
                  result.destination === ToolResultDirection.TO_SERVER
                    ? this.resultToText(result)
                    : '',
              },
            });

            if (result.destination === ToolResultDirection.TO_CLIENT) {
              await this.sendJson(clientWs, {
                type: 'extension.middle_tier_tool_response',
                previous_item_id: toolCall.previous_id,
                tool_name: item.name,
                tool_result: this.resultToText(result),
              });
            }
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
    ws: WebSocket
  ): Promise<string | null> {
    let updatedMessage = JSON.stringify(message);

    if (message.type === 'session.update') {
      const session: Session = message.session;
      if (this.systemMessage) session.instructions = this.systemMessage;
      if (this.temperature) session.temperature = this.temperature;
      if (this.maxTokens) session.max_response_output_tokens = this.maxTokens;
      if (this.disableAudio !== undefined) session.disable_audio = this.disableAudio;
      if (this.voiceChoice) session.voice = this.voiceChoice;
      session.tool_choice = this.tools.size > 0 ? 'auto' : 'none';
      session.tools = Array.from(this.tools.values()).map(tool => tool.schema);
      updatedMessage = JSON.stringify(message);
      console.log(updatedMessage);
    }

    return updatedMessage;
  }

  private async handleConnection(ws: WebSocket): Promise<void> {
    const headers: { [key: string]: string } = {};
    if (this.key) {
      headers['api-key'] = this.key;
    } else if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${this.tokenProvider()}`;
    }

    const serverWs = new WSClient(
      `${this.endpoint}/openai/realtime?api-version=${this.apiVersion}&deployment=${this.deployment}`,
      {
        headers,
      }
    );

    const handleClientMessages = async () => {
      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = data.toString();
          const processedMsg = await this.processMessageToServer(JSON.parse(msg), ws);
          if (processedMsg) {
            serverWs.send(processedMsg);
          }
        } catch (error) {
          console.error('Error processing client message:', error);
        }
      });

      ws.on('close', () => {
        console.log('Client connection closed');
        serverWs.close();
      });
    };

    const handleServerMessages = async () => {
      serverWs.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = data.toString();
          const processedMsg = await this.processMessageToClient(
            JSON.parse(msg),
            ws,
            serverWs
          );
          if (processedMsg) {
            ws.send(processedMsg);
          }
        } catch (error) {
          console.error('Error processing server message:', error);
        }
      });
    };

    try {
      await Promise.all([handleClientMessages(), handleServerMessages()]);
    } catch (error) {
      console.error('WebSocket error:', error);
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
}
