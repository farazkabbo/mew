import { describe, expect, it, vi } from "vitest";

import { MomentMoves } from "./outbox";

const CLIP = "66666666-6666-4666-8666-000000000001";
const A = "00000000-0000-4000-8000-000000000013";
const B = "00000000-0000-4000-8000-000000000015";

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("moments filed offline (K8)", () => {
  it("keeps a move the server didn't get, the latest one only, and sends it later", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const moves = new MomentMoves(send, memory());
    expect(await moves.moved(CLIP, A)).toBe(false);
    expect(await moves.moved(CLIP, B)).toBe(false);
    expect(moves.pending()).toEqual([{ clipId: CLIP, nodeId: B }]);

    send.mockResolvedValue(undefined);
    await moves.flush();
    expect(send).toHaveBeenLastCalledWith(CLIP, B);
    expect(moves.pending()).toEqual([]);
  });
});
