import { z } from "zod";

export const rationalSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const slowSpeedSchema = z.union([
  z.literal(0.5),
  z.literal(0.25),
  z.literal(0.125),
]);

export const slowSectionSchema = z.object({
  id: z.string().min(1),
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  speed: slowSpeedSchema,
  rampInFrames: z.number().int().nonnegative(),
  rampOutFrames: z.number().int().nonnegative(),
});

export const highlightRangeSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
});

export const audioSettingsSchema = z.object({
  useOriginalAudio: z.boolean().default(true),
  sourceGainDb: z.number().min(-60).max(6),
  crowdGainDb: z.number().min(-60).max(0),
  crowdMuted: z.boolean(),
  crowdSource: z.enum(["bundled", "custom"]),
});

export const sourceMetadataSchema = z.object({
  originalName: z.string(),
  storedName: z.string(),
  sha256: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  fps: rationalSchema,
  frameCount: z.number().int().positive(),
  hasAudio: z.boolean(),
  interlaced: z.boolean(),
  variableFrameRate: z.boolean(),
});

export const artifactSchema = z.object({
  revision: z.number().int().nonnegative(),
  filename: z.string(),
  createdAt: z.string(),
  durationSeconds: z.number().nonnegative(),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["importing", "ready", "error"]),
  error: z.string().optional(),
  source: sourceMetadataSchema,
  highlightRange: highlightRangeSchema.optional(),
  sections: z.array(slowSectionSchema),
  audio: audioSettingsSchema,
  proxyFilename: z.string().optional(),
  waveformFilename: z.string().optional(),
  preview: artifactSchema.optional(),
  export: artifactSchema.optional(),
  integration: z.object({
    provider: z.enum(["remote-workspace-files", "remote-file-browser"]),
    key: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});

export const projectPatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().min(1).max(120).optional(),
  highlightRange: highlightRangeSchema.optional(),
  sections: z.array(slowSectionSchema).optional(),
  audio: audioSettingsSchema.optional(),
});

export const renderRequestSchema = z.object({
  kind: z.enum(["preview", "export"]),
  expectedRevision: z.number().int().nonnegative(),
});

export type Rational = z.infer<typeof rationalSchema>;
export type SlowSpeed = z.infer<typeof slowSpeedSchema>;
export type SlowSection = z.infer<typeof slowSectionSchema>;
export type HighlightRange = z.infer<typeof highlightRangeSchema>;
export type AudioSettings = z.infer<typeof audioSettingsSchema>;
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectPatch = z.infer<typeof projectPatchSchema>;
export type RenderKind = z.infer<typeof renderRequestSchema>["kind"];

export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RenderJob {
  id: string;
  projectId: string;
  projectRevision: number;
  kind: RenderKind;
  status: RenderJobStatus;
  progress: number;
  createdAt: string;
  error?: string;
  artifactUrl?: string;
}
