import { ArrowDownToLine, Copy } from 'lucide-react';

export function DesignPromptPanel({ prompt, busy, onCopy, onExport }: {
  prompt: string;
  busy: boolean;
  onCopy: (text: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="design-prompt-panel">
      <div className="design-prompt-heading">
        <div>
          <h3>Take this page into ChatGPT</h3>
          <p>Your copy, section layouts, and design direction in one prompt. Ready automatically, and updated when you save a copy change.</p>
        </div>
      </div>
      <p className="design-prompt-constraints">Distinct section compositions, readable copy, and custom atmosphere. One dark canvas and one clear action. No navigation or repeated card grids.</p>
      <div className="design-prompt-actions">
        <button className="button primary small-button" disabled={busy} onClick={() => onCopy(prompt)}>
          <Copy size={14} /> Copy design prompt
        </button>
        <button className="button secondary small-button" onClick={onExport} disabled={busy}>
          <ArrowDownToLine size={14} /> Download prompt
        </button>
      </div>
      <label className="label-micro" htmlFor="landing-page-design-prompt">Landing page design prompt</label>
      <textarea id="landing-page-design-prompt" className="design-prompt-text" value={prompt} readOnly rows={23} spellCheck={false} />
      <p className="field-hint">Paste it into ChatGPT to build the page. Supply your logo, approved imagery, and booking or form destination when available.</p>
    </div>
  );
}
