// A service operation and a roster ticket use the same token. Never guess from a
// name or timestamp: a name can be reused and several old tickets can coexist.
export async function recoverRosterOperation(adapter, prior, context = {}) {
  if (!prior) return null;
  let key, detail, plan;
  try {
    key=typeof prior.key === 'string' ? JSON.parse(prior.key) : prior.key;
    detail=typeof prior.detail === 'string' ? JSON.parse(prior.detail) : prior.detail;
    plan=typeof prior.plan === 'string' ? JSON.parse(prior.plan) : prior.plan;
  } catch { return {removed:false,reason:'roster-recovery-record-invalid'}; }
  if (!Array.isArray(key) || key[0] !== 'roster' || typeof key.at(-1) !== 'string') return null;
  const token=plan?.ticketToken ?? detail?.ticketId;
  if (!token) return null;
  if (detail?.ticketId && plan?.ticketToken && detail.ticketId !== plan.ticketToken) return {removed:false,reason:'roster-ticket-token-conflict'};
  if (typeof token !== 'string' || typeof adapter?.ticket !== 'function' || typeof adapter?.resume !== 'function') return {removed:false,reason:'roster-recovery-unavailable'};
  const ticket=await adapter.ticket(token);
  if (!ticket) return {removed:false,reason:'roster-ticket-not-found',ticketId:token};
  if (ticket.root_id !== key.at(-1) || ticket.id !== token) return {removed:false,reason:'roster-ticket-identity-mismatch',ticketId:token};
  if (ticket.status === 'completed') {
    const bytes=typeof adapter.releasedBytes === 'function' ? await adapter.releasedBytes(token) : {};
    return {removed:true,ticketId:token,recovered:true,...bytes};
  }
  if (ticket.status !== 'claimed') return {removed:false,reason:`roster-ticket-${ticket.status}`,ticketId:token};
  if (typeof context.revalidate !== 'function' || !await context.revalidate()) return {removed:false,reason:'cleanup-authorization-changed',ticketId:token};
  const result=await adapter.resume(token,{...context,mode:prior.mode});
  return {...result,recovered:true};
}
