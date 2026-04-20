export type BlockerKind = "login" | "captcha" | "two_factor" | "multi_step_flow" | "unknown_site";

export type SiteType = "greenhouse" | "workday" | "ashby" | "unknown";

export type RunStatus =
  | { kind: "blocked"; blocker: BlockerKind; detail: string }
  | {
      kind: "filled";
      submitted: false;
      readyForUserReview: boolean;
      message?: string;
    }
  /** Spec auto-detected a submission confirmation page/message in the live browser. */
  | { kind: "submitted"; submitted: true; message?: string }
  /** Runner cannot continue until the user completes verification in a live browser (see human-handoff artifact). */
  | { kind: "waiting_for_human_action"; detail: string }
  | { kind: "error"; message: string };

export type ApplicantPayload = {
  first_name?: string;
  middle_name?: string;
  preferred_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  location?: string;
  work_authorization?: string;
  salary_expectations?: string;
  /** Local file path for resume upload when the board exposes a file input */
  resume_path?: string;
  /** Local file path for cover letter upload when the board exposes a file input */
  cover_letter_path?: string;
};

export type ArtifactPaths = {
  runDir: string;
  metaPath: string;
  payloadPath: string;
  runLogPath: string;
  screenshotBeforePath: string;
  screenshotAfterPath: string;
  domSnapshotPath: string;
  fieldMappingsPath: string;
  humanHandoffPath: string;
};
