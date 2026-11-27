"use client";

import { useEffect } from "react";

// Keyboard form filling (owner): in every form, Enter moves to the next box, and on the last box
// to the form's Save / Submit button (Enter there saves). → at the end of a box's text and ← at
// its start move to the next / previous box; inside the text the arrows move the cursor as usual.
//
// Left alone, on purpose:
// - anything whose own key handler already acted (e.preventDefault()), e.g. the counter's scan box;
// - textareas (Enter is a new line), buttons and links (Enter clicks), date/time and number boxes'
//   arrows (they change the value), radio buttons' arrows (they pick within the group);
// - search boxes and forms with a single box (Enter searches / submits at once);
// - anything inside [data-kbd="off"].
// A page's main button outside a <form> can be marked data-kbd-submit to be the "end" stop.

const FIELD = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]), select, textarea';
// Inside a closed <details> (e.g. "More details") a box still has a size in Chrome but can't take focus.
const visible = (el: HTMLElement) =>
  !el.closest("details:not([open])") &&
  (typeof el.checkVisibility === "function"
    ? el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
    : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
const usable = (el: HTMLElement) =>
  visible(el) && !(el as HTMLInputElement).disabled && !(el as HTMLInputElement).readOnly && el.tabIndex !== -1 && !el.closest('[data-kbd="off"]');

function scopeOf(el: HTMLElement): HTMLElement {
  return (el.closest("form, [data-kbd-scope]") as HTMLElement | null) ?? (el.closest("main") as HTMLElement | null) ?? document.body;
}
function fieldsIn(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FIELD)].filter(usable);
}
function submitOf(scope: HTMLElement): HTMLElement | null {
  const marked = scope.querySelector<HTMLElement>("[data-kbd-submit]");
  if (marked && usable(marked)) return marked;
  if (scope instanceof HTMLFormElement) {
    const btn = [...scope.querySelectorAll<HTMLElement>('button[type="submit"], button:not([type]), input[type="submit"]')].filter(usable).pop();
    if (btn) return btn;
  }
  return null;
}
function caretAt(el: HTMLInputElement, where: "start" | "end"): boolean {
  try {
    const s = el.selectionStart, e = el.selectionEnd;
    if (s === null || e === null) return false;          // types without a caret: leave the arrows alone
    if (s !== e) return false;                            // text selected: arrows act on it
    return where === "start" ? s === 0 : e === el.value.length;
  } catch { return false; }
}

export function KeyboardNav() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "Enter" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const el = e.target as HTMLElement | null;
      if (!el || !(el.matches?.(FIELD)) || el.closest('[data-kbd="off"]')) return;
      const tag = el.tagName, type = ((el as HTMLInputElement).type ?? "").toLowerCase();
      if (tag === "TEXTAREA") return;
      if (el.getAttribute("role") === "combobox" && el.getAttribute("aria-expanded") === "true") return;

      const scope = scopeOf(el);
      const fields = fieldsIn(scope);
      const i = fields.indexOf(el);
      if (i < 0) return;

      if (e.key === "Enter") {
        if (type === "search" || fields.length < 2) return;   // one-box forms and search boxes submit as usual
        e.preventDefault();
        // the next box that really takes focus; past the last one, the Save / Submit button
        for (const next of fields.slice(i + 1)) {
          next.focus();
          if (document.activeElement === next) {
            if (next instanceof HTMLInputElement && /^(text|tel|email|password|search|url|)$/.test(next.type)) next.select();
            return;
          }
        }
        submitOf(scope)?.focus();
        return;
      }

      // ← / →: between boxes only at the edge of the text (or on boxes without text)
      if (type === "radio" || /^(date|time|datetime-local|month|week|number|range)$/.test(type)) return;
      const forward = e.key === "ArrowRight";
      if (tag === "INPUT" && !/^(checkbox)$/.test(type) && !caretAt(el as HTMLInputElement, forward ? "end" : "start")) return;
      const to = fields[forward ? i + 1 : i - 1] ?? (forward ? submitOf(scope) : null);
      if (!to) return;
      e.preventDefault();
      to.focus();
    };
    window.addEventListener("keydown", onKey);   // after React's own handlers, which run on the document
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
