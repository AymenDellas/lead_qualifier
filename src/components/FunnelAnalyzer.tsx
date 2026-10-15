"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Clipboard, Loader2, ScanSearch } from "lucide-react";
import type {
  LandingDimensionDiagnosis,
  LandingPageAnalysis,
  ScanResult,
  SectionDiagnosis,
} from "@/lib/funnel-analyzer-types";

type View = "landing" | "booking" | "nurture";
type ScanState = "idle" | "scanning" | "complete" | "error";

const areas: Array<{ key: keyof LandingPageAnalysis; label: string }> = [
  { key: "heroAndAboveFold", label: "Hero & above the fold" },
  { key: "copyAndMessaging", label: "Copy & messaging" },
  { key: "offerAndMechanism", label: "Offer & mechanism" },
  { key: "visualHierarchy", label: "Visual hierarchy & page flow" },
  { key: "ctaAndConversionPath", label: "CTA & conversion path" },
  { key: "trustAndProof", label: "Trust & proof" },
  { key: "objectionsAndRisk", label: "Objections & risk" },
  { key: "usabilityAndDistractions", label: "Missing sections & distractions" },
];

const stages = [
  "Reading the page",
  "Reviewing the hero, copy and offer",
  "Checking proof, calls to action and distractions",
  "Building the change plan",
];

function assessmentStyle(label: LandingDimensionDiagnosis["assessment"]["label"]) {
  if (label === "Weak") return "badge badge-bad";
  if (label === "Strong") return "badge badge-ok";
  if (label === "Limited evidence") return "badge badge-idle";
  return "badge badge-warn";
}

function buildPlan(result: ScanResult) {
  return [
    "# Landing-page rebuild plan",
    `Page: ${result.startingUrl}`,
    `Audience: ${result.audience}`,
    `Offer: ${result.offer}`,
    `Goal: ${result.conversionGoal}`,
    "",
    "## Main diagnosis",
    result.strongestDiagnosis,
    "",
    ...areas.flatMap(({ key, label }) => {
      const area = result.landingPageAnalysis[key];
      return [
        `## ${label} — ${area.assessment.label}`,
        area.diagnosis,
        ...area.evidence.map(note => `- What the page shows: ${note.title} — ${note.observation}`),
        ...area.rebuildActions.map(action => `- What to change: ${action}`),
        "",
      ];
    }),
    "## What to validate",
    ...result.validationQuestions.map(question => `- ${question}`),
    "",
    "## Scan limits",
    ...result.limitations.map(limit => `- ${limit}`),
  ].join("\n");
}

function AreaRow({ index, label, area, initiallyOpen = false }: {
  index: number;
  label: string;
  area: LandingDimensionDiagnosis;
  initiallyOpen?: boolean;
}) {
  return (
    <details open={initiallyOpen} className="group border-b border-[var(--line)] last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-4 marker:hidden sm:gap-4 sm:px-5">
        <span className="num mt-0.5 w-6 shrink-0 text-xs font-semibold text-[var(--text-faint)]">{String(index + 1).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[var(--text)]">{label}</h3>
            <span className={assessmentStyle(area.assessment.label)}>{area.assessment.label}</span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-dim)]">{area.diagnosis}</p>
        </div>
        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="grid gap-5 border-t border-[var(--line)] bg-[var(--surface-2)] px-4 py-4 sm:ml-10 sm:grid-cols-2 sm:px-5">
        <div>
          <p className="label-micro">What is hurting conversion</p>
          <div className="mt-3 space-y-3">
            {area.evidence.map((note, noteIndex) => (
              <div key={noteIndex} className="border-l-2 border-[var(--bad)] pl-3">
                <p className="text-[13px] font-semibold text-[var(--text)]">{note.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-dim)]">{note.observation}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="label-micro">What to change</p>
          {area.rebuildActions.length ? (
            <ol className="mt-3 space-y-3">
              {area.rebuildActions.map((action, actionIndex) => (
                <li key={actionIndex} className="flex gap-2 text-[13px] leading-relaxed text-[var(--text-dim)]">
                  <span className="num font-semibold text-[var(--signal)]">{String(actionIndex + 1).padStart(2, "0")}</span>
                  <span>{action}</span>
                </li>
              ))}
            </ol>
          ) : <p className="mt-3 text-[13px] text-[var(--text-dim)]">No change is justified by the available evidence.</p>}
        </div>
      </div>
    </details>
  );
}

function SecondarySection({ title, diagnosis }: { title: string; diagnosis: SectionDiagnosis }) {
  return (
    <section className="panel overflow-hidden">
      <div className="panel-head">
        {title}
        <span className={`${assessmentStyle(diagnosis.assessment.label)} ml-auto`}>{diagnosis.assessment.label}</span>
      </div>
      <div className="panel-body">
        <p className="text-sm text-[var(--text-dim)]">{diagnosis.assessment.summary}</p>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <p className="label-micro">What the page shows</p>
            <ul className="mt-3 space-y-3 text-[13px] text-[var(--text-dim)]">
              {diagnosis.working.map((note, index) => <li key={index}><strong className="text-[var(--text)]">{note.title}.</strong> {note.observation}</li>)}
              {diagnosis.findings.map((finding, index) => <li key={index}><strong className="text-[var(--text)]">{finding.title}.</strong> {finding.observation}</li>)}
            </ul>
          </div>
          <div>
            <p className="label-micro">What to change</p>
            <ol className="mt-3 space-y-3 text-[13px] text-[var(--text-dim)]">
              {diagnosis.rebuildActions.map((action, index) => <li key={index} className="flex gap-2"><span className="num font-semibold text-[var(--signal)]">{String(index + 1).padStart(2, "0")}</span>{action}</li>)}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function FunnelAnalyzer() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [view, setView] = useState<View>("landing");
  const [stage, setStage] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state !== "scanning") return;
    const timer = window.setInterval(() => setStage(current => Math.min(current + 1, stages.length - 1)), 4000);
    return () => window.clearInterval(timer);
  }, [state]);

  async function scan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "scanning") return;
    const target = url.trim();
    if (!target) {
      setError("Paste a public landing-page URL to begin.");
      setState("error");
      return;
    }
    setState("scanning");
    setError("");
    setResult(null);
    setStage(0);
    setCopied(false);
    setView("landing");
    try {
      const response = await fetch("/api/funnel-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const payload = await response.json() as ScanResult | { error?: string };
      if (!response.ok || !("scanId" in payload)) {
        throw new Error("error" in payload && payload.error ? payload.error : "The scan could not be completed.");
      }
      setResult(payload);
      setState("complete");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "The scan could not be completed.");
      setState("error");
    }
  }

  async function copyPlan() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(buildPlan(result));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("The browser could not copy the plan. Select the text in the result instead.");
    }
  }

  return (
    <div className="mx-auto max-w-[1250px] space-y-5">
      <section className="panel overflow-hidden">
        <div className="panel-head"><ScanSearch className="h-4 w-4 text-[var(--signal)]" /> Landing-page scan</div>
        <div className="panel-body">
          <p className="mb-4 max-w-3xl text-[13px] text-[var(--text-dim)]">Find conversion killers in the hero, copy, offer, page flow, calls to action and proof. Get specific changes for the rebuild.</p>
          <form onSubmit={scan} className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="funnel-scan-url">Landing-page URL</label>
            <input id="funnel-scan-url" className="field min-w-0 flex-1" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://example.com/landing-page" value={url} onChange={event => setUrl(event.target.value)} disabled={state === "scanning"} />
            <button type="submit" className="btn btn-primary justify-center" disabled={state === "scanning"}>
              {state === "scanning" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
              {state === "scanning" ? "Analyzing…" : "Analyze page"}
            </button>
          </form>
          <p className="mt-3 text-xs text-[var(--text-faint)]">Public pages only. The scan does not submit forms or book calls.</p>
          {state === "scanning" && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-[var(--signal)]"><Loader2 className="h-4 w-4 animate-spin" />{stages[stage]}</p>}
          {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--bad-dim)] p-3 text-sm text-[var(--bad)]"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
        </div>
      </section>

      {result && state === "complete" && <>
        <section className="panel overflow-hidden">
          <div className="panel-body grid gap-5 lg:grid-cols-[1fr_1fr_1.25fr]">
            <div><p className="label-micro">Audience</p><p className="mt-2 text-sm font-medium">{result.audience}</p></div>
            <div><p className="label-micro">Offer & goal</p><p className="mt-2 text-sm font-medium">{result.offer}</p><p className="mt-2 text-[13px] text-[var(--text-dim)]">{result.conversionGoal}</p></div>
            <div className="rounded-lg bg-[var(--surface-2)] p-4"><p className="label-micro">Main diagnosis</p><p className="mt-2 text-sm font-medium">{result.strongestDiagnosis}</p></div>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="seg" aria-label="Analysis sections">
            {([
              ["landing", "Landing page"],
              ["booking", "Booking flow"],
              ["nurture", "Nurture"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setView(id)} className={`seg-item ${view === id ? "seg-item-active" : ""}`} aria-pressed={view === id}>{label}</button>
            ))}
          </div>
          <button type="button" className="btn btn-outline" onClick={() => void copyPlan()}>
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? "Copied" : "Copy rebuild plan"}
          </button>
        </div>

        {view === "landing" && <section className="panel overflow-hidden">
          <div className="panel-head">Landing-page rebuild plan <span className="hint">Open an area for the concrete changes</span></div>
          {areas.map(({ key, label }, index) => <AreaRow key={key} index={index} label={label} area={result.landingPageAnalysis[key]} initiallyOpen={index === 0} />)}
        </section>}
        {view === "booking" && <SecondarySection title="Booking flow" diagnosis={result.bookingFlow} />}
        {view === "nurture" && <div className="space-y-4">
          <SecondarySection title="Nurture readiness" diagnosis={result.nurture} />
          <section className="panel p-5">
            <p className="label-micro">What needs review</p>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-[13px] text-[var(--text-dim)]">{result.nurture.informationRequired.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </section>
        </div>}

        <details className="panel p-5">
          <summary className="cursor-pointer text-sm font-semibold">Scan limits and questions to validate</summary>
          <div className="mt-4 grid gap-5 border-t border-[var(--line)] pt-4 md:grid-cols-2">
            <div><p className="label-micro">Validate next</p><ul className="mt-3 list-disc space-y-2 pl-5 text-[13px] text-[var(--text-dim)]">{result.validationQuestions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
            <div><p className="label-micro">Scan limits</p><ul className="mt-3 list-disc space-y-2 pl-5 text-[13px] text-[var(--text-dim)]">{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          </div>
        </details>
        <p className="text-xs text-[var(--text-faint)]">Analyzed with {result.model}{result.fallbackUsed ? " (fallback)" : ""}. Public page evidence only; no conversion data was available.</p>
      </>}
    </div>
  );
}
