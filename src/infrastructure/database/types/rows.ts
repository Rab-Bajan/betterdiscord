// Raw row shapes as better-sqlite3 returns them (snake_case column names).

/** `accounts` row. */
export interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  avatar_color: string | null;
  avatar_url: string | null;
  created_at: number | null;
}

/** `channel_messages` row. `attachments` is a JSON array string. */
export interface ChannelMessageRow {
  id: string;
  channel_id: string;
  sender_id: string | null;
  username: string;
  avatar_color: string | null;
  avatar_url: string | null;
  text: string | null;
  attachments: string | null;
  timestamp: string | null;
  created_at: number | null;
}

/** `direct_messages` row. `attachments` and `call_event` are JSON strings. */
export interface DirectMessageRow {
  id: string;
  dm_key: string;
  sender_id: string | null;
  sender_account_id: string | null;
  sender_username: string;
  sender_avatar_color: string | null;
  sender_avatar_url: string | null;
  recipient_id: string | null;
  recipient_username: string;
  recipient_avatar_color: string | null;
  recipient_avatar_url: string | null;
  text: string | null;
  attachments: string | null;
  timestamp: string | null;
  created_at: number | null;
  removed_by_admin: number | null;
  call_event: string | null;
}

/** `dm_reports` row. Returned to callers as-is (the legacy API exposes raw rows). */
export interface DmReportRow {
  id: string;
  message_id: string;
  dm_key: string;
  reporter_username: string;
  reason: string | null;
  status: string;
  created_at: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution: string | null;
}

/** `calls` row. */
export interface CallRow {
  id: string;
  dm_key: string;
  caller_account_id: string;
  caller_username: string;
  callee_account_id: string;
  callee_username: string;
  status: string;
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  duration_sec: number | null;
  end_reason: string | null;
}
