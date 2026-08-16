import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** PWA retired (owner 2026-08-16).  Use the native iOS app or the website at /console
 *  (desktop and phone widths).  Do not add features here. */
export default function MobilePage() {
  redirect("/console");
}
