// app.ts
import { config } from 'dotenv';
import express, { Application } from 'express';
import http from 'http';
import { RTMiddleTier } from './RTMiddleTier';
import { setupWebSocketMiddleware } from './middleware';
import { AzureKeyCredential } from '@azure/core-auth';

config();

const app: Application = express();
const server = http.createServer(app);

// Configure RTMiddleTier
const rtMiddleTier = new RTMiddleTier({
  endpoint: process.env.AZURE_OPENAI_SERVICE_ENDPOINT!,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME!,
  credentials: new AzureKeyCredential(process.env.AZURE_OPENAI_SERVICE_KEY!),
  voiceChoice: process.env.VOICE_CHOICE ?? 'alloy',
});

// Attach RTMiddleTier to the server directly instead of using middleware
rtMiddleTier.attachToServer(server, '/ws');

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
