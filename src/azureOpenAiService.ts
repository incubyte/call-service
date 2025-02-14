import WebSocket from 'ws';
import { config } from 'dotenv';
import { LowLevelRTClient, SessionUpdateMessage, ServerMessageType, ResponseFunctionCallArgumentsDoneMessage, ItemCreateMessage } from "rt-client";
import { OutStreamingData } from '@azure/communication-call-automation';
config();

let ws: WebSocket;

const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
const openAiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
const openAiDeploymentModel = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "";

const answerPromptSystemTemplate = `You are an AI assistant that helps people find information. Say Hello at the start of the call. And ask for the name of the person speaking. Wait for some time before he responds. After that ask them how you can help them. Respond with exact same text that you got from function call.`

let realtimeStreaming: LowLevelRTClient;

export async function sendAudioToExternalAi(data: string) {
    try {
        const audio = data
        if (audio) {
            await realtimeStreaming.send({
                type: "input_audio_buffer.append",
                audio: audio,
            });
        }
    }
    catch (e) {
        console.log(e)
    }
}

export async function startConversation() {

    console.log({openAiDeploymentModel,
        openAiServiceEndpoint,
        openAiKey
    })
    
    await startRealtime(openAiServiceEndpoint, openAiKey, openAiDeploymentModel);
}

async function startRealtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
    try {
        realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });
        console.log("sending session config");
        await realtimeStreaming.send(createConfigMessage());
        console.log("sent");

    } catch (error) {
        console.error("Error during startRealtime:", error);
    }

    setImmediate(async () => {
        try {
            await handleRealtimeMessages();
        } catch (error) {
            console.error('Error handling real-time messages:', error);
        }
    });
}


async function referToAICompanion(user_query: string): Promise<any> {
    try {
        console.log('Referring to medical database for: ', user_query);
        
        const response = await fetch('http://localhost:3000/api/tenant-a/chat/abc123', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([
                {
                    "role": "user",
                    "content": user_query
                }
            ])
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        console.log("--------------------------------")
        console.log("Medical Database Response:", data.answer);
        console.log("--------------------------------")

        return data.answer;

    } catch (error) {
        console.error('Error referring to medical database:', error);
        throw error;
    }
}


function createConfigMessage(): SessionUpdateMessage {

    let configMessage: SessionUpdateMessage = {
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
            temperature: 0,
            tools: [
                {
                    type: "function",
                    name: "referToAICompanion",
                    description: "You can call this function to get information about AI companion and Vaalee. Vaalee is a AI companion that can help you with your questions.",
                    parameters: {
                        type: "object",
                        properties: {
                            user_query: {
                                type: "string",
                                description: "User query to refer to AI companion and Vaalee"
                            }    
                        },
                        required: ["user_query"],
                        additionalProperties: false
                    }
                }
            ],
            tool_choice: "auto",
        }
    };

    return configMessage;
}

async function executeFunctionCall(message: ServerMessageType) {
    try {
        const functionCallMessage = message as ResponseFunctionCallArgumentsDoneMessage;

        console.log("--------------------------------")
        console.log(`Type of arguments: ${typeof functionCallMessage.arguments}`);
        console.log("--------------------------------")

        const argumentsObject = JSON.parse(functionCallMessage.arguments);

        const result = await referToAICompanion(argumentsObject.user_query);
        console.log("Function Call Results:", result);
        return result;
    } catch (error) {
        console.error('Error handling function call:', error);
    }
}

export async function handleRealtimeMessages() {
    for await (const message of realtimeStreaming.messages()) {
        switch (message.type) {
            case "session.created":
                console.log("session started with id:-->" + message.session.id)
                break;
            case "response.audio_transcript.delta":
                break;
            case "response.function_call_arguments.done":
                console.log("Function call arguments done");
                const result = await executeFunctionCall(message);
                console.log("Function Call Results:", result);

                const responseMessage: ItemCreateMessage = {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: message.call_id,
                        output: result
                    }
                };
                await realtimeStreaming.send(responseMessage);
                break;
            case "response.audio.delta":
                await receiveAudioForOutbound(message.delta)
                break;
            case "input_audio_buffer.speech_started":
                console.log(`Voice activity detection started at ${message.audio_start_ms} ms`)
                stopAudio();
                break;
            case "conversation.item.input_audio_transcription.completed":
                console.log(`User:- ${message.transcript}`)
                break;
            case "response.audio_transcript.done":
                console.log(`AI:- ${message.transcript}`)
                break
            case "response.done":
                console.log(message.response.status)
                break;
            default:
                break
        }
    }
}

export async function initWebsocket(socket: WebSocket) {
    ws = socket;
}

async function stopAudio() {
    try {

        const jsonData = OutStreamingData.getStopAudioForOutbound()
        sendMessage(jsonData);
    }
    catch (e) {
        console.log(e)
    }
}
async function receiveAudioForOutbound(data: string) {
    try {

        const jsonData = OutStreamingData.getStreamingDataForOutbound(data)
        sendMessage(jsonData);
    }
    catch (e) {
        console.log(e)
    }
}

async function sendMessage(data: string) {
    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
            return;
        } else {
            console.log(`WebSocket is not open. ReadyState: ${ws.readyState}. Retrying... (${retries + 1}/${maxRetries})`);
            retries++;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
        }
    }

    console.error("Failed to send message: WebSocket connection is not open.");
}