import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Inline name field: Enter saves, Esc or leaving it cancels. Empty or unchanged saves nothing. */
export function NameEditor({ value, onSave, onCancel, className }: { value: string; onSave: (name: string) => void; onCancel: () => void; className?: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(text);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      value={text}
      maxLength={80}
      spellCheck={false}
      aria-label="New name"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        // Keep the keys here: not the sidebar's drag handle, not the app's shortcuts.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(false)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "min-w-0 flex-1 rounded-md border border-brand-500 bg-canvas px-1.5 py-0.5 font-semibold text-ink outline-none ring-2 ring-brand-500/25",
        className,
      )}
    />
  );
}
