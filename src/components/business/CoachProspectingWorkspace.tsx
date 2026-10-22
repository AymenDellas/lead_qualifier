"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadCoachProspectingAction,
  startCoachProspectingAction,
  changeCoachRunAction,
  retryCoachRunAction,
  loadCoachProspectAction,
  saveCoachReviewAction,
  recordCoachMessageSentAction,
} from "@/app/actions/coach-prospecting-actions";
import {
  COACH_LISTS,
  COACH_SOURCES,
  type CoachContact,
} from "@/lib/coach-prospecting";
import { contactRoute, csvCell } from "@/lib/coach-prospecting.cjs";
import { saveCaseStudyProspectAction } from "@/app/actions/case-study-actions";
import type { CaseStudyProspect } from "@/lib/case-study";
import { Field, LinkOut } from "./BusinessUi";
import "./coach-prospecting.css";
type Snapshot = Awaited<ReturnType<typeof loadCoachProspectingAction>>;
type Row = Snapshot["rows"][number];
type RunWork = <T>(
  work: () => Promise<T>,
  message: string,
) => Promise<T | null>;
const date = (value: string) => (value ? new Date(value).toLocaleString() : "");
const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());
export default function CoachProspectingWorkspace({
  active = true,
}: {
  active?: boolean;
}) {
  const [data, setData] = useState<Snapshot | null>(null),
    [accountId, setAccountId] = useState(""),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [list, setList] = useState("ALL"),
    [source, setSource] = useState("ALL"),
    [page, setPage] = useState(0);
  const [view, setView] = useState("list"),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [detail, setDetail] = useState<CaseStudyProspect | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const sequence = useRef(0),
    loading = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(0);
      setSelected(new Set());
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const refresh = useCallback(
    async (quiet = false) => {
      const request = ++sequence.current;
      if (!quiet) loading.current = true;
      try {
        const next = await loadCoachProspectingAction({
          accountId,
          query: search,
          list,
          source,
          page,
        });
        if (request === sequence.current) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (request === sequence.current)
          setError(
            e instanceof Error ? e.message : "Prospects could not be loaded.",
          );
      } finally {
        loading.current = false;
      }
    },
    [accountId, search, list, source, page],
  );
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(true), 10000);
    return () => clearInterval(timer);
  }, [refresh, active]);
  const run: RunWork = async (work, message) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      setNotice(message);
      await refresh(true);
      return result;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The change could not be saved.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const account = data?.accountId || accountId;
  const chosenAccount = data?.accounts.find((a) => a.id === account);
  const selectedCount =
    data?.rows.filter(
      (r) =>
        selected.has(r.id) &&
        !["SUPPRESSED", "CONTACTED"].includes(r.classification.list),
    ).length || 0;
  const open = async (row: Row) => {
    const record = await run(() => loadCoachProspectAction(row.id), "");
    if (record) setDetail(record);
  };
  const recheck = async () => {
    if (!data || !account) return;
    const rows = data.rows.filter((r) => selected.has(r.id));
    if (!rows.length) return;
    const created = await run(
      () =>
        startCoachProspectingAction({
          accountId: account,
          source: "RECHECK",
          limit: rows.length,
          urls: rows.map((r) => r.data.linkedinUrl),
        }),
      "Selected profiles queued for a fresh evidence review. Contacted and excluded people stay protected.",
    );
    if (created) {
      setSelected(new Set());
      setView("runs");
    }
  };
  const exportRows = async () => {
    if (!data) return;
    await run(async () => {
      const all: Row[] = [];
      let nextPage = 0;
      let result: Snapshot;
      do {
        result = await loadCoachProspectingAction({
          accountId: account,
          query: search,
          list,
          source,
          page: nextPage++,
        });
        all.push(...result.rows);
        if (all.length > 5000)
          throw Error(
            "Narrow this list before exporting more than 5,000 prospects.",
          );
      } while (result.hasMore);
      const csv = [
        [
          "Name",
          "LinkedIn URL",
          "Headline",
          "Website",
          "Discovery source",
          "Fit",
          "Priority score",
          "Contact route",
          "Reason",
        ],
        ...all.map((r) => [
          r.data.name,
          r.data.linkedinUrl,
          r.data.headline,
          r.data.website,
          COACH_SOURCES[
            (r.data.prospecting?.discoverySource ||
              "MANUAL") as keyof typeof COACH_SOURCES
          ] || "Other / manually added",
          r.data.prospecting?.assessment?.status || "Needs review",
          r.classification.score,
          r.classification.route.label,
          r.data.prospecting?.assessment?.reason ||
            "Not assessed with the new evidence rules.",
        ]),
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
      const url = URL.createObjectURL(
        new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "compel-coach-prospects.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }, "Filtered prospect list exported.");
  };
  return (
    <div className="coach-workspace">
      <div className="coach-intro">
        <div>
          <p className="label-micro">LinkedIn prospecting</p>
          <h2>Coach prospects</h2>
          <p>
            Review your coaches, check the evidence, and choose how to reach them.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setView("discover")}>
          Discover coaches
        </button>
      </div>
      {error && (
        <p className="coach-feedback is-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="coach-feedback" role="status">
          {notice}
        </p>
      )}
      <div className="coach-account-bar">
        <label>
          LinkedIn worker account
          <select
            className="field"
            aria-label="LinkedIn worker account"
            value={account}
            onChange={(e) => {
              setAccountId(e.target.value);
              setPage(0);
              setSelected(new Set());
              setDetail(null);
            }}
          >
            {!data?.accounts.length && (
              <option value="">No saved accounts</option>
            )}
            {data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.signedIn?.name ? ` · ${a.signedIn.name}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div>
          <strong>
            {chosenAccount?.status === "paused"
              ? "Paused · account needs attention"
              : chosenAccount?.online
                ? label(chosenAccount.status)
                : "Worker offline"}
          </strong>
          <span>
            {chosenAccount
              ? `${chosenAccount.dailyCount} / ${chosenAccount.dailyLimit} research budget used today`
              : "Add or sign in to an account in Pipeline Engine."}
          </span>
          <small>
            Your budget is a local control, not a LinkedIn-approved allowance.
          </small>
        </div>
        <button
          className="btn btn-outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {!data ? (
        <p role="status">
          {error
            ? "Use Refresh to try again."
            : "Loading your prospecting workspace…"}
        </p>
      ) : (
        <>
          {!data.supervisorOnline && (
            <p className="coach-feedback">
              The account supervisor is offline. Saved lists are available; new
              runs wait for the worker computer.
            </p>
          )}
          {chosenAccount?.status === "paused" && (
            <p className="coach-feedback">
              {chosenAccount.reason} Open Engine → LinkedIn accounts → Sign in
              on worker computer. Saved lists remain available.
            </p>
          )}
          {chosenAccount?.online && !chosenAccount.prospectingReady && (
            <p className="coach-feedback">
              This account worker is online but needs the prospecting update and
              a restart. New runs are retained until the updated worker is
              ready.
            </p>
          )}
          <nav className="coach-top-tabs" aria-label="Prospecting workspace">
            <button
              aria-current={view === "list" ? "page" : undefined}
              onClick={() => setView("list")}
            >
              Prospect lists
            </button>
            <button
              aria-current={view === "discover" ? "page" : undefined}
              onClick={() => setView("discover")}
            >
              Discovery setup
            </button>
            <button
              aria-current={view === "runs" ? "page" : undefined}
              onClick={() => setView("runs")}
            >
              Runs & recovery
            </button>
          </nav>
          {view === "discover" && (
            <DiscoveryForm
              accountId={account}
              busy={busy}
              run={run}
              started={() => setView("runs")}
            />
          )}
          {view === "runs" && (
            <div className="coach-runs">
              <div>
                <h3>Your discovery runs</h3>
                <p>
                  Results save as they finish. Stop affects only the selected
                  run, not your existing lead queue.
                </p>
              </div>
              {!data.runs.length ? (
                <p>No runs yet. Choose Discovery setup to start.</p>
              ) : (
                data.runs.map((r) => (
                  <article className="coach-run" key={r.id}>
                    <div>
                      <strong>
                        {label(r.source)} · {label(r.status)}
                      </strong>
                      <small>{date(r.created_at)}</small>
                    </div>
                    <p>
                      {r.done} reviewed · {r.pending} queued or processing ·{" "}
                      {r.failed} failed · {r.data.skipped} skipped ·{" "}
                      {r.data.queued}/{r.data.limit} collected
                    </p>
                    <p>{r.data.message}</p>
                    <div className="coach-actions">
                      {!["COMPLETE", "CANCELLED", "ERROR"].includes(
                        r.status,
                      ) && (
                        <button
                          className="btn btn-outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => changeCoachRunAction(r.id, "STOP"),
                              "Run stopped. Previously saved prospects were retained.",
                            )
                          }
                        >
                          Stop this run
                        </button>
                      )}
                      {r.status === "PAUSED" && (
                        <>
                          <button
                            className="btn btn-primary"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => changeCoachRunAction(r.id, "RESUME"),
                                "Run resumed after your account check.",
                              )
                            }
                          >
                            Resume after account check
                          </button>
                          <small>
                            Resolve the LinkedIn check in Pipeline Engine →
                            LinkedIn accounts first.
                          </small>
                        </>
                      )}
                      {r.failed > 0 && r.status === "COMPLETE" && (
                        <button
                          className="btn btn-outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => retryCoachRunAction(r.id),
                              "Failed profiles queued for an explicit retry.",
                            )
                          }
                        >
                          Retry failed profiles
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          )}
          {view === "list" && (
            <>
              <div className="coach-counts">
                {[
                  ["READY", "Ready to message"],
                  ["CONNECT", "To connect"],
                  ["REVIEW", "Fit needs review"],
                  ["VERIFY", "Messaging to verify"],
                ].map(([key, title]) => (
                  <button
                    key={key}
                    onClick={() => {
                      setList(key);
                      setPage(0);
                      setSelected(new Set());
                    }}
                  >
                    <strong>{data.counts[key] || 0}</strong>
                    <span>{title}</span>
                  </button>
                ))}
              </div>
              <div className="coach-list-controls">
                <label>
                  Find a coach
                  <input
                    className="field"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Name, headline or website"
                  />
                </label>
                <label>
                  Prospect list
                  <select
                    className="field"
                    aria-label="Prospect list"
                    value={list}
                    onChange={(e) => {
                      setList(e.target.value);
                      setPage(0);
                      setSelected(new Set());
                    }}
                  >
                    {Object.entries(COACH_LISTS).map(([id, title]) => (
                      <option value={id} key={id}>
                        {title} ({data.counts[id] || 0})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Discovery source
                  <select
                    className="field"
                    aria-label="Filter by discovery source"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setPage(0);
                      setSelected(new Set());
                    }}
                  >
                    {Object.entries(COACH_SOURCES).map(([id, title]) => (
                      <option key={id} value={id}>
                        {title} ({data.sourceCounts[id] || 0})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn btn-outline"
                  disabled={busy || !data.total}
                  onClick={() => void exportRows()}
                >
                  Export this list
                </button>
              </div>
              <div className="coach-list-summary">
                <span>
                  {data.total} prospects · sorted by evidence and opportunity
                </span>
                <button
                  className="btn btn-outline"
                  disabled={busy || !selectedCount}
                  onClick={() => void recheck()}
                >
                  Research selected ({selectedCount})
                </button>
              </div>
              {!data.rows.length ? (
                <div className="coach-empty">
                  <h3>
                    {data.total
                      ? "No prospects on this page."
                      : "No prospects in this list yet."}
                  </h3>
                  <p>
                    Discover new profiles, import a list, or review existing
                    candidates. An inconclusive headline stays in Needs fit
                    review.
                  </p>
                </div>
              ) : (
                <div className="coach-table-scroll">
                  <table className="coach-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Select this page for research"
                            checked={
                              data.rows.length > 0 &&
                              data.rows.every((r) => selected.has(r.id))
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? new Set(data.rows.map((r) => r.id))
                                  : new Set(),
                              )
                            }
                          />
                        </th>
                        <th>Coach / evidence</th>
                        <th>Fit</th>
                        <th>Contact route</th>
                        <th>Priority</th>
                        <th>Review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Research ${row.data.name || row.data.linkedinUrl}`}
                              checked={selected.has(row.id)}
                              onChange={(e) =>
                                setSelected((old) => {
                                  const next = new Set(old);
                                  e.target.checked
                                    ? next.add(row.id)
                                    : next.delete(row.id);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td>
                            <a
                              className="coach-profile-name"
                              href={row.data.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {row.data.name || "Profile awaiting research"}
                              <span className="sr-only">
                                {" "}
                                (opens LinkedIn in a new tab)
                              </span>
                            </a>
                            <p>{row.data.headline || row.data.linkedinUrl}</p>
                            <small>
                              {COACH_SOURCES[
                                (row.data.prospecting?.discoverySource ||
                                  "MANUAL") as keyof typeof COACH_SOURCES
                              ] || "Other / manually added"}
                            </small>
                            <small>
                              {row.data.prospecting?.assessment?.reason ||
                                "Not assessed with the new evidence rules. Saved headlines were not discarded."}
                            </small>
                          </td>
                          <td>
                            <span className="coach-status">
                              {row.data.prospecting?.assessment
                                ? label(row.data.prospecting.assessment.status)
                                : "Needs review"}
                            </span>
                          </td>
                          <td>
                            <span>{row.classification.route.label}</span>
                            <small>{row.classification.route.reason}</small>
                          </td>
                          <td className="num">
                            {row.classification.score || "—"}
                          </td>
                          <td>
                            <button
                              className="btn btn-outline"
                              disabled={busy}
                              onClick={() => void open(row)}
                            >
                              Review
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="coach-pagination">
                <button
                  className="btn btn-outline"
                  disabled={busy || page === 0}
                  onClick={() => {
                    setPage((p) => p - 1);
                    setSelected(new Set());
                  }}
                >
                  Previous
                </button>
                <span>Page {page + 1}</span>
                <button
                  className="btn btn-outline"
                  disabled={busy || !data.hasMore}
                  onClick={() => {
                    setPage((p) => p + 1);
                    setSelected(new Set());
                  }}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
      {detail && (
        <CoachReview
          key={`${detail.id}-${account}`}
          prospect={detail}
          accountId={account}
          accountLabel={chosenAccount?.label || "selected account"}
          busy={busy}
          error={error}
          message={notice}
          run={run}
          onSaved={setDetail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
function DiscoveryForm({
  accountId,
  busy,
  run,
  started,
}: {
  accountId: string;
  busy: boolean;
  run: RunWork;
  started: () => void;
}) {
  const [source, setSource] = useState("CONNECTION"),
    [limit, setLimit] = useState(25),
    [url, setUrl] = useState(""),
    [urls, setUrls] = useState(""),
    [exclusions, setExclusions] = useState("");
  return (
    <section className="coach-discovery">
      <div>
        <p className="label-micro">ONE CONNECTED WORKER</p>
        <h3>Choose where to look.</h3>
        <p>
          The worker uses the selected account’s existing browser session.
          Discovery collects candidates first; About and business evidence
          decide fit afterward.
        </p>
      </div>
      <fieldset disabled={busy || !accountId}>
        <div className="coach-two">
          <label>
            Discovery source
            <select
              className="field"
              aria-label="Discovery source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="CONNECTION">My connections</option>
              <option value="FOLLOWER">My followers</option>
              <option value="PROFILE_VIEWER">Profile viewers</option>
              <option value="SEARCH">A LinkedIn people search</option>
              <option value="URLS">Paste profile URLs</option>
            </select>
          </label>
          <label>
            New profiles to research
            <input
              type="number"
              className="field"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
        </div>
        {source === "SEARCH" && (
          <Field
            label="LinkedIn people-search URL"
            value={url}
            onChange={setUrl}
            hint="Set your filters on LinkedIn, then paste that people-search URL. Search access depends on your plan."
          />
        )}
        {source === "URLS" && (
          <Field
            label="Profile URLs"
            value={urls}
            onChange={setUrls}
            multiline
            hint="One linkedin.com/in/ profile per line. Existing, contacted and excluded people are skipped."
          />
        )}
        <Field
          label="Additional exclusions (optional)"
          value={exclusions}
          onChange={setExclusions}
          multiline
          hint="One phrase per line, such as football coach or recruitment. Missing job-title words never cause an automatic rejection."
        />
        <div className="coach-discovery-note">
          <strong>What this run will do</strong>
          <ul>
            <li>
              Collect up to {limit || "your target"} new profiles from the
              visible list, without discarding unusual headlines.
            </li>
            <li>
              Read the profile and linked business pages; keep evidence, gaps
              and uncertain cases.
            </li>
            <li>
              Check explicit free-messaging evidence for this account. Unknown
              stays unverified.
            </li>
            <li>
              Save a shortlist. You choose who to connect with or message on
              LinkedIn.
            </li>
          </ul>
          <p>
            People Search follows Next pages until your target, the end of
            results, or a 50-page limit. Network lists use up to 12 scroll
            passes. One discovery run and each uncached profile reserve
            research-budget units. Limits or account checks pause the run; there
            is no guarantee against restrictions.
          </p>
        </div>
        <button
          className="btn btn-primary"
          disabled={
            busy ||
            !accountId ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            (source === "SEARCH" && !url.trim()) ||
            (source === "URLS" && !urls.trim())
          }
          onClick={async () => {
            const result = await run(
              () =>
                startCoachProspectingAction({
                  accountId,
                  source,
                  limit,
                  sourceUrl: url,
                  urls:
                    source === "URLS"
                      ? urls
                          .split(/[\n,]+/)
                          .map((x) => x.trim())
                          .filter(Boolean)
                      : [],
                  exclude: exclusions
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
                }),
              "Discovery queued. Progress and recovery are available in Runs.",
            );
            if (result) started();
          }}
        >
          {busy ? "Saving…" : "Queue discovery & research"}
        </button>
      </fieldset>
    </section>
  );
}
function CoachReview({
  prospect,
  accountId,
  accountLabel,
  busy,
  error,
  message,
  run,
  onSaved,
  onClose,
}: {
  prospect: CaseStudyProspect;
  accountId: string;
  accountLabel: string;
  busy: boolean;
  error: string;
  message: string;
  run: RunWork;
  onSaved: (p: CaseStudyProspect | null) => void;
  onClose: () => void;
}) {
  const d = prospect.data,
    a = d.prospecting?.assessment,
    contact =
      d.prospecting?.contact?.accountId === accountId
        ? d.prospecting.contact
        : null,
    route = contactRoute(d, accountId);
  const [connection, setConnection] = useState<CoachContact["connection"]>(
      contact?.connection || "UNKNOWN",
    ),
    [open, setOpen] = useState<CoachContact["openProfile"]>(
      contact?.openProfile || "UNKNOWN",
    ),
    [contactNote, setContactNote] = useState(""),
    [fit, setFit] = useState(a?.status || "POTENTIAL"),
    [fitNote, setFitNote] = useState(""),
    [draft, setDraft] = useState(d.suggestedDm || ""),
    [invitationDraft, setInvitationDraft] = useState(
      d.prospecting?.invitationDraft || "",
    ),
    [invitationCopied, setInvitationCopied] = useState(false),
    [copyError, setCopyError] = useState(""),
    [copied, setCopied] = useState(false),
    [closing, setClosing] = useState(false);
  const dirty =
    draft !== (d.suggestedDm || "") ||
    invitationDraft !== (d.prospecting?.invitationDraft || "") ||
    Boolean(contactNote || fitNote) ||
    fit !== (a?.status || "POTENTIAL") ||
    connection !== (contact?.connection || "UNKNOWN") ||
    open !== (contact?.openProfile || "UNKNOWN");
  const dialogRef = useRef<HTMLElement>(null),
    dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dirtyRef.current ? setClosing(true) : onClose();
      }
      if (event.key === "Tab") {
        const nodes = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary",
          ) || []),
        ].filter((el) => el.getClientRects().length);
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    const navigation = (event: Event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        setClosing(true);
      }
    };
    window.addEventListener("compel:before-navigation", navigation);
    return () => {
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("compel:before-navigation", navigation);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  const save = async (input: unknown, message: string) => {
    const result = await run(
      () => saveCoachReviewAction(prospect.id, prospect.revision, input),
      message,
    );
    if (result) {
      const kind = (input as { kind: string }).kind;
      if (kind === "FIT") setFitNote("");
      if (kind === "CONTACT") setContactNote("");
      if (kind === "CONTACT" || kind === "INVITATION_SENT") {
        setConnection(
          result.data.prospecting?.contact?.connection || "UNKNOWN",
        );
        setOpen(result.data.prospecting?.contact?.openProfile || "UNKNOWN");
      }
      onSaved(result);
    }
  };
  const createDraft = () => {
    const name = d.name.split(" ")[0] || "there",
      headline = d.headline.trim();
    setDraft(
      `Hi ${name}, ${headline ? `I came across your profile: “${headline.slice(0, 160)}”.` : "I came across your coaching work."}\n\nI build landing pages and booking flows for coaches.${d.website ? " I came across " + new URL(d.website).hostname.replace(/^www\./, "") + "." : ""}\n\nWould it be useful if I shared a couple of ideas for the path from your website to a discovery call?`,
    );
  };
  return (
    <div className="coach-review-backdrop">
      <section
        ref={dialogRef}
        className="coach-review"
        role="dialog"
        aria-modal="true"
        aria-label={`Review ${d.name || "prospect"}`}
      >
        <header>
          <div>
            <p className="label-micro">PROSPECT REVIEW</p>
            <h2>{d.name || "Coach profile"}</h2>
          </div>
          <button
            className="btn btn-outline"
            onClick={() => (dirty ? setClosing(true) : onClose())}
          >
            Close
          </button>
        </header>
        {error && (
          <p role="alert" className="coach-feedback is-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="coach-feedback">
            {message}
          </p>
        )}
        {closing && (
          <div className="coach-feedback" role="alert">
            <p>You have unsaved review notes or a draft.</p>
            <div className="coach-actions">
              <button
                className="btn btn-outline"
                onClick={() => setClosing(false)}
              >
                Keep editing
              </button>
              <button className="btn btn-danger" onClick={onClose}>
                Discard unsaved edits
              </button>
            </div>
          </div>
        )}
        <p>{d.headline}</p>
        <div className="coach-actions">
          <LinkOut url={d.linkedinUrl}>Open LinkedIn profile ↗</LinkOut>
          <LinkOut url={d.website}>Open business website ↗</LinkOut>
        </div>
        <section>
          <h3>Why this person is here</h3>
          <p>
            {a?.reason ||
              "This prospect has not been assessed with the new evidence rules. Research them or record an evidence-based review."}
          </p>
          <p className="coach-meta">
            {a
              ? `${label(a.status)} · ${a.score}/100 · ${date(a.assessedAt)}`
              : "No current evidence assessment"}
          </p>
          {a?.evidence.map((e, i) => (
            <blockquote key={i}>
              <p>“{e.quote}”</p>
              <small>
                {e.source}{" "}
                {e.url && <LinkOut url={e.url}>View source ↗</LinkOut>}
              </small>
            </blockquote>
          ))}
          {a?.gaps.length ? (
            <div>
              <strong>Still unconfirmed</strong>
              <ul>
                {a.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {d.prospecting?.researchStatus === "PARTIAL" && (
            <p className="coach-feedback">
              Website research is partial. Missing evidence is unconfirmed, not
              a negative finding.
            </p>
          )}
          <details>
            <summary>Saved About text</summary>
            <p className="coach-prose">
              {d.prospecting?.about ||
                "No About text was captured. Research this profile to check it."}
            </p>
          </details>
        </section>
        <fieldset disabled={busy}>
          <section>
            <h3>Review coaching fit</h3>
            <div className="coach-two">
              <label>
                Decision
                <select
                  className="field"
                  value={fit}
                  onChange={(e) => setFit(e.target.value as typeof fit)}
                >
                  <option value="MATCH">Matches our coaching criteria</option>
                  <option value="POTENTIAL">Keep for review</option>
                  <option value="OUTSIDE">Outside our criteria</option>
                </select>
              </label>
              <Field
                label="Evidence for your decision"
                value={fitNote}
                onChange={setFitNote}
                multiline
                hint="Record what you verified. The automated evidence remains attached."
              />
            </div>
            <button
              className="btn btn-outline"
              disabled={fitNote.trim().length < 15}
              onClick={() =>
                void save(
                  { kind: "FIT", status: fit, note: fitNote },
                  "Your fit decision was saved with its reason.",
                )
              }
            >
              Save fit review
            </button>
          </section>
          <section>
            <h3>Contact route · {accountLabel}</h3>
            <p>
              <strong>{route.label}</strong> · {route.reason}
            </p>
            {contact && (
              <p className="coach-meta">
                {label(contact.source)} check · {date(contact.checkedAt)}
                <br />
                {contact.note}
              </p>
            )}
            <p className="coach-meta">
              Open the profile from this same account. A gold badge or generic
              Message button is not proof of free messaging.
            </p>
            <div className="coach-two">
              <label>
                Connection status
                <select
                  className="field"
                  value={connection}
                  onChange={(e) =>
                    setConnection(e.target.value as CoachContact["connection"])
                  }
                >
                  <option value="UNKNOWN">Not verified</option>
                  <option value="CONNECTED">
                    First-degree connection confirmed
                  </option>
                  <option value="NOT_CONNECTED">Not connected</option>
                  <option value="PENDING">Invitation pending</option>
                </select>
              </label>
              <label>
                Open Profile free messaging
                <select
                  className="field"
                  value={open}
                  onChange={(e) =>
                    setOpen(e.target.value as CoachContact["openProfile"])
                  }
                >
                  <option value="UNKNOWN">Not verified</option>
                  <option value="YES">
                    Free messaging explicitly confirmed
                  </option>
                  <option value="NO">Free messaging unavailable</option>
                </select>
              </label>
            </div>
            <Field
              label="What you verified on LinkedIn"
              value={contactNote}
              onChange={setContactNote}
              multiline
            />
            <button
              className="btn btn-outline"
              disabled={!accountId || contactNote.trim().length < 10}
              onClick={() =>
                void save(
                  {
                    kind: "CONTACT",
                    accountId,
                    connection,
                    openProfile: open,
                    note: contactNote,
                  },
                  "Contact eligibility saved for this account.",
                )
              }
            >
              Save verified route
            </button>
          </section>
          <section>
            <h3>Prepare your outreach</h3>
            <p>
              Review the evidence and edit the draft. Compel does not send
              invitations or messages.
            </p>
            <button
              className="btn btn-outline"
              disabled={!a || a.status !== "MATCH"}
              onClick={createDraft}
            >
              Create a starting draft
            </button>
            <Field
              label="Your LinkedIn message draft"
              value={draft}
              onChange={setDraft}
              multiline
            />
            <div className="coach-actions">
              <button
                className="btn btn-outline"
                disabled={draft === (d.suggestedDm || "")}
                onClick={() =>
                  void save(
                    { kind: "DRAFT", text: draft },
                    "Draft saved. Nothing was sent.",
                  )
                }
              >
                Save draft
              </button>
              <button
                className="btn btn-outline"
                disabled={!draft}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(draft);
                    setCopied(true);
                    setCopyError("");
                  } catch {
                    setCopied(false);
                    setCopyError(
                      "Copy could not access the clipboard. Select and copy the text instead.",
                    );
                  }
                }}
              >
                {copied ? "Copied" : "Copy draft"}
              </button>
            </div>
            {copyError && (
              <p role="alert" className="coach-feedback is-error">
                {copyError}
              </p>
            )}
            <details>
              <summary>Prepare a short connection note</summary>
              <div className="coach-invitation-note">
                <p>
                  This is separate from your message draft. Keep it within 200
                  characters; invitation availability still depends on LinkedIn.
                </p>
                <button
                  className="btn btn-outline"
                  onClick={() =>
                    setInvitationDraft(
                      `Hi ${d.name.split(" ")[0] || "there"}, I came across your profile. I work on landing pages and booking flows for coaches and would like to connect.`.slice(
                        0,
                        200,
                      ),
                    )
                  }
                >
                  Create a connection note
                </button>
                <label>
                  Connection note
                  <textarea
                    className="field"
                    rows={3}
                    maxLength={200}
                    value={invitationDraft}
                    onChange={(e) => setInvitationDraft(e.target.value)}
                  />
                  <span>{invitationDraft.length}/200 characters</span>
                </label>
                <div className="coach-actions">
                  <button
                    className="btn btn-outline"
                    disabled={
                      invitationDraft === (d.prospecting?.invitationDraft || "")
                    }
                    onClick={() =>
                      void save(
                        {
                          kind: "DRAFT",
                          channel: "INVITATION",
                          text: invitationDraft,
                        },
                        "Connection note saved. No invitation was sent.",
                      )
                    }
                  >
                    Save connection note
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={!invitationDraft}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invitationDraft);
                        setInvitationCopied(true);
                        setCopyError("");
                      } catch {
                        setCopyError(
                          "Copy could not access the clipboard. Select and copy the text instead.",
                        );
                      }
                    }}
                  >
                    {invitationCopied ? "Copied" : "Copy connection note"}
                  </button>
                </div>
              </div>
            </details>
            <div className="coach-manual-actions">
              {["DM", "OPEN_PROFILE"].includes(route.key) && (
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    const result = await run(
                      () =>
                        recordCoachMessageSentAction(prospect.id, accountId),
                      "Message recorded as sent manually. No message was sent by Compel.",
                    );
                    if (result)
                      onSaved(await loadCoachProspectAction(prospect.id));
                  }}
                >
                  I sent the message on LinkedIn
                </button>
              )}
              {["CONNECT", "VERIFY"].includes(route.key) && (
                <button
                  className="btn btn-outline"
                  onClick={() =>
                    void save(
                      { kind: "INVITATION_SENT", accountId },
                      "Invitation recorded. This prospect is waiting for acceptance; they were not marked messaged.",
                    )
                  }
                >
                  I sent a connection request
                </button>
              )}
              {route.key === "PENDING" && (
                <p>
                  Wait for acceptance. Once connected, verify that status above
                  to prepare your message.
                </p>
              )}
              <button
                className="btn btn-ghost"
                disabled={d.stage === "DO_NOT_CONTACT"}
                onClick={async () => {
                  const result = await run(
                    () =>
                      saveCaseStudyProspectAction(
                        prospect.id,
                        { ...d, stage: "DO_NOT_CONTACT" },
                        prospect.revision,
                      ),
                    "Prospect excluded from outreach.",
                  );
                  if (result) onClose();
                }}
              >
                Don’t contact this person
              </button>
            </div>
          </section>
        </fieldset>
      </section>
    </div>
  );
}
