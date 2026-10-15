import type { Source } from '@/lib/copy-studio/shared/contracts';

export function SourceCoverage({ source }: { source: Source }) {
  const crawl = source.crawl;
  if (!crawl) return null;
  const read = crawl.pages.filter(page => page.status === 'read').length;
  return (
    <details className="reference-preview source-coverage">
      <summary>Website coverage · {read} pages read · {crawl.complete ? 'discovered routes checked' : 'review gaps'}</summary>
      <ul>
        {crawl.pages.map((page, index) => <li key={`${page.url}-${index}`}>
          <a href={page.url} target="_blank" rel="noreferrer">{page.title || page.url}</a>
          {' — '}{page.status === 'unreadable' ? 'needs pasted copy' : page.status}{page.truncated ? ' · text shortened' : ''}
          {page.detail && <p className="field-hint">{page.detail}</p>}
        </li>)}
        {crawl.pending.map(url => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a> — not read</li>)}
      </ul>
      {crawl.warnings.map(warning => <p className="field-hint" key={warning}>{warning}</p>)}
    </details>
  );
}
