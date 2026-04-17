import type { SiteType } from "../types";
import { isAshbyJobUrl } from "./ashby";
import { isGreenhouseJobUrl } from "./greenhouse";
import { isWorkdayJobUrl } from "./workday";

/**
 * Detect which supported ATS module should handle a job URL.
 * Order matters when multiple patterns could match (rare); Greenhouse first for explicit boards hosts.
 */
export function detectAtsSiteFromUrl(url: string): SiteType {
  if (isGreenhouseJobUrl(url)) return "greenhouse";
  if (isWorkdayJobUrl(url)) return "workday";
  if (isAshbyJobUrl(url)) return "ashby";
  return "unknown";
}
