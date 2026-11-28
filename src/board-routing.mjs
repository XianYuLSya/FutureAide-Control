const mentionPattern = /@([\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)*)/gu;

export function extractBoardMentions(text, explicitMentions) {
  const found = new Set(typeof text === 'string' ? Array.from(text.matchAll(mentionPattern), match => match[1]) : []);
  for (const item of Array.isArray(explicitMentions) ? explicitMentions : []) {
    if (typeof item === 'string' && item.trim()) found.add(item.trim().replace(/^@/, ''));
  }
  return [...found];
}

export function resolveBoardMention(mention, candidates, pathOf) {
  const byPath = candidates.filter(record => pathOf(record) === mention);
  const matches = byPath.length ? byPath : candidates.filter(record => record.name === mention);
  return matches.length === 1 ? matches[0] : undefined;
}

export function boardPrompt(author, message) {
  return `[团队黑板点名 · 来自 ${author}]\n${message}\n\n请通过 futureaide_board_post 回帖后继续原任务。如果原任务已结束，请保持待命。`;
}

export function isDescendant(store, record, ancestorId) {
  const seen = new Set();
  for (let next = record; next?.parentAgentId && !seen.has(next.agentId); next = store.get(next.parentAgentId)) {
    if (next.parentAgentId === ancestorId) return true;
    seen.add(next.agentId);
  }
  return false;
}
