/** Split only the server's complete quote/attribution blocks; unknown formats stay visible. */
export function proofPresentation(body: string) {
  const matches = [...body.matchAll(/(?:^|\n\n)([^\n]+)\n\n[“"]([\s\S]+?)[”"]\n([^\n]+)(?=\n\n|$)/g)];
  if (matches.length <= 3) return null;
  const blocks: string[] = [];
  let end = matches[0].index!;
  for (const match of matches) {
    if (body.slice(end, match.index).trim()) return null;
    blocks.push(match[0].trim());
    end = match.index! + match[0].length;
  }
  return { introduction: body.slice(0, matches[0].index).trim(), featured: blocks.slice(0, 3),
    remaining: blocks.slice(3), closing: body.slice(end).trim() };
}
