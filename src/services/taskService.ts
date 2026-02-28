import { randomUUID } from 'crypto';
import { db } from '../db';
import { TaskRecord } from '../types/domain';

const parseTask = (row: TaskRecord): TaskRecord => row;

export const listTasks = (): TaskRecord[] => {
  const rows = db
    .prepare(
      `SELECT id, patient_id, assigned_role, assigned_user_id, task_type, source_week, due_at, created_at, completed_at, status, priority, notes
       FROM tasks
       ORDER BY
         CASE status
           WHEN 'overdue' THEN 0
           WHEN 'open' THEN 1
           ELSE 2
         END,
         due_at ASC`
    )
    .all() as TaskRecord[];

  return rows.map(parseTask);
};

export const createCheckInTask = (patientId: string, now: Date): TaskRecord => {
  const task: TaskRecord = {
    id: randomUUID(),
    patient_id: patientId,
    assigned_role: 'care_manager',
    assigned_user_id: null,
    task_type: 'checkin_request',
    source_week: null,
    due_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
    completed_at: null,
    status: 'open',
    priority: 'medium',
    notes: 'Patient requested a check-in from the app.'
  };

  db.prepare(
    `INSERT INTO tasks (
      id,
      patient_id,
      assigned_role,
      assigned_user_id,
      task_type,
      source_week,
      due_at,
      created_at,
      completed_at,
      status,
      priority,
      notes
    ) VALUES (
      @id,
      @patient_id,
      @assigned_role,
      @assigned_user_id,
      @task_type,
      @source_week,
      @due_at,
      @created_at,
      @completed_at,
      @status,
      @priority,
      @notes
    )`
  ).run(task);

  return task;
};

export const appendPortalCheckInMessage = (patientId: string, now: Date): void => {
  db.prepare(
    `INSERT INTO events (
      id,
      patient_id,
      provider_id,
      event_type,
      simulated_at,
      service_date,
      icd10_json,
      paid_amount,
      payload_json
    )
    VALUES (
      ?,
      ?,
      (SELECT provider_id FROM patients WHERE id = ?),
      'PortalMessageSent',
      ?,
      NULL,
      '[]',
      NULL,
      ?
    )`
  ).run(
    randomUUID(),
    patientId,
    patientId,
    now.toISOString(),
    JSON.stringify({
      direction: 'patient_to_clinic',
      message_topic: 'request check-in',
      word_count: 42
    })
  );
};

export const completeTask = (taskId: string, notes: string | null, now: Date): void => {
  db.prepare(
    `UPDATE tasks
     SET status = 'completed',
         completed_at = ?,
         notes = COALESCE(?, notes)
     WHERE id = ?`
  ).run(now.toISOString(), notes, taskId);
};

export const reviewRedCandidateTask = (
  taskId: string,
  decision: 'confirm_red' | 'downgrade_yellow',
  reviewerId: string,
  now: Date
): void => {
  const task = db
    .prepare(`SELECT patient_id, task_type FROM tasks WHERE id = ?`)
    .get(taskId) as { patient_id: string; task_type: string } | undefined;

  if (!task) {
    throw new Error('Task not found');
  }

  if (task.task_type !== 'red_review') {
    throw new Error('Task is not a red review task');
  }

  const durationDays = decision === 'confirm_red' ? 28 : 14;
  const manualStatus = decision === 'confirm_red' ? 'RED' : 'YELLOW';
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  db.transaction(() => {
    db.prepare(
      `UPDATE patients
       SET manual_status = ?, manual_status_expires_at = ?
       WHERE id = ?`
    ).run(manualStatus, expiresAt, task.patient_id);

    db.prepare(
      `UPDATE tasks
       SET status = 'completed',
           completed_at = ?,
           assigned_user_id = ?,
           notes = ?
       WHERE id = ?`
    ).run(
      now.toISOString(),
      reviewerId,
      decision === 'confirm_red'
        ? 'Review complete: Red confirmed and high-touch workflow activated.'
        : 'Review complete: downgraded to Yellow and outreach requested.',
      taskId
    );
  })();
};

export const createPhysicianOutreachNoteTask = (
  patientId: string,
  physicianId: string,
  now: Date
): TaskRecord => {
  const task: TaskRecord = {
    id: randomUUID(),
    patient_id: patientId,
    assigned_role: 'physician',
    assigned_user_id: physicianId,
    task_type: 'outreach_note',
    source_week: null,
    due_at: new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
    completed_at: null,
    status: 'open',
    priority: 'low',
    notes: 'Simulation note stub: outreach attempt documented.'
  };

  db.prepare(
    `INSERT INTO tasks (
      id,
      patient_id,
      assigned_role,
      assigned_user_id,
      task_type,
      source_week,
      due_at,
      created_at,
      completed_at,
      status,
      priority,
      notes
    ) VALUES (
      @id,
      @patient_id,
      @assigned_role,
      @assigned_user_id,
      @task_type,
      @source_week,
      @due_at,
      @created_at,
      @completed_at,
      @status,
      @priority,
      @notes
    )`
  ).run(task);

  return task;
};
