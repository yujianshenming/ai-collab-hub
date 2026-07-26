(function exposeTaskStateEngine(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TaskStateEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TASK_STATUSES = new Set(["pending", "running", "evaluating", "paused", "unsubmitted", "completed"]);
  const SUBTASK_STATUSES = new Set(["pending", "running", "paused", "done", "unconfirmed"]);

  function normalizeSubtasks(subtasks, quantity) {
    const count = Math.max(1, Number(quantity) || 1);
    const source = Array.isArray(subtasks) ? subtasks : [];
    return Array.from({ length: count }, (_, offset) => {
      const status = source[offset]?.status;
      return {
        index: offset + 1,
        status: SUBTASK_STATUSES.has(status) ? status : "pending"
      };
    });
  }

  function taskSubtasks(task = {}) {
    return normalizeSubtasks(task.subtasks, task.quantity);
  }

  function runningSubtaskIndex(task = {}) {
    return taskSubtasks(task).find((subtask) => subtask.status === "running")?.index || null;
  }

  function nextRunnableSubtaskIndex(task = {}) {
    const subtasks = taskSubtasks(task);
    return runningSubtaskIndex(task)
      || subtasks.find((subtask) => subtask.status === "paused")?.index
      || subtasks.find((subtask) => ["pending", "unconfirmed"].includes(subtask.status))?.index
      || null;
  }

  function taskStateViolations(task = {}) {
    const subtasks = taskSubtasks(task);
    const runningCount = subtasks.filter((subtask) => subtask.status === "running").length;
    const violations = [];
    if (runningCount > 1) violations.push("MULTIPLE_RUNNING_SUBTASKS");
    if (!["running", "evaluating"].includes(task.status) && runningCount > 0) {
      violations.push("INACTIVE_PARENT_HAS_RUNNING_SUBTASK");
    }
    if (["running", "evaluating"].includes(task.status) && runningCount === 0) {
      violations.push("ACTIVE_PARENT_WITHOUT_RUNNING_SUBTASK");
    }
    if (task.status === "completed" && subtasks.some((subtask) => subtask.status !== "done")) {
      violations.push("COMPLETED_PARENT_HAS_UNFINISHED_SUBTASK");
    }
    return violations;
  }

  function transitionTask(task = {}, event = {}) {
    const nextTask = {
      ...task,
      quantity: Math.max(1, Number(task.quantity) || 1),
      subtasks: normalizeSubtasks(task.subtasks, task.quantity)
    };

    if (event.type === "recover-startup") {
      let changed = false;
      if (["running", "evaluating"].includes(nextTask.status)) {
        nextTask.status = "paused";
        changed = true;
      }
      nextTask.subtasks = nextTask.subtasks.map((subtask) => {
        if (nextTask.status === "completed" && subtask.status !== "done") {
          changed = true;
          return { ...subtask, status: "done" };
        }
        if (subtask.status === "running") {
          changed = true;
          return { ...subtask, status: "paused" };
        }
        return subtask;
      });
      return { ok: true, task: nextTask, activeSubtaskIndex: null, changed };
    }

    if (event.type === "set-task-status") {
      const previousStatus = nextTask.status;
      const nextStatus = event.status;
      if (!TASK_STATUSES.has(nextStatus)) {
        return { ok: false, code: "INVALID_TASK_STATUS", task: nextTask };
      }
      if (
        ["running", "evaluating"].includes(nextStatus) &&
        !nextTask.subtasks.some((subtask) => subtask.status === "running")
      ) {
        return { ok: false, code: "ACTIVE_TASK_REQUIRES_RUNNING_SUBTASK", task: nextTask };
      }
      nextTask.status = nextStatus;
      if (nextStatus === "completed") {
        nextTask.subtasks = nextTask.subtasks.map((subtask) => ({ ...subtask, status: "done" }));
      } else if (nextStatus === "pending" && ["completed", "unsubmitted"].includes(previousStatus)) {
        nextTask.subtasks = nextTask.subtasks.map((subtask) => ({ ...subtask, status: "pending" }));
      } else if (nextStatus === "paused") {
        nextTask.subtasks = nextTask.subtasks.map((subtask) =>
          subtask.status === "running" ? { ...subtask, status: "paused" } : subtask
        );
      } else if (!["running", "evaluating"].includes(nextStatus)) {
        nextTask.subtasks = nextTask.subtasks.map((subtask) =>
          subtask.status === "running" ? { ...subtask, status: "pending" } : subtask
        );
      }
      return { ok: true, task: nextTask, activeSubtaskIndex: null };
    }

    const subtaskIndex = Number(event.subtaskIndex);
    const target = nextTask.subtasks.find((subtask) => subtask.index === subtaskIndex);
    if (event.type === "complete-subtask") {
      if (!target || target.status !== "running") {
        return { ok: false, code: "SUBTASK_NOT_COMPLETABLE", task: nextTask };
      }
      const nextSubtaskStatus = event.submitted ? "done" : "unconfirmed";
      nextTask.subtasks = nextTask.subtasks.map((subtask) =>
        subtask.index === subtaskIndex ? { ...subtask, status: nextSubtaskStatus } : subtask
      );
      const allSubtasksDone = nextTask.subtasks.every((subtask) => subtask.status === "done");
      const terminal = allSubtasksDone || (!event.submitted && nextTask.subtasks.length === 1);
      nextTask.status = allSubtasksDone ? "completed" : (terminal ? "unsubmitted" : "paused");
      return { ok: true, task: nextTask, activeSubtaskIndex: null, terminal };
    }

    if (event.type === "pause-subtask") {
      if (!target || target.status !== "running") {
        return { ok: false, code: "SUBTASK_NOT_PAUSABLE", task: nextTask };
      }
      nextTask.status = "paused";
      nextTask.subtasks = nextTask.subtasks.map((subtask) =>
        subtask.index === subtaskIndex ? { ...subtask, status: "paused" } : subtask
      );
      return { ok: true, task: nextTask, activeSubtaskIndex: null };
    }

    if (!["start-subtask", "resume-subtask"].includes(event.type)) {
      return { ok: false, code: "UNKNOWN_EVENT", task: nextTask };
    }

    const allowedStatuses = event.type === "resume-subtask"
      ? ["running", "paused"]
      : ["pending", "paused", "unconfirmed"];
    if (!target || !allowedStatuses.includes(target.status)) {
      return {
        ok: false,
        code: event.type === "resume-subtask" ? "SUBTASK_NOT_RESUMABLE" : "SUBTASK_NOT_STARTABLE",
        task: nextTask
      };
    }
    const running = nextTask.subtasks.find((subtask) => subtask.status === "running");
    if (running && running.index !== subtaskIndex) {
      return { ok: false, code: "SUBTASK_ALREADY_RUNNING", task: nextTask };
    }

    const activeStatus = event.taskStatus || "running";
    if (!["running", "evaluating"].includes(activeStatus)) {
      return { ok: false, code: "INVALID_ACTIVE_TASK_STATUS", task: nextTask };
    }
    nextTask.status = activeStatus;
    nextTask.subtasks = nextTask.subtasks.map((subtask) =>
      subtask.index === subtaskIndex ? { ...subtask, status: "running" } : subtask
    );
    return { ok: true, task: nextTask, activeSubtaskIndex: subtaskIndex };
  }

  return {
    nextRunnableSubtaskIndex,
    normalizeSubtasks,
    runningSubtaskIndex,
    taskStateViolations,
    taskSubtasks,
    transitionTask
  };
});
