const assert = require("node:assert/strict");
const test = require("node:test");

const {
  nextRunnableSubtaskIndex,
  taskStateViolations,
  transitionTask
} = require("../task-state-engine");

test("starting a subtask activates only the requested child", () => {
  const result = transitionTask({
    id: "multi-child",
    quantity: 3,
    status: "paused",
    subtasks: [
      { index: 1, status: "paused" },
      { index: 2, status: "pending" },
      { index: 3, status: "done" }
    ]
  }, {
    type: "start-subtask",
    subtaskIndex: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.status, "running");
  assert.deepEqual(result.task.subtasks, [
    { index: 1, status: "paused" },
    { index: 2, status: "running" },
    { index: 3, status: "done" }
  ]);
});

test("starting another child is rejected without mutating the task", () => {
  const task = {
    id: "conflict",
    quantity: 2,
    status: "running",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "pending" }
    ]
  };
  const before = JSON.parse(JSON.stringify(task));

  const result = transitionTask(task, {
    type: "start-subtask",
    subtaskIndex: 2
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SUBTASK_ALREADY_RUNNING");
  assert.deepEqual(task, before);
  assert.deepEqual(result.task, before);
});

test("pausing the active child allows another child to start", () => {
  const running = {
    id: "switchable",
    quantity: 2,
    status: "running",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "pending" }
    ]
  };

  const paused = transitionTask(running, {
    type: "pause-subtask",
    subtaskIndex: 1
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.task.status, "paused");
  assert.deepEqual(paused.task.subtasks, [
    { index: 1, status: "paused" },
    { index: 2, status: "pending" }
  ]);

  const switched = transitionTask(paused.task, {
    type: "start-subtask",
    subtaskIndex: 2
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.task.status, "running");
  assert.deepEqual(switched.task.subtasks, [
    { index: 1, status: "paused" },
    { index: 2, status: "running" }
  ]);
});

test("completing children keeps the parent open until every child is done", () => {
  const firstCompletion = transitionTask({
    id: "completion",
    quantity: 2,
    status: "running",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "pending" }
    ]
  }, {
    type: "complete-subtask",
    subtaskIndex: 1,
    submitted: true
  });

  assert.equal(firstCompletion.ok, true);
  assert.equal(firstCompletion.terminal, false);
  assert.equal(firstCompletion.task.status, "paused");
  assert.deepEqual(firstCompletion.task.subtasks, [
    { index: 1, status: "done" },
    { index: 2, status: "pending" }
  ]);

  const secondRunning = transitionTask(firstCompletion.task, {
    type: "start-subtask",
    subtaskIndex: 2
  });
  const finalCompletion = transitionTask(secondRunning.task, {
    type: "complete-subtask",
    subtaskIndex: 2,
    submitted: true
  });

  assert.equal(finalCompletion.ok, true);
  assert.equal(finalCompletion.terminal, true);
  assert.equal(finalCompletion.task.status, "completed");
  assert.deepEqual(finalCompletion.task.subtasks, [
    { index: 1, status: "done" },
    { index: 2, status: "done" }
  ]);
});

test("startup recovery pauses stale execution exactly once", () => {
  const stale = {
    id: "stale",
    quantity: 3,
    status: "evaluating",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "running" },
      { index: 3, status: "done" }
    ]
  };

  const recovered = transitionTask(stale, { type: "recover-startup" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.task.status, "paused");
  assert.deepEqual(recovered.task.subtasks, [
    { index: 1, status: "paused" },
    { index: 2, status: "paused" },
    { index: 3, status: "done" }
  ]);

  const repeated = transitionTask(recovered.task, { type: "recover-startup" });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.task, recovered.task);
});

test("startup recovery aligns legacy completed tasks with completed children", () => {
  const recovered = transitionTask({
    id: "legacy-completed",
    quantity: 2,
    status: "completed",
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "pending" }
    ]
  }, { type: "recover-startup" });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.changed, true);
  assert.deepEqual(recovered.task.subtasks, [
    { index: 1, status: "done" },
    { index: 2, status: "done" }
  ]);
  assert.deepEqual(taskStateViolations(recovered.task), []);
});

test("manual task status changes keep parent and children consistent", () => {
  const completed = transitionTask({
    id: "manual",
    quantity: 2,
    status: "paused",
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "paused" }
    ]
  }, {
    type: "set-task-status",
    status: "completed"
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.task.status, "completed");
  assert.deepEqual(completed.task.subtasks, [
    { index: 1, status: "done" },
    { index: 2, status: "done" }
  ]);

  const reopened = transitionTask(completed.task, {
    type: "set-task-status",
    status: "pending"
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.task.status, "pending");
  assert.deepEqual(reopened.task.subtasks, [
    { index: 1, status: "pending" },
    { index: 2, status: "pending" }
  ]);
});

test("manual status changes cannot create an active parent without an active child", () => {
  const result = transitionTask({
    id: "invalid-manual-active",
    quantity: 1,
    status: "pending",
    subtasks: [{ index: 1, status: "pending" }]
  }, {
    type: "set-task-status",
    status: "running"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTIVE_TASK_REQUIRES_RUNNING_SUBTASK");
  assert.equal(result.task.status, "pending");
  assert.equal(result.task.subtasks[0].status, "pending");
});

test("next runnable child prefers running, then paused, then pending work", () => {
  assert.equal(nextRunnableSubtaskIndex({
    quantity: 4,
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "pending" },
      { index: 3, status: "paused" },
      { index: 4, status: "running" }
    ]
  }), 4);

  assert.equal(nextRunnableSubtaskIndex({
    quantity: 3,
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "pending" },
      { index: 3, status: "paused" }
    ]
  }), 3);

  assert.equal(nextRunnableSubtaskIndex({
    quantity: 2,
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "pending" }
    ]
  }), 2);
});

test("resuming an evaluation step preserves the evaluating parent state", () => {
  const result = transitionTask({
    id: "evaluation",
    quantity: 1,
    status: "paused",
    subtasks: [{ index: 1, status: "paused" }]
  }, {
    type: "start-subtask",
    subtaskIndex: 1,
    taskStatus: "evaluating"
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.status, "evaluating");
  assert.equal(result.task.subtasks[0].status, "running");
});

test("resume accepts paused or already-running children but not pending work", () => {
  const paused = {
    id: "resume",
    quantity: 1,
    status: "paused",
    subtasks: [{ index: 1, status: "paused" }]
  };
  const resumed = transitionTask(paused, {
    type: "resume-subtask",
    subtaskIndex: 1
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.task.status, "running");
  assert.equal(resumed.task.subtasks[0].status, "running");

  const idempotent = transitionTask(resumed.task, {
    type: "resume-subtask",
    subtaskIndex: 1
  });
  assert.equal(idempotent.ok, true);
  assert.deepEqual(idempotent.task, resumed.task);

  const pending = transitionTask({
    ...paused,
    status: "pending",
    subtasks: [{ index: 1, status: "pending" }]
  }, {
    type: "resume-subtask",
    subtaskIndex: 1
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, "SUBTASK_NOT_RESUMABLE");
});

test("state invariants report conflicting parent and child execution", () => {
  assert.deepEqual(taskStateViolations({
    quantity: 2,
    status: "running",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "paused" }
    ]
  }), []);

  assert.deepEqual(taskStateViolations({
    quantity: 2,
    status: "paused",
    subtasks: [
      { index: 1, status: "running" },
      { index: 2, status: "running" }
    ]
  }), [
    "MULTIPLE_RUNNING_SUBTASKS",
    "INACTIVE_PARENT_HAS_RUNNING_SUBTASK"
  ]);

  assert.deepEqual(taskStateViolations({
    quantity: 2,
    status: "completed",
    subtasks: [
      { index: 1, status: "done" },
      { index: 2, status: "pending" }
    ]
  }), ["COMPLETED_PARENT_HAS_UNFINISHED_SUBTASK"]);

  assert.deepEqual(taskStateViolations({
    quantity: 1,
    status: "running",
    subtasks: [{ index: 1, status: "pending" }]
  }), ["ACTIVE_PARENT_WITHOUT_RUNNING_SUBTASK"]);
});
