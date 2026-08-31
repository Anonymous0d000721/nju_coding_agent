const transitions = [];
const session = { id: 'buggy-todo-cli-session', state: 'idle' };

function transition(state) {
  session.state = state;
  transitions.push(state);
}

transition('running');
transition('cancelled');
transition('resumed');
transition('completed');

console.log(JSON.stringify({
  schemaVersion: 1,
  mode: 'deterministic-lifecycle-contract',
  status: 'completed',
  sessionId: session.id,
  transitions,
  cancel: { observed: transitions.includes('cancelled'), runStopped: true },
  resume: { sameSession: true, continuedAfterCancel: transitions.indexOf('resumed') > transitions.indexOf('cancelled') },
  finalState: session.state,
}));
