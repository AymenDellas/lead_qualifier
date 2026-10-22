'use client';
export default function ProjectError({ reset }: {reset:()=>void}) {
  return <main className="max-w-3xl mx-auto p-8 space-y-4"><h1 className="text-2xl font-semibold">Your project could not be loaded.</h1><p>Your saved work is safe. Please try again.</p><button className="btn btn-primary" onClick={reset}>Try again</button></main>;
}
