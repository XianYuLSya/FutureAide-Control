const selectionError = (code, message) => Object.assign(new Error(message), { code });

export function normalizeQuestionIds({ questionId, questionIds } = {}) {
  if (questionId !== undefined && questionIds !== undefined) {
    throw selectionError('invalid-question-selector', 'Use question_id or questionIds, not both.');
  }
  const ids = questionId === undefined ? questionIds : [questionId];
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw selectionError('invalid-question-selector', 'Provide a nonempty list of unique question IDs.');
  }
  return ids;
}

export async function answerCliQuestions({ answerId, message, questionIds }, { value, load, submissions, save }) {
  const selection = normalizeQuestionIds({ questionIds });
  const taskId = load().task?.taskId;
  const previous = Object.hasOwn(value.answers, answerId) ? value.answers[answerId] : undefined;
  if (previous && value.taskId === taskId) {
    const sameIds = !selection || (selection.length === previous.consumedQuestionIds.length
      && selection.every(id => previous.consumedQuestionIds.includes(id)));
    const sameMessage = previous.continuation === `Parent answer:\n${message}\nContinue the same task.`;
    if (!sameIds || !sameMessage) throw selectionError('question-changed', 'This answer ID belongs to another answer.');
    return previous;
  }
  const { questions } = await submissions(value);
  if (!taskId || value.taskId !== taskId || load().task?.taskId !== taskId) {
    throw selectionError('question-changed', 'The task changed before the answer could be recorded.');
  }
  const pending = questions.filter(q => q.state === 'pending');
  const selected = selection ? pending.filter(q => selection.includes(q.id)) : pending.slice(0, 1);
  if (selection && selected.length !== selection.length) {
    throw selectionError('question-not-pending', 'At least one selected question is no longer pending.');
  }
  if (!selected.length) throw selectionError('question-not-pending', 'There is no unanswered question for this task.');
  const ids = selected.map(q => q.id);
  value.answered.push(...ids);
  const receipt = { consumedQuestionIds: ids, continuation: `Parent answer:\n${message}\nContinue the same task.` };
  Object.defineProperty(value.answers, answerId, { value: receipt, enumerable: true, configurable: true, writable: true });
  save(value);
  return receipt;
}
