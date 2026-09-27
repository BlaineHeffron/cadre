export function createRevisionGuard() {
  let revision = 0;

  return {
    capture() {
      return revision;
    },
    advance() {
      revision += 1;
      return revision;
    },
    isCurrent(capturedRevision) {
      return capturedRevision === revision;
    },
  };
}
