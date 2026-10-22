import React from 'react';
import { proofPresentation } from '@/lib/copy-studio/shared/proof-presentation';

export function ProofBody({ body }: { body: string }) {
  const proof = proofPresentation(body);
  if (!proof) return <p>{body}</p>;
  return <>
    {proof.introduction && <p>{proof.introduction}</p>}
    {proof.featured.map((block, index) => <p key={index}>{block}</p>)}
    <details className="proof-disclosure">
      <summary>Show all testimonials ({proof.remaining.length} more)</summary>
      {proof.remaining.map((block, index) => <p key={index}>{block}</p>)}
    </details>
    {proof.closing && <p>{proof.closing}</p>}
  </>;
}
