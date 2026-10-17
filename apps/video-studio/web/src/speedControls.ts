import { slowSpeedSchema } from "@remote-workspace/video-shared";

export function parseSpeedDraft(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = slowSpeedSchema.safeParse(Number(value));
  return parsed.success ? parsed.data : undefined;
}
