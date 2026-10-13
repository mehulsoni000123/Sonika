// Structured-output schema Claude fills when planning or revising an edit.
// Kept separate from the internal timeline schema so prompts stay small and
// the model never has to emit ids or derived fields.
import { z } from "zod";
import { TEXT_PRESETS, POSITIONS, TRANSITIONS } from "../timeline.js";

export const PlanSchema = z.object({
  summary: z.string().describe("Two or three sentences for the editor: the story of the cut and the key choices made."),
  video: z
    .array(
      z.object({
        mediaId: z.string().describe("id of a video or image from the media bin"),
        in: z.number().describe("source start time in seconds (0 for images)"),
        duration: z.number().describe("how long this clip plays on the timeline, in seconds"),
        speed: z.number().describe("playback speed, 1 = normal. Use 1 unless a speed ramp is clearly wanted."),
        transitionIn: z.enum(TRANSITIONS).describe("how this clip enters from the previous one"),
        transitionDuration: z.number().describe("seconds, 0.3-1.0; ignored for cut"),
        muted: z.boolean().describe("true to drop the clip's own audio (e.g. b-roll under a voice clip)"),
        kenBurns: z.boolean().describe("slow zoom, images only"),
        label: z.string().describe("short note on why this shot is here"),
      }),
    )
    .describe("The base video track, in play order. Clips are placed back to back."),
  text: z
    .array(
      z.object({
        text: z.string().describe("the on-screen words; keep it short, use a newline for a second line"),
        start: z.number().describe("timeline seconds"),
        duration: z.number(),
        preset: z.enum(TEXT_PRESETS),
        position: z.enum(POSITIONS),
      }),
    )
    .describe("Titles, hooks, lower thirds, captions. Times are on the final timeline."),
  music: z
    .array(
      z.object({
        mediaId: z.string().describe("id of an audio file from the bin"),
        start: z.number(),
        duration: z.number(),
        in: z.number(),
        volume: z.number().describe("0.1-0.3 under dialogue, 0.6-1.0 when it carries the video"),
      }),
    )
    .describe("Music or voice-over bed. Empty when no audio files were provided."),
});
