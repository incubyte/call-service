// app.ts
import { config } from 'dotenv';
import express, { Application } from 'express';
import http from 'http';
import {
    CallAutomationClient,
    AnswerCallOptions,
    AnswerCallResult,
    MediaStreamingOptions,
} from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';
import { RTMiddleTier } from './RTMiddleTier';
import { AzureKeyCredential } from '@azure/core-auth';

config();

const PORT = process.env.PORT || 3000;
const app: Application = express();
app.use(express.json());
const server = http.createServer(app);

let acsClient: CallAutomationClient;
let answerCallResult: AnswerCallResult;
let callerId: string;

// Configure RTMiddleTier
const rtMiddleTier = new RTMiddleTier({
    endpoint: process.env.AZURE_OPENAI_SERVICE_ENDPOINT!,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME!,
    credentials: new AzureKeyCredential(process.env.AZURE_OPENAI_SERVICE_KEY!),
    voiceChoice: process.env.VOICE_CHOICE ?? 'alloy',
});

async function createAcsClient() {
    const connectionString = process.env.CONNECTION_STRING || "";
    acsClient = new CallAutomationClient(connectionString, {
        allowInsecureConnection: false,
        retryOptions: {
            maxRetries: 3,
            retryDelayInMs: 1000,
            maxRetryDelayInMs: 5000
        }
    });
    console.log("Initialized ACS Client.");
}

app.post("/api/incomingCall", async (req: any, res: any) => {
    const event = req.body[0];
    try {
        const eventData = event.data;
        if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
            console.log("Received SubscriptionValidation event");
            res.status(200).json({
                validationResponse: eventData.validationCode,
            });
            return;
        }

        // Send immediate response to EventGrid
        res.status(202).send();

        const maxRetries = 3;
        let retryCount = 0;
        let success = false;

        while (!success && retryCount < maxRetries) {
            try {
                callerId = eventData.from.rawId;
                const uuid = uuidv4();
                const callbackUri = `${process.env.CALLBACK_URI}/api/callbacks/${uuid}?callerId=${callerId}`;
                const incomingCallContext = eventData.incomingCallContext;
                const websocketUrl = process.env.CALLBACK_URI.replace(/^https:\/\//, 'wss://') + '/ws';
                const mediaStreamingOptions: MediaStreamingOptions = {
                    transportUrl: websocketUrl,
                    transportType: "websocket",
                    contentType: "audio",
                    audioChannelType: "unmixed",
                    startMediaStreaming: true,
                    enableBidirectional: true,
                    audioFormat: "Pcm24KMono"
                };

                const answerCallOptions: AnswerCallOptions = {
                    mediaStreamingOptions: mediaStreamingOptions
                };

                answerCallResult = await acsClient.answerCall(
                    incomingCallContext,
                    callbackUri,
                    answerCallOptions
                );
                success = true;
                console.log(`Answer call ConnectionId:--> ${answerCallResult.callConnectionProperties.callConnectionId}`);
            } catch (error) {
                if (error.message?.includes("IDX23010")) {
                    retryCount++;
                    await createAcsClient();
                    // Add delay between retries
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    throw error;
                }
            }
        }

        if (!success) {
            throw new Error("Max retries exceeded for answering call");
        }
    } catch (error) {
        console.error("Error during the incoming call event.", error);
    }
});

app.post('/api/callbacks/:contextId', async (req: any, res: any) => {
    const event = req.body[0];
    const eventData = event.data;
    const callConnectionId = eventData.callConnectionId;
    console.log(`Received Event:-> ${event.type}, Correlation Id:-> ${eventData.correlationId}, CallConnectionId:-> ${callConnectionId}`);
    
    if (event.type === "Microsoft.Communication.CallConnected") {
        const callConnectionProperties = await acsClient.getCallConnection(callConnectionId).getCallConnectionProperties();
        const mediaStreamingSubscription = callConnectionProperties.mediaStreamingSubscription;
        console.log("MediaStreamingSubscription:-->" + JSON.stringify(mediaStreamingSubscription));
    }
    res.status(200).send();
});

app.get('/', (req, res) => {
    res.send('Hello ACS CallAutomation!');
});

// Attach RTMiddleTier to the server
rtMiddleTier.attachToServer(server, '/ws');

// Start the server
server.listen(PORT, async () => {
    console.log(`Server is listening on port ${PORT}`);
    await createAcsClient();
});
