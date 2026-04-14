export const COVER_LETTER_TONES = [
  "professional",
  "warm",
  "confident",
  "concise",
  "formal",
] as const;

export type CoverLetterTone = (typeof COVER_LETTER_TONES)[number];

export const COVER_LETTER_TONE_LABELS: Record<CoverLetterTone, string> = {
  professional: "Professional (balanced)",
  warm: "Warm & personable",
  confident: "Confident & outcomes-focused",
  concise: "Concise & direct",
  formal: "Formal & traditional",
};

export function isCoverLetterTone(value: string | null | undefined): value is CoverLetterTone {
  return value != null && (COVER_LETTER_TONES as readonly string[]).includes(value);
}

export const DEFAULT_COVER_LETTER_TONE: CoverLetterTone = "professional";
