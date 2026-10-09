import { closestCenter, DndContext, KeyboardCode, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AltArrowDownLinearIcon } from "@solar-icons/react";
import type { ReactNode } from "react";
import { popupMenu } from "@/lib/menu";
import { reorderVisible } from "@/lib/order";
import { cn } from "@/lib/utils";

export type BlockDef = {
  id: string;
  title: string;
  /** Shown beside the title, collapsed or not (a count, done/total). */
  aside?: ReactNode;
  icon?: ReactNode;
  /** Up next is the user's own queue: tinted so it never reads as Claude's plan. */
  tone?: "brand";
  /** Takes the height left over when expanded (the prompt index). */
  grow?: boolean;
  /** Folded until the person decides otherwise. */
  defaultCollapsed?: boolean;
  body: ReactNode;
};

type Props = {
  blocks: BlockDef[];
  /** The saved order, ids of blocks not shown now included so they keep their place. */
  order?: string[];
  collapsed?: Record<string, boolean>;
  onCollapse: (id: string, collapsed: boolean) => void;
  onOrder: (order: string[]) => void;
  onReset: () => void;
};

/** The inspector's blocks: each folds to its header and moves by dragging that header. */
export function BlockStack({ blocks, order = [], collapsed = {}, onCollapse, onOrder, onReset }: Props) {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Saved order first; blocks it does not know yet go last, in their default order.
  const shown = [...blocks].sort((a, b) => rank(a.id) - rank(b.id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space] } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = shown.map((b) => b.id);
    const moved = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    const full = [...order, ...ids.filter((id) => !order.includes(id))];
    onOrder(reorderVisible(full, moved));
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    popupMenu([{ id: "inspector:reset-layout", text: "Reset Layout", action: onReset }]);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
      <SortableContext items={shown.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-1">
          {shown.map((b) => {
            const folded = collapsed[b.id] ?? !!b.defaultCollapsed;
            return <Block key={b.id} block={b} collapsed={folded} onToggle={() => onCollapse(b.id, !folded)} onMenu={menu} />;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function Block({ block: b, collapsed, onToggle, onMenu }: { block: BlockDef; collapsed: boolean; onToggle: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: b.id });
  const grows = b.grow && !collapsed;
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex flex-col rounded-xl border shadow-sm backdrop-blur",
        b.tone === "brand" ? "border-brand-500/25 bg-brand-500/[0.045]" : "border-line bg-canvas/70",
        // The index keeps a usable height however much the other blocks take.
        grows ? "min-h-[260px] flex-1" : "shrink-0",
        isDragging && "z-10 shadow-lg ring-1 ring-brand-500/40",
      )}
    >
      {/* The header folds the block on a click and moves it on a drag (Space to pick up with the keyboard). */}
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          listeners?.onKeyDown?.(e);
          if (e.key === "Enter") onToggle();
        }}
        onContextMenu={onMenu}
        className="flex cursor-grab items-center gap-2 px-3 py-2.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-brand-500 active:cursor-grabbing"
      >
        {b.icon}
        <h3 className={cn("text-[11px] font-semibold uppercase tracking-[0.08em]", b.tone === "brand" ? "text-brand-700 dark:text-brand-300" : "text-ink-3")}>{b.title}</h3>
        {b.aside !== undefined && b.aside !== null && b.aside !== "" && <span className="text-[11px] text-ink-3 tabular">{b.aside}</span>}
        <AltArrowDownLinearIcon size={14} className={cn("ml-auto text-ink-3 transition-transform duration-200", !collapsed && "rotate-180")} />
      </div>
      {!collapsed && <div className={cn("min-h-0", grows ? "flex flex-1 flex-col" : "max-h-72 overflow-y-auto")}>{b.body}</div>}
    </section>
  );
}
