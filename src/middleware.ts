// middleware.ts
import { Application } from 'express';
import { RTMiddleTier } from './RTMiddleTier';

export function setupWebSocketMiddleware(
  app: Application,
  rtMiddleTier: RTMiddleTier,
  path: string
) {
  rtMiddleTier.attachToServer(app, path);
}