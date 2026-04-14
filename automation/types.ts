export type BlockerKind = "login" | "captcha" | "unknown_site";

export type RunStatus =
  | { kind: "blocked"; blocker: BlockerKind; detail: string }
  | { kind: "filled"; submitted: boolean; message?: string }
  | { kind: "error"; message: string };

export type ApplicantPayload = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  /** Local file path for resume upload when the board exposes a file input */
  resume_path?: string;
};

export type ArtifactPaths = {
  runDir: string;
  metaPath: string;
  payloadPath: string;
  screenshotPath: string;
};
