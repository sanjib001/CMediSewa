"use client";

import { useEffect } from "react";
import { markSvg } from "@/lib/pwa/mark";

/**
 * Installed app only (owner: "logo while loading, same as HRestroSewa"). The phone's own launch
 * screen (launch images on iOS, the manifest on Android) shows the logo until the first page is
 * drawn; this keeps the same logo up, with a small spinner, while the app fetches its first
 * screen, then fades into it. Once per launch (sessionStorage), never in a browser tab
 * (CSS: display-mode standalone), and CSS hides it after 8 s whatever happens.
 *
 * The inline script runs BEFORE the logo is parsed and before any paint: it marks the installed app
 * (html.cm-standalone: display-mode standalone, or iOS navigator.standalone) and a second load in
 * the same launch (html.cm-launched), so the logo never flashes in a tab or on every reload.
 */
const BOOT = "try{var h=document.documentElement;if(matchMedia('(display-mode: standalone)').matches||navigator.standalone)h.classList.add('cm-standalone');if(sessionStorage.getItem('cm-launched'))h.classList.add('cm-launched')}catch(e){}";

export function LaunchScreen() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("cm-standalone") || root.classList.contains("cm-launched")) return;
    const shownFor = performance.now();
    const t = setTimeout(() => {
      root.classList.add("cm-launch-done");
      try { sessionStorage.setItem("cm-launched", "1"); } catch { /* private mode */ }
    }, Math.max(0, 600 - shownFor));
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      <div id="app-launch" className="app-launch" aria-hidden>
        <div className="flex flex-col items-center gap-5">
          <span className="block size-24" dangerouslySetInnerHTML={{ __html: markSvg(96) }} />
          <span className="text-[1.6rem] font-semibold tracking-[-0.01em] text-ink">CMediSewa</span>
          <span className="app-launch-spin mt-2 block size-6 rounded-full border-[3px] border-line border-t-pine" />
        </div>
      </div>
    </>
  );
}
