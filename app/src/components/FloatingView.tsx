import { MinimizeSquare3LinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useAdmiral } from "@/lib/admiral";
import { useSeen } from "@/lib/artifacts";
import { useCostReport, useCosts, type RangeDays } from "@/lib/costs";
import { useSidebarOrder } from "@/lib/order";
import type { Agent, AdmiralSession } from "@/lib/types";
import { useUnderway, UnderwayContext } from "@/lib/underway";
import { setProjectOrder } from "@/lib/utils";
import { AgentsMap } from "./AgentsMap";
import { ArtifactsGallery } from "./ArtifactsPane";
import { CostsView } from "./CostsView";
import { DelegationsView } from "./DelegationsView";
import { Notices } from "./Overlays";
import { QueueView } from "./QueueView";
import { Tip, TipLabel, TooltipProvider } from "./Tooltip";
import { useLifecycle } from "@/lib/lifecycle";

export type FloatableView = "agents" | "delegations" | "queue" | "costs" | "artifacts";

export const VIEW_TITLE: Record<FloatableView, string> = { agents: "Agents", delegations: "Delegations", queue: "Up next", costs: "Costs", artifacts: "Artifacts" };

/** The label of a view's floating window, in the same list as the agents'. */
export const viewFloatId = (view: FloatableView) => `view-${view}`;

// An agent picked in a floating view opens in the main window.
const jump = (id: string) => void invoke("float_jump", { sessionId: id });

/** Mounted only for Costs: its report is the one expensive read here. */
function Costs({ agents, rateLimits, now }: { agents: Agent[]; rateLimits: NonNullable<AdmiralSession["rateLimits"]>; now: number }) {
  const report = useCostReport();
  const [range, setRange] = useState<RangeDays>(30);
  const costs = useCosts(report.report, agents, range);
  return <CostsView costs={costs} range={range} onRange={setRange} fetchedAt={report.report?.fetchedAt} loading={report.loading} error={report.error} onRefresh={report.refresh} agents={agents} rateLimits={rateLimits} now={now} onJump={jump} />;
}

/** A floating window with one of the app's views: Delegations, Costs… */
export function FloatingView({ view }: { view: FloatableView }) {
  const { agents, delegations, rateLimits, now, cliReady, queues, artifacts, loaded } = useAdmiral({ quiet: true });
  const life = useLifecycle(agents);
  const underway = useUnderway();
  const seen = useSeen(artifacts, loaded);
  const order = useSidebarOrder(agents, cliReady, { readOnly: true });
  setProjectOrder(order.groups.map((g) => g.label));
  useEffect(() => {
    invoke("frontend_log", { level: "float", message: `floating window showing ${view}` }).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.altKey && !e.shiftKey && e.key === "w") {
        e.preventDefault();
        void invoke("float_close");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view]);
  const onError = (m: string) => life.notify(m, "error");
  return (
    <UnderwayContext.Provider value={underway}>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-panel">
          {/* The title bar: traffic lights at its left, and something to drag the window by. */}
          <div data-tauri-drag-region className="flex h-[38px] shrink-0 items-center justify-end border-b border-line px-2">
            <Tip side="bottom" content={<TipLabel label="Back to the main window" />}>
              <button aria-label="Back to the main window" onClick={() => void invoke("float_dock")} className="inline-flex size-7 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-line hover:text-ink">
                <MinimizeSquare3LinearIcon size={16} />
              </button>
            </Tip>
          </div>
          <div className="relative min-h-0 flex-1">
            {view === "artifacts" ? (
              <ArtifactsGallery artifacts={artifacts} agents={agents} now={now} isUnseen={seen.isUnseen} markSeen={seen.markSeen} onError={onError} onClaudeLink={(href) => invoke("browser_open", { url: href }).catch((e) => onError(String(e)))} />
            ) : view === "costs" ? (
              <Costs agents={agents} rateLimits={rateLimits} now={now} />
            ) : view === "agents" ? (
              <AgentsMap tree={order.spaces.tree} agents={agents} queues={queues} onJump={jump} />
            ) : view === "queue" ? (
              <QueueView queues={queues} agents={agents} delegations={delegations} now={now} onJump={jump} onError={onError} />
            ) : (
              <DelegationsView delegations={delegations} agents={agents} now={now} onJump={jump} queues={queues} />
            )}
          </div>
        </div>
        <Notices notices={life.notices} />
      </TooltipProvider>
    </UnderwayContext.Provider>
  );
}
