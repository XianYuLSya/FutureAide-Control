// Native DSH associates user messages with the RPC id and events with a turn.
export function dispatchBoundary(records, afterSeq, requestId) {
  const events = records.filter(record => record.type === 'event').map(record => record.event);
  const marker = requestId && events.find(event => event.type === 'user/message'
    && (event.data?.message ?? event.data)?.source?.rpcId === requestId);
  if (marker) {
    const start = events.findLast(event => event.type === 'turn/start' && event.seq < marker.seq);
    const end = start && events.find(event => event.type === 'turn/end' && event.seq > marker.seq && event.data?.turn === start.data?.turn);
    return { correlation: 'request-id', matched: true, hasStart: Boolean(start), startSeq: start?.seq ?? marker.seq - 1,
      ...(start ? { turn: start.data.turn } : {}), ...(end ? { endSeq: end.seq, completionReason: end.data.reason } : {}) };
  }
  const queued = requestId && events.some(event => event.type === 'agent/inbox/spliced'
    && event.data?.inserted?.some(message => message.source?.rpcId === requestId));
  const native = events.some(event => event.type === 'user/message' && (event.data?.message ?? event.data)?.source?.rpcId);
  if (queued || (requestId && native)) return { correlation: 'request-id', matched: false, startSeq: afterSeq };
  const end = events.find(event => event.type === 'turn/end' && event.seq > afterSeq);
  return { correlation: 'baseline', matched: false, startSeq: afterSeq,
    ...(end ? { endSeq: end.seq, completionReason: end.data?.reason } : {}) };
}

export async function readDispatch(api, sessionId, { workspace, requestId, afterSeq, maxMessages = 100 }) {
  let page = await api.readSession(sessionId, { workspace, maxMessages });
  let records = [...page.records];
  let boundary = dispatchBoundary(records, afterSeq, requestId);
  while (requestId && (!boundary.matched || !boundary.hasStart) && page.hasMore) {
    const first = records.find(record => Number.isSafeInteger(record.event?.seq))?.event.seq;
    if (!Number.isSafeInteger(first) || first < 1) break;
    // A steer message belongs to a turn that may have started well before the send cursor. Once
    // its marker is matched, keep paging backwards for that turn's start even below afterSeq; the
    // baseline floor only protects the still-unmatched case from adopting an unrelated turn.
    const needsStart = boundary.matched && !boundary.hasStart;
    if (!needsStart && first <= afterSeq + 1) break;
    page = await api.readSession(sessionId, { workspace, maxMessages, throughSeq: first - 1 });
    const fresh = page.records.filter(record => record.event?.seq < first);
    if (!fresh.length) break;
    records = [...fresh, ...records];
    boundary = dispatchBoundary(records, afterSeq, requestId);
  }
  const scoped = records.filter(record => record.event?.seq > boundary.startSeq
    && (boundary.endSeq === undefined || record.event.seq <= boundary.endSeq));
  return { boundary, ended: boundary.endSeq !== undefined, page: { records: scoped, hasMore: false } };
}
