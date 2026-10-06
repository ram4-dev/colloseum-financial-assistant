import {
  DataPacket_Kind,
  RoomServiceClient,
} from "livekit-server-sdk";

import type { OutboxInvalidation } from "./outbox-dispatcher.js";

export type LiveKitDataPublisher = Pick<RoomServiceClient, "sendData">;

export function createLiveKitInvalidationPublisher(
  client: LiveKitDataPublisher,
): (event: OutboxInvalidation) => Promise<void> {
  return async (event) => {
    await client.sendData(
      `nani-${event.conversationId}`,
      new TextEncoder().encode(JSON.stringify(event)),
      DataPacket_Kind.RELIABLE,
      { topic: "conversation_state_changed" },
    );
  };
}

/** Return no publisher when LiveKit is not configured; feed polling remains authoritative. */
export function createOptionalLiveKitInvalidationPublisher(
  environment: NodeJS.ProcessEnv = process.env,
): ((event: OutboxInvalidation) => Promise<void>) | undefined {
  const url = environment.LIVEKIT_URL?.trim();
  const apiKey = environment.LIVEKIT_API_KEY?.trim();
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return undefined;

  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  return createLiveKitInvalidationPublisher(client);
}
