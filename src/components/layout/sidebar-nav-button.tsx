"use client"

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

import { LabelWithHint } from "@/components/layout/label-with-hint"

/**
 * A fixed top-of-sidebar action / route row. `active` marks the row as the
 * current workbench route (selected styling); `trailing` carries a shortcut hint
 * or a count badge. Extracting this keeps every fixed nav item — and any future
 * route — on one geometry instead of copy-pasting the className. Each row is a
 * `group` so a `group-hover`-revealed trailing element works.
 */
export function SidebarNavButton({
  icon: Icon,
  label,
  onClick,
  active,
  hint,
  trailing,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  /** Small text after the label: what the page holds. */
  hint?: string
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-[0.4375rem] rounded-full pl-[0.4375rem] pr-1.5",
        "text-[0.875rem] text-sidebar-foreground outline-none",
        "transition-colors duration-150 hover:bg-sidebar-accent",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active && "bg-sidebar-primary/8"
      )}
    >
      <Icon className="h-[0.875rem] w-[0.875rem] shrink-0 text-muted-foreground" />
      {hint ? (
        <LabelWithHint label={label} hint={hint} />
      ) : (
        <span className="truncate">{label}</span>
      )}
      {trailing}
    </button>
  )
}
