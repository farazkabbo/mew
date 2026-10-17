import { create } from "zustand";

/** "off": never started this session; "muted": the student turned listening off. */
export type VoiceStatus = "off" | "muted" | "connecting" | "listening" | "error";

export type Segment = { id: number; text: string; at: number };

const MAX_SEGMENTS = 50;

type VoiceState = {
  status: VoiceStatus;
  error: string | null;
  /** In-progress (unstable) transcript of the current utterance. */
  partial: string;
  /** Finished utterances, oldest first. */
  segments: Segment[];
  /** Smoothed microphone level, 0–1. */
  level: number;
};

type VoiceActions = {
  setStatus(status: VoiceStatus, error?: string | null): void;
  setPartial(text: string): void;
  commit(text: string): Segment;
  setLevel(level: number): void;
};

let nextId = 1;

export const useVoice = create<VoiceState & VoiceActions>()((set, get) => ({
  status: "off",
  error: null,
  partial: "",
  segments: [],
  level: 0,
  setStatus: (status, error = null) =>
    set({ status, error, ...(status !== "listening" && { partial: "", level: 0 }) }),
  setPartial: (partial) => set({ partial }),
  commit: (text) => {
    const segment = { id: nextId++, text, at: Date.now() };
    set({ partial: "", segments: [...get().segments, segment].slice(-MAX_SEGMENTS) });
    return segment;
  },
  setLevel: (level) => set({ level: get().level * 0.6 + level * 0.4 }),
}));
