#!/usr/bin/env python3
"""Fake OpenAdmiral data for screenshots: a made-up team of sessions, delegations,
artifacts and queued prompts, written under <home>/openadmiral (see docs/CONTRACT.md).

    python3 app/scripts/demo-data.py /tmp/demo-home          # write once
    python3 app/scripts/demo-data.py /tmp/demo-home --keep   # keep heartbeats fresh

It also writes transcripts and a fake `claude` (bin/claude answers `agents --json`
with these sessions) so the app treats them as live. Run a preview instance with
that `claude` first on PATH; SHELL=bin/path keeps the login shell from replacing it:

    D=/tmp/demo-home; CLAUDE_CONFIG_DIR=$D PATH=$D/bin:$PATH SHELL=$D/bin/path \\
      OPENADMIRAL_PREVIEW=1 app/src-tauri/target/debug/openadmiral

Add OPENADMIRAL_SHOT=<file.png> to snapshot the window and quit (see shot.rs).
"""
import json
import os
import sys
import time

MIN = 60_000


def write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(value if isinstance(value, str) else json.dumps(value, indent=1))
    os.replace(tmp, path)


def sid(n):
    return f"{n:08x}-0000-4000-8000-{n:012x}"


def limits(now):
    iso = lambda ms: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
    return [
        {"kind": "five_hour", "percentUsed": 34, "resetsAt": iso(now + 166 * MIN)},
        {"kind": "seven_day", "percentUsed": 21, "resetsAt": iso(now + 4 * 24 * 60 * MIN)},
    ]
COMMANDS = ["clear", "compact", "context", "model", "rename", "status", "usage", "remote-control"]
QUEUE_COMMANDS = [
    {"name": n, "kind": "command"} for n in ["clear", "compact", "rename", "reload-plugins", "context"]
] + [{"name": n, "kind": "skill"} for n in ["code-review", "simplify", "security-review", "init"]]

# (id, name, project, branch, status, model, context %, cost, current prompt / last reply, extra)
SESSIONS = [
    (1, "checkout-redesign", "app", "feat/checkout-v2", "working", "claude-opus-5-5", 41, 6.82,
     "Rebuild the checkout as a single page with Apple Pay and saved addresses", {
         "lastTool": {"name": "Edit", "summary": "src/checkout/PaymentStep.tsx", "at": -0.2},
         "tasks": [
             {"id": "1", "subject": "Merge address and shipping steps", "status": "completed"},
             {"id": "2", "subject": "Add Apple Pay button", "status": "in_progress", "activeForm": "Adding Apple Pay button"},
             {"id": "3", "subject": "Saved addresses picker", "status": "pending"},
             {"id": "4", "subject": "Update e2e tests", "status": "pending"},
         ],
         "subagents": [{"id": "a1", "type": "Explore", "description": "Find every use of the old CartSummary", "status": "running", "startedAt": -1}],
         "dirty": 7,
     }),
    (2, "app-perf", "app", "perf/images", "idle", "claude-sonnet-5-5", 18, 1.94,
     "Product images now ship as AVIF with responsive sizes; LCP on /p/[slug] dropped from 3.1 s to 1.4 s.", {"dirty": 0}),
    (3, "orders-api", "api", "main", "waiting", "claude-opus-5-5", 63, 9.40,
     "Add idempotency keys to POST /orders", {
         "waiting": {"reason": "permission", "detail": "Bash: pnpm prisma migrate dev --name idempotency_keys", "since": -1.5},
         "lastTool": {"name": "Bash", "summary": "pnpm prisma migrate dev", "at": -1.5},
         "dirty": 4,
     }),
    (4, "rate-limits", "api", "feat/rate-limit", "working", "claude-sonnet-5-5", 27, 2.15,
     "Per-key rate limiting with a sliding window in Redis", {
         "lastTool": {"name": "Bash", "summary": "pnpm test src/middleware/rateLimit.test.ts", "at": -0.1},
         "worktree": True, "dirty": 3,
     }),
    (5, "payments-webhooks", "payments", "main", "idle", "claude-opus-5-5", 52, 4.71,
     "Stripe webhooks are verified and replayed from the dead-letter queue. PR #212 is open.", {"dirty": 0, "remote": {"enabled": True, "clients": 1}}),
    (6, "docs-refresh", "docs", "main", "waiting", "claude-haiku-5-5", 9, 0.38,
     "Rewrite the Getting started guide for the v3 SDK", {
         "waiting": {"reason": "question", "detail": "Should the Python examples use async or sync clients?", "since": -4},
         "dirty": 2,
     }),
    (7, "ios-release", "mobile", "release/4.2", "working", "claude-opus-5-5", 74, 12.30,
     "Prepare the 4.2 release: changelog, version bump, TestFlight build", {
         "lastTool": {"name": "Bash", "summary": "fastlane beta", "at": -0.4},
         "tasks": [
             {"id": "1", "subject": "Write changelog", "status": "completed"},
             {"id": "2", "subject": "Bump version to 4.2.0", "status": "completed"},
             {"id": "3", "subject": "Upload TestFlight build", "status": "in_progress", "activeForm": "Uploading to TestFlight"},
         ],
         "dirty": 1,
     }),
]


def sessions(now):
    out = []
    for n, name, project, branch, status, model, ctx, cost, text, extra in SESSIONS:
        s = {
            "v": 1, "sessionId": sid(n), "name": name, "cwd": f"/Users/demo/code/{project}", "project": project,
            "repo": {"root": f"/Users/demo/code/{project}", "remote": f"https://github.com/acme/{project}.git"},
            "branch": branch, "model": model, "status": status,
            "context": {"tokens": ctx * 2000, "window": 200_000, "percent": ctx, "usablePercent": min(100, round(ctx * 1.2))},
            "rateLimits": limits(now), "costUsd": cost, "commands": COMMANDS, "queueCommands": QUEUE_COMMANDS,
            "startedAt": now - (40 + n * 9) * MIN, "updatedAt": now,
        }
        for k, v in extra.items():
            s[k] = v
        for k in ("lastTool", "waiting"):
            if k in s:
                s[k] = {**s[k], ("at" if k == "lastTool" else "since"): now + int(s[k].get("at", s[k].get("since", 0)) * MIN)}
        for a in s.get("subagents", []):
            a["startedAt"] = now + a["startedAt"] * MIN
        if status == "working":
            s["turn"] = {"startedAt": now - (3 + n) * MIN, "prompt": text}
            s["activity"] = [
                {"at": now - (3 + n) * MIN, "kind": "prompt", "text": text},
                {"at": now - 2 * MIN, "kind": "tool", "text": "Read · package.json"},
                {"at": now - MIN, "kind": "tool", "text": f"{s['lastTool']['name']} · {s['lastTool']['summary']}"},
            ]
        elif status == "waiting":
            s["activity"] = [{"at": now - 6 * MIN, "kind": "prompt", "text": text}, {"at": now - 2 * MIN, "kind": "permission", "text": s["waiting"]["detail"]}]
            s["lastReply"] = "I need your go-ahead before continuing."
        else:
            s["lastReply"] = text
            s["activity"] = [{"at": now - 20 * MIN, "kind": "prompt", "text": "Go ahead"}, {"at": now - 12 * MIN, "kind": "reply", "text": text}]
        out.append(s)
    return out


def delegations(now):
    def d(i, title, frm, to, status, notes, mins, result=None, depends=None):
        x = {
            "v": 1, "id": f"dlg_demo{i:04d}", "title": title,
            "detail": f"{title}.\n\nAcceptance: tests pass and the change is documented. Report back the commit hash.",
            "from": {"sessionId": sid(frm), "project": SESSIONS[frm - 1][2], "name": SESSIONS[frm - 1][1]},
            "to": {"address": SESSIONS[to - 1][1], "sessionId": sid(to), "project": SESSIONS[to - 1][2]},
            "status": status,
            "notes": [{"at": now - (mins - j * 4) * MIN, "by": SESSIONS[to - 1][1], "status": st, "text": t} for j, (st, t) in enumerate(notes)],
            "createdAt": now - mins * MIN, "updatedAt": now - max(1, mins - 4 * len(notes)) * MIN,
        }
        if result:
            x["result"] = result
        if depends:
            x["dependsOn"] = depends
        return x

    return [
        d(1, "Expose an idempotent POST /orders for the new checkout", 1, 3, "in_progress",
          [("accepted", "On it"), ("in_progress", "Migration ready, waiting for approval to run it")], 25),
        d(2, "Return 429 with Retry-After from the public API", 3, 4, "done",
          [("accepted", "Accepted"), ("done", "Shipped behind a flag")], 26 * 60, result="commit 4e1d9b0 on main"),
        d(3, "Document the new checkout webhooks", 5, 6, "blocked",
          [("accepted", "Picked up"), ("blocked", "Need to know which SDK version the examples target")], 50),
        d(4, "Handle payment_intent.requires_action in the app", 5, 7, "done",
          [("accepted", "Accepted"), ("done", "Shipped in 4.2")], 90, result="commit 8f3c2a1 on release/4.2"),
        d(6, "Add a minimum app version endpoint", 7, 3, "sent", [], 3),
        d(5, "Lazy-load the product carousel", 1, 2, "done", [("accepted", "Accepted"), ("done", "Merged")], 30 * 60, result="PR #87 merged"),
    ]


ARCH = """flowchart LR
  web[App] -->|POST /orders| api[Orders API]
  api --> db[(Postgres)]
  api -->|enqueue| q[[Jobs]]
  q --> pay[Payments]
  pay -->|webhooks| api
  app[iOS app] --> api
"""

REPORT = """# Checkout v2: progress

**Goal:** one-page checkout, Apple Pay, saved addresses.

| Step | Status |
|---|---|
| Address + shipping merged | Done |
| Apple Pay | In progress |
| Saved addresses | Next |
| E2E tests | Next |

## Numbers so far

- Steps to pay: **4 → 1**
- Bundle size of `/checkout`: **182 kB → 121 kB**
- Lighthouse performance: **71 → 93**

## Open questions

1. Keep the guest checkout link above the fold?
2. Show saved cards before or after Apple Pay?
"""


def artifacts(home, now):
    for n, (aid, title, kind, file, body, note) in enumerate([
        ("checkout-v2-progress", "Checkout v2 progress", "markdown", "v2.md", REPORT, "Numbers after the AVIF change"),
        ("system-map", "System map", "mermaid", "v1.mmd", ARCH, "How the services talk to each other"),
    ]):
        base = f"{home}/openadmiral/artifacts/{sid(1)}/{aid}"
        versions = [{"n": i, "file": f"v{i}{file[2:]}", "createdAt": now - (30 - i * 10) * MIN, "note": note if i == int(file[1]) else "First draft"}
                    for i in range(1, int(file[1]) + 1)]
        for v in versions:
            write(f"{base}/{v['file']}", body)
        write(f"{base}/manifest.json", {"v": 1, "id": aid, "sessionId": sid(1), "project": "app", "title": title,
                                         "kind": kind, "versions": versions, "updatedAt": versions[-1]["createdAt"]})


def queues(home, now):
    write(f"{home}/openadmiral/queue/{sid(1)}.json", {"v": 1, "paused": False, "updatedAt": now, "items": [
        {"id": "q_demo0004", "text": "Run the e2e suite against staging and fix what broke overnight", "createdAt": now - 7 * MIN,
         "after": {"kind": "schedule", "time": "08:00", "days": [1, 2, 3, 4, 5]}, "armedAt": now - 7 * MIN},
        {"id": "q_demo0001", "text": "Wire the saved addresses picker to the new /orders endpoint", "createdAt": now - 9 * MIN,
         "after": {"kind": "delegation", "id": "dlg_demo0001", "status": ["done"]}},
    ]})
    write(f"{home}/openadmiral/queue/{sid(2)}.json", {"v": 1, "paused": False, "updatedAt": now, "items": [
        {"id": "q_demo0003", "text": "Run Lighthouse on the top 20 product pages and post the report", "createdAt": now - 60 * MIN,
         "after": {"kind": "schedule", "time": "08:30", "days": [1, 2, 3, 4, 5]}, "armedAt": now - 60 * MIN},
    ]})


# The checkout-redesign conversation: (minutes ago, prompt, source, [steps]); a step
# is a reply text or a tool call (name, input, result). The last turn is still running.
CHECKOUT = [
    (52, "Look at how checkout works today and propose a plan for a one-page checkout. Don't change code yet.", None, [
        ("Glob", {"pattern": "src/checkout/**/*.tsx"}, "src/checkout/CheckoutPage.tsx\nsrc/checkout/AddressStep.tsx\nsrc/checkout/ShippingStep.tsx\nsrc/checkout/PaymentStep.tsx\nsrc/checkout/ReviewStep.tsx"),
        ("Read", {"file_path": "/Users/demo/code/app/src/checkout/CheckoutPage.tsx"}, "214 lines"),
        ("Grep", {"pattern": "useCheckoutStep", "path": "src"}, "Found 9 files"),
        ("Read", {"file_path": "/Users/demo/code/app/src/api/orders.ts"}, "88 lines"),
        "Checkout today is a four-step wizard (address → shipping → payment → review), each step a route with its own data fetch. "
        "A one-page version fits in three moves:\n\n"
        "1. **Merge address and shipping** into one form; shipping rates refresh as the postcode changes.\n"
        "2. **Payment on the same page**, with Apple Pay first when the device supports it.\n"
        "3. **Saved addresses** for signed-in customers, picked from a list above the form.\n\n"
        "One dependency: placing the order must be idempotent, because Apple Pay can retry. "
        "`POST /orders` in the API is not today, so I'd ask the api session for that.",
    ]),
    (38, "Go ahead with 1 and 2. Keep the guest checkout. Ask the api session for the idempotent endpoint.", None, [
        ("TaskCreate", {"subject": "Merge address and shipping steps", "activeForm": "Merging address and shipping steps"}, "Task 1 created"),
        ("TaskCreate", {"subject": "Add Apple Pay button", "activeForm": "Adding Apple Pay button"}, "Task 2 created"),
        ("mcp__openadmiral__delegate", {"to": "orders-api", "title": "Expose an idempotent POST /orders for the new checkout"}, "Delegated as dlg_demo0001"),
        ("Write", {"file_path": "/Users/demo/code/app/src/checkout/DeliveryForm.tsx"}, "Created DeliveryForm.tsx (126 lines)"),
        ("Edit", {"file_path": "/Users/demo/code/app/src/checkout/CheckoutPage.tsx"}, "Updated with 41 additions and 87 removals"),
        ("Bash", {"command": "pnpm test src/checkout", "description": "Run the checkout tests"}, "✓ 23 passed (1.8s)"),
        "Address and shipping are one form now (`DeliveryForm`), and the wizard routes are gone. Guest checkout is untouched. "
        "I sent the idempotency work to **orders-api** and queued the saved-addresses step to run once it's done.",
    ]),
    (4, "Rebuild the checkout as a single page with Apple Pay and saved addresses", "queue", [
        ("Read", {"file_path": "/Users/demo/code/app/src/checkout/PaymentStep.tsx"}, "152 lines"),
        ("Edit", {"file_path": "/Users/demo/code/app/src/checkout/PaymentStep.tsx"}, "Updated with 18 additions and 4 removals"),
        ("Bash", {"command": "pnpm test src/checkout/PaymentStep.test.tsx", "description": "Run the payment tests"}, None),
    ]),
]


def transcripts(home, now):
    stamp = lambda m: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime((now - m * MIN) / 1000))
    for n, name, project, branch, status, model, ctx, cost, text, extra in SESSIONS:
        cwd = f"/Users/demo/code/{project}"
        base = {"sessionId": sid(n), "cwd": cwd, "gitBranch": branch, "version": "2.1.293", "isSidechain": False}
        if n == 1:
            turns = CHECKOUT
        else:
            prompt = text if status != "idle" else f"Next step for {name}"
            turns = [(20, prompt, None, ["I'll start by reading the code involved, then make the change and run the tests."] + ([text] if status == "idle" else []))]
        rows, k = [], 0
        for mins, prompt, source, steps in turns:
            origin = {"kind": "plugin", "name": "openadmiral", "asUser": True} if source == "queue" else {"kind": "human"}
            rows.append({**base, "type": "user", "uuid": f"u{n}-{k}", "timestamp": stamp(mins), "origin": origin, "message": {"role": "user", "content": prompt}})
            for j, step in enumerate(steps):
                k += 1
                at = stamp(mins - 0.4 * (j + 1))
                if isinstance(step, str):
                    rows.append({**base, "type": "assistant", "uuid": f"a{n}-{k}", "timestamp": at, "message": {"role": "assistant", "model": model, "content": [{"type": "text", "text": step}]}})
                    continue
                tool, args, result = step
                rows.append({**base, "type": "assistant", "uuid": f"a{n}-{k}", "timestamp": at, "message": {"role": "assistant", "model": model, "content": [
                    {"type": "tool_use", "id": f"t{n}-{k}", "name": tool, "input": args}]}})
                if result is not None:
                    extra_ = {"toolUseResult": {"task": {"id": result.split()[1], "subject": args.get("subject")}}} if tool == "TaskCreate" else {}
                    rows.append({**base, **extra_, "type": "user", "uuid": f"r{n}-{k}", "timestamp": at, "message": {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": f"t{n}-{k}", "content": result}]}})
        write(f"{home}/projects/{''.join(c if c.isalnum() else '-' for c in cwd)}/{sid(n)}.jsonl", "\n".join(json.dumps(r) for r in rows) + "\n")


def rgb(r, g, b):
    return f"\x1b[38;2;{r};{g};{b}m"


def screen(session_id):
    """What `claude attach` shows: Claude Code mid-turn, redrawn when the terminal resizes."""
    import signal
    signal.signal(signal.SIGWINCH, lambda *_: draw(session_id))
    draw(session_id)
    while True:
        signal.pause()


def draw(session_id):
    size = os.get_terminal_size()
    cols = max(60, min(size.columns, 140))
    o, w, g, gr, red, dim, bold, rs = rgb(215, 119, 87), rgb(255, 255, 255), rgb(153, 153, 153), rgb(78, 186, 101), rgb(255, 107, 128), "\x1b[2m", "\x1b[1m", "\x1b[0m"
    add, rem = "\x1b[48;2;2;40;0m", "\x1b[48;2;61;1;8m"
    name = next(s[1] for s in SESSIONS if sid(s[0]) == session_id)
    line = lambda s="": sys.stdout.write(s + rs + "\r\n")
    sys.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l")
    # The welcome banner has scrolled away by now; the diff gives way first on short terminals.
    line(f"{g}> {w}Rebuild the checkout as a single page with Apple Pay and saved addresses")
    line()
    line(f"{w}⏺{rs} I'll add Apple Pay to the payment section first, then the saved addresses picker.")
    line()
    line(f"{gr}⏺{rs} {bold}Read{rs}(src/checkout/PaymentStep.tsx)")
    line(f"  {g}⎿  Read {bold}152{rs}{g} lines")
    line()
    line(f"{gr}⏺{rs} {bold}Update{rs}(src/checkout/PaymentStep.tsx)")
    line(f"  {g}⎿  Updated {bold}src/checkout/PaymentStep.tsx{rs}{g} with {bold}18{rs}{g} additions and {bold}4{rs}{g} removals")
    diff = [
        (40, " ", "  const { total, currency } = useCart()"),
        (41, "-", "  return <CardForm total={total} />"),
        (41, "+", "  const applePay = useApplePay({ total, currency })"),
        (42, "+", "  return ("),
        (43, "+", "    <>"),
        (44, "+", "      {applePay.available && <ApplePayButton onPay={applePay.pay} />}"),
        (45, "+", "      <CardForm total={total} divider={applePay.available} />"),
        (46, "+", "    </>"),
        (47, "+", "  )"),
    ]
    for num, sign, code in diff[:max(2, size.lines - 25)]:
        bg = add if sign == "+" else rem if sign == "-" else ""
        text = f"      {num:>3} {sign} {code}"
        line(f"{bg}{w if sign != ' ' else g}{text.ljust(cols - 2)}")
    line()
    line(f"{gr}⏺{rs} {bold}Bash{rs}(pnpm test src/checkout/PaymentStep.test.tsx)")
    line(f"  {g}⎿  Running…")
    line()
    line(f"  {g}☒ {dim}Merge address and shipping steps")
    line(f"  {w}☐ {bold}Add Apple Pay button")
    line(f"  {g}☐ Saved addresses picker")
    line(f"  {g}☐ Update e2e tests")
    line()
    line(f"{o}✻ Adding Apple Pay button… {g}(4m 12s · ↓ 6.4k tokens · esc to interrupt)")
    line()
    line(f"{g}{'─' * (cols - 1)}")
    line(f"{g}> {rs}")
    line(f"{g}{'─' * (cols - 1)}")
    line(f"  {red}⏵⏵ auto mode on{rs}{g} (shift+tab to cycle) · {name}")
    sys.stdout.flush()


def fake_cli(home, now):
    agents = [{"pid": 90000 + n, "cwd": f"/Users/demo/code/{project}", "kind": "background", "startedAt": now - (40 + n * 9) * MIN,
               "sessionId": sid(n), "id": sid(n)[:8], "name": name, "status": "busy" if status == "working" else "idle"}
              for n, name, project, branch, status, *_ in SESSIONS]
    write(f"{home}/bin/agents.json", agents)
    write(f"{home}/bin/claude", f'''#!/bin/sh
# Demo stand-in for claude: lists the demo sessions and draws a canned screen for `attach`.
[ "$1" = agents ] && exec cat "{home}/bin/agents.json"
[ "$1" = attach ] && exec python3 -I "{os.path.abspath(__file__)}" --screen "$2"
exit 1
''')
    write(f"{home}/bin/path", '#!/bin/sh\nprintf %s "$PATH"\n')
    for f in ("claude", "path"):
        os.chmod(f"{home}/bin/{f}", 0o755)


def main():
    if sys.argv[1] == "--screen":
        return screen(next((sid(s[0]) for s in SESSIONS if sid(s[0]).startswith(sys.argv[2]) or s[1] == sys.argv[2]), sid(1)))
    home = os.path.abspath(sys.argv[1])
    keep = "--keep" in sys.argv
    now = int(time.time() * 1000)
    delegations_ = delegations(now)
    for x in delegations_:
        write(f"{home}/openadmiral/delegations/{x['id']}.json", x)
    artifacts(home, now)
    queues(home, now)
    transcripts(home, now)
    fake_cli(home, now)
    while True:
        for s in sessions(now):
            write(f"{home}/openadmiral/sessions/{s['sessionId']}.json", s)
        if not keep:
            break
        time.sleep(20)
        now = int(time.time() * 1000)


if __name__ == "__main__":
    main()
