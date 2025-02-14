import WebSocket from 'ws';
import { config } from 'dotenv';
import { OutStreamingData } from '@azure/communication-call-automation';
config();

let ws: WebSocket;
let aiWs: WebSocket;

const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
const openAiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
const openAiDeploymentModel = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "";

const answerPromptSystemTemplate = `You are an AI assistant that helps people find information. Say Hello at the start of the call. And ask for the name of the person speaking. Wait for some time before he responds. After that ask them how you can help them.`

async function referToMedicalDatabase({user_query}: {user_query: string}): Promise<any> {
    try {
        console.log('Referring to medical database for: ', user_query);
        if (user_query.match(/appointment/i)) {
            return "You have an appointment with Dr. Smith on 12th August 2021 at 10:00 AM";
        }
        if (user_query.match(/prescription/i)) {
            return "You have a prescription for 5mg of Lisinopril";
        }
        if (user_query.match(/lab results/i)) {
            return "Your lab results are normal";
        }
        return "Please call back after some time";
    } catch (error) {
        console.error('Error referring to medical database:', error);
        throw error;
    }
}

export async function sendAudioToExternalAi(data: string) {
    try {
        if (data && aiWs.readyState === WebSocket.OPEN) {
            aiWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data,
            }));
        }
    }
    catch (e) {
        console.error("Error sending audio to external AI:", e);
    }
}

export async function startConversation() {
    await startRealtime(openAiServiceEndpoint, openAiKey, openAiDeploymentModel);
}

async function startRealtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
    try {
        const wsUrl = new URL(endpoint);
        wsUrl.protocol = 'wss:';
        wsUrl.pathname = wsUrl.pathname.replace(/\/$/, ''); // Remove trailing slash if present

        const fullUrl = `${wsUrl.toString()}/openai/realtime?api-version=2024-10-01-preview&deployment=${deploymentOrModel}`;
        console.log("Connecting to:", fullUrl);

        aiWs = new WebSocket(fullUrl, {
            headers: {
                'api-key': apiKey,
                'Authorization': `Bearer ${apiKey}`
            }
        });

        aiWs.on('open', async () => {
            console.log("WebSocket connection established");
            console.log("sending session config");
            const config = createConfigMessage();
            console.log("Config:", JSON.stringify(config, null, 2));
            aiWs.send(JSON.stringify(config));
            console.log("sent");
        });

        aiWs.on('message', async (data) => {
            const parsedMessage = JSON.parse(data.toString());
            // console.log("Received message:", parsedMessage.type, parsedMessage);  // Log full message for debugging
            await handleRealtimeMessages(parsedMessage);
        });

        aiWs.on('error', (error) => {
            console.error("WebSocket error:", error);
        });

        aiWs.on('close', (code, reason) => {
            console.log(`WebSocket connection closed with code ${code}. Reason: ${reason}`);
        });

    } catch (error) {
        console.error("Error during startRealtime:", error);
    }
}

function createConfigMessage() {
    return {
        type: "session.update",
        session: {
            instructions: answerPromptSystemTemplate,
            voice: "shimmer",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
                type: "server_vad",
            },
            input_audio_transcription: {
                model: "whisper-1"
            },
            tools: [
                {
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
                        }
                    }
                }                
            ],
            tool_choice: "auto"
        }
    };
}

export async function handleRealtimeMessages(message: any) {
    try {
        switch (message.type) {
            case "session.created":
                console.log("session started with id:-->" + message.session.id);
                break;
            case "session.updated":
                // Handle session update message
                break;
            case "response.audio_transcript.delta":
                console.log("Received transcript delta:", message);
                break;
            case "response.audio.delta":
                console.log("Received audio delta:", message.delta.length);  // Log audio data length
                await receiveAudioForOutbound(message.delta);
                break;
            case "input_audio_buffer.speech_started":
                console.log(`Voice activity detection started at ${message.audio_start_ms} ms`);
                await stopAudio();
                break;
            case "conversation.item.input_audio_transcription.completed":
                console.log(`User:- ${message.transcript}`);
                break;
            case "response.audio_transcript.done":
                console.log(`AI:- ${message.transcript}`);
                break;
            case "response.function_call_arguments.done":
                console.log("Function call arguments received:", message.arguments);
                const result = await referToMedicalDatabase(JSON.parse(message.arguments));
                console.log("Function call result:", result);
                break;
            case "response.done":
                console.log("Response status:", message.response.status);
                break;
            default:
                console.log("Unhandled message type:", message.type, message);  // Log full unhandled messages
                break;
        }
    } catch (error) {
        console.error("Error handling realtime message:", error);
    }
}

export async function initWebsocket(socket: WebSocket) {
    ws = socket;
    console.log("Client websocket initialized");
}

async function stopAudio() {
    try {
        const jsonData = OutStreamingData.getStopAudioForOutbound();
        await sendMessage(jsonData);
    }
    catch (e) {
        console.error("Error stopping audio:", e);
    }
}

async function receiveAudioForOutbound(data: string) {
    try {
        console.log("Processing audio data of length:", data.length);  // Add debug logging
        const jsonData = OutStreamingData.getStreamingDataForOutbound(data);
        await sendMessage(jsonData);
    }
    catch (e) {
        console.error("Error receiving audio for outbound:", e);
    }
}

async function sendMessage(data: string) {
    if (!ws) {
        console.error("WebSocket not initialized");
        return;
    }
    
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        console.log("Sent audio data successfully");  // Add confirmation log
    } else {
        console.error(`Socket connection is not open. Current state: ${ws.readyState}`);
    }
}
