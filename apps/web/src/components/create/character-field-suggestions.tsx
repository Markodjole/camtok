"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  placeholder?: string;
  disabled?: boolean;
  suggestions: string[];
  /** Shown above the suggestion list (e.g. "Settings tailored for Nina") */
  suggestionsTitle: string;
  /** When focused but `suggestions` is empty, show this hint (e.g. pick location first). */
  emptyMessage?: string;
  multiline?: boolean;
  rows?: number;
  textAreaClassName?: string;
};

export function CharacterFieldWithSuggestions({
  id,
  label,
  hint,
  value,
  onChange,
  maxLength,
  placeholder,
  disabled,
  suggestions,
  suggestionsTitle,
  emptyMessage,
  multiline,
  rows = 4,
  textAreaClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  const hasSuggestions = suggestions.length > 0;
  const showPanel = hasSuggestions || !!emptyMessage;

  const cancelBlurClose = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelBlurClose();
    blurTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const handlePick = (text: string) => {
    const next = text.slice(0, maxLength);
    onChange(next);
    setOpen(false);
  };

  const sharedInputClasses =
    "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {hint}
      <div className="relative">
        {multiline ? (
          <textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            maxLength={maxLength}
            disabled={disabled}
            rows={rows}
            placeholder={placeholder}
            onFocus={() => {
              cancelBlurClose();
              if (showPanel) setOpen(true);
            }}
            onBlur={scheduleClose}
            className={cn(
              sharedInputClasses,
              "resize-y min-h-[72px]",
              textAreaClassName,
            )}
          />
        ) : (
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            maxLength={maxLength}
            disabled={disabled}
            placeholder={placeholder}
            onFocus={() => {
              cancelBlurClose();
              if (showPanel) setOpen(true);
            }}
            onBlur={scheduleClose}
          />
        )}

        {open && showPanel && !disabled ? (
          <div
            className="absolute left-0 right-0 top-full z-[80] mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
            onMouseDown={cancelBlurClose}
          >
            <p className="border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium text-muted-foreground">
              {suggestionsTitle}
            </p>
            {hasSuggestions ? (
              <ScrollArea className="h-[min(14rem,40vh)]">
                <ul className="p-1.5" role="listbox">
                  {suggestions.map((s, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        role="option"
                        title={s}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handlePick(s);
                        }}
                        className="w-full rounded-md px-2.5 py-2 text-left text-xs leading-snug text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="line-clamp-4">{s}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            ) : (
              <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">{emptyMessage}</p>
            )}
          </div>
        ) : null}
      </div>
      <p
        className={cn(
          "text-xs text-right",
          value.length > maxLength * 0.9
            ? "text-amber-600 dark:text-amber-500"
            : "text-muted-foreground",
        )}
      >
        {value.length}/{maxLength}
      </p>
    </div>
  );
}
