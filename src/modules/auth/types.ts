/** Account as sent to clients (legacy `sanitizeAccount`): no password hash or salt. */
export interface PublicUser {
  id: string;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
  createdAt: number | null;
}

/** Failure of an auth operation (Hungarian, client-facing). */
export interface AuthFailure {
  success: false;
  error: string;
}

/** register / login / verifyToken result. */
export type AuthResult = { success: true; user: PublicUser; token: string } | AuthFailure;

/** updateProfile result. */
export type ProfileResult = { success: true; user: PublicUser } | AuthFailure;

/** auth:register fields (absent or empty → undefined). */
export interface RegisterInput {
  username?: string | undefined;
  password?: string | undefined;
  avatarColor?: string | undefined;
  avatarUrl?: string | undefined;
}

/** auth:login fields. */
export interface LoginInput {
  username?: string | undefined;
  password?: string | undefined;
}

/**
 * user:update-profile fields. `avatarUrl`: undefined keeps the current one, `null` or `''`
 * clears it (legacy `avatarUrl !== undefined ? avatarUrl : account.avatarUrl`).
 */
export interface ProfileInput {
  username?: string | undefined;
  avatarColor?: string | undefined;
  avatarUrl?: string | null | undefined;
}

/** Data a session is established from (legacy `establishUserSession(data)`). */
export interface SessionData {
  authenticated?: boolean;
  accountId?: string | null | undefined;
  username: string;
  avatarColor?: string | null | undefined;
  avatarUrl?: string | null | undefined;
}
