import { describe, expect, it, vi } from "vitest";
import { DataPacket_Kind } from "livekit-server-sdk";

import {
  createLiveKitInvalidationPublisher,
  createOptionalLiveKitInvalidationPublisher,
} from "../../../src/notifications/livekit-invalidation-publisher.js";

describe("LiveKit notification invalidation publisher", () => {
  it("uses the conversation room, reliable delivery and the existing topic", async () => {
    const sendData = vi.fn().mockResolvedValue(undefined);
    const publish = createLiveKitInvalidationPublisher({ sendData });
    const event = {
      type: "conversation_state_changed" as const,
      conversationId: "conversation-1",
      revision: 7,
    };

    await publish(event);

    const [room, payload, kind, options] = sendData.mock.calls[0] ?? [];
    expect(room).toBe("nani-conversation-1");
    expect(new TextDecoder().decode(payload)).toBe(JSON.stringify(event));
    expect(kind).toBe(DataPacket_Kind.RELIABLE);
    expect(options).toEqual({ topic: "conversation_state_changed" });
  });

  it("does not create a publisher without all LiveKit credentials", () => {
    expect(createOptionalLiveKitInvalidationPublisher({})).toBeUndefined();
    expect(
      createOptionalLiveKitInvalidationPublisher({
        LIVEKIT_URL: "ws://livekit:7880",
        LIVEKIT_API_KEY: "test-key",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
