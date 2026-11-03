const REVIEWLY_SIGNATURE =
  '<sub>Posted by <a href="https://github.com/volnei/reviewly">Reviewly</a></sub>';

/** Format only the outgoing body; drafts and existing signatures stay intact. */
export function withReviewlySignature(body: string, include: boolean): string {
  if (!include || body.includes(REVIEWLY_SIGNATURE)) return body;
  const content = body.trimEnd();
  return content ? `${content}\n\n${REVIEWLY_SIGNATURE}` : REVIEWLY_SIGNATURE;
}
