/**
 * What deleting an account does to every table (#370): the explicit list.
 *
 * ═══ WHY A LIST, AND NOT JUST THE CODE ═══
 *
 * `deleteAccount` (src/app-layer/usecases/account-deletion.ts) is the code. This
 * is the decision, one line per model or column, with the reason, so that a
 * reviewer can check the two against each other and the owner can read what a
 * deletion keeps without reading SQL.
 *
 * `tests/guardrails/account-deletion-plan.test.ts` parses prisma/schema and
 * fails when a relation to `User`, a column that names a user, or a column that
 * can hold personal data (a name, an address, a phone, a picture, free text, an
 * IP address, a device or a credential) is missing here. So a new table cannot
 * survive a deletion silently: it fails the build until somebody decides what
 * happens to it. `tests/integration/account-deletion.test.ts` seeds every live
 * table and checks that the code does what this says.
 *
 * ═══ THE THREE ACTIONS ═══
 *
 *   delete      the rows that name the account are deleted
 *   anonymise   the row stays; the link to the account or the personal part
 *               of it is cleared
 *   keep        stays as it is, for the reason given: a record somebody else
 *               relies on that names the account only by its id, which now
 *               points at a tombstone with nothing personal on it, or data
 *               that is not the person's at all (a club's own, say)
 *
 * An entry without a `field` covers the whole row, every column of it.
 *
 * Plain data, no imports: the guardrail reads it without a database, and the
 * pull request copies its table from it.
 */

export type DeletionAction = 'delete' | 'anonymise' | 'keep';

export interface DeletionPlanEntry {
  /** The Prisma model. */
  model: string;
  /** One column; omitted for the whole row. */
  field?: string;
  action: DeletionAction;
  /** What happens, and why. */
  reason: string;
}

export const DELETION_PLAN: readonly DeletionPlanEntry[] = [
  // ── The account itself ────────────────────────────────────────────────
  {
    model: 'User',
    field: 'email',
    action: 'anonymise',
    reason:
      'Replaced by deleted-<id>@deleted.playerz.invalid (pinned by the CHECK app_user_deleted_is_scrubbed). ' +
      'Sign-in finds accounts by address, so the same Google or Facebook address then creates a new account and never finds this one.',
  },
  {
    model: 'User',
    field: 'name',
    action: 'anonymise',
    reason: 'Set to null. Every screen that shows the person shows "Изтрит потребител" instead.',
  },
  {
    model: 'User',
    field: 'phone',
    action: 'anonymise',
    reason: 'Set to null.',
  },
  {
    model: 'User',
    field: 'avatarUrl',
    action: 'anonymise',
    reason:
      'Set to null. It is the sign-in provider’s picture URL (Google, Facebook): players upload nothing, so there is no object in our media storage to delete.',
  },
  {
    model: 'User',
    field: 'passwordHash',
    action: 'anonymise',
    reason: 'Set to null (it exists for the test suites only).',
  },
  {
    model: 'User',
    field: 'emailVerified',
    action: 'anonymise',
    reason: 'Set to null: it described an address that is gone.',
  },
  {
    model: 'User',
    field: 'mfaSecret',
    action: 'anonymise',
    reason:
      'The second factor’s seed, with mfaEnabledAt and mfaLastUsedStep, set to null; the recovery codes are deleted.',
  },
  {
    model: 'User',
    action: 'anonymise',
    reason:
      'The row stays as a TOMBSTONE with deletedAt set, because bookings, places and the fee ledger name its id and platform grants hang off it by a foreign key that refuses deletion. ' +
      'emailVerified is cleared, the email settings switched off, the language reset, sessionVersion bumped; accountKind and createdAt stay (nothing personal). ' +
      'The trigger app_user_tombstone_final refuses ever changing deletedAt again, so it is never revived; the CHECK app_user_deleted_is_scrubbed keeps every personal column null while it is set. Other columns may still be written, so a maintenance UPDATE across app_user does not abort on a tombstone.',
  },
  {
    model: 'PlayerProfile',
    action: 'delete',
    reason: 'The display name, bio, date of birth, hand and ratings are the person’s own.',
  },
  {
    model: 'PlayerSportLevel',
    action: 'delete',
    reason: 'The sports and self-declared levels are the person’s own.',
  },

  // ── Signing in ────────────────────────────────────────────────────────
  {
    model: 'UserSession',
    action: 'delete',
    reason:
      'Every session row, with its IP address, user agent and token hashes. checkSession then finds no row, so every token of the account (web cookie or native) is signed out on its next request. None is written after: createUserSession refuses a deleted account, P52’s trigger refuses the row under the race, and checkSession refuses any session of one.',
  },
  {
    model: 'PasswordResetToken',
    action: 'delete',
    reason: 'Credentials of the account.',
  },
  {
    model: 'MfaRecoveryCode',
    action: 'delete',
    reason: 'Credentials of the account.',
  },
  {
    model: 'AccountSecurityEvent',
    field: 'userId',
    action: 'keep',
    reason:
      'The security log keeps the event (who enrolled, stepped up or spent a recovery code, and when). The id now names a tombstone.',
  },
  {
    model: 'AccountSecurityEvent',
    field: 'ipAddress',
    action: 'anonymise',
    reason:
      'Set to null, with userAgent: the one log that stores them. P52 lets the append-only trigger admit exactly this update, for an account already deleted and named by app.erasure_user_id, so it runs after the tombstone.',
  },
  {
    model: 'AccountSecurityEvent',
    field: 'userAgent',
    action: 'anonymise',
    reason: 'Set to null, with ipAddress.',
  },
  {
    model: 'AccountSecurityEvent',
    field: 'userSessionId',
    action: 'keep',
    reason: 'An id of a session row that is itself deleted; nothing personal.',
  },
  {
    model: 'AccountSecurityEvent',
    field: 'detailsJson',
    action: 'keep',
    reason: 'What happened (the method, a count); src/lib/auth/mfa.ts puts nothing personal in it.',
  },

  // ── Clubs ─────────────────────────────────────────────────────────────
  {
    model: 'TenantMembership',
    field: 'userId',
    action: 'delete',
    reason:
      'The account’s memberships at every club (PLAYER rows made by booking, COACH rows). The club still lists the person as "Изтрит потребител" from their past bookings.',
  },
  {
    model: 'TenantMembership',
    field: 'invitedById',
    action: 'anonymise',
    reason: 'Set to null on memberships the account invited (a club account only).',
  },
  {
    model: 'Invite',
    field: 'email',
    action: 'delete',
    reason:
      'Staff invitations addressed to the account’s email, whatever their state, matched in any case (a club types the address).',
  },
  {
    model: 'Invite',
    field: 'invitedById',
    action: 'anonymise',
    reason: 'Set to null on invitations the account sent (a club account only).',
  },
  {
    model: 'Invite',
    field: 'tokenHash',
    action: 'keep',
    reason: 'The hash of an invitation link sent by a club to somebody else; not this person’s.',
  },
  {
    model: 'ApiKey',
    field: 'createdByUserId',
    action: 'anonymise',
    reason: 'Set to null: the key is the club’s, the link to who made it goes.',
  },
  {
    model: 'ApiKey',
    field: 'name',
    action: 'keep',
    reason: 'The club’s label for its key; not personal.',
  },
  {
    model: 'ApiKey',
    field: 'tokenHash',
    action: 'keep',
    reason: 'The club’s key; not personal.',
  },
  {
    model: 'PlayerVenueRelationship',
    field: 'playerUserId',
    action: 'delete',
    reason:
      'A club’s notes on the person (tags, the no-show count): there is no person left to act on. The bookings, their no-shows included, stay.',
  },
  {
    model: 'PlayerVenueRelationship',
    field: 'tags',
    action: 'delete',
    reason: 'Deleted with the row above.',
  },
  {
    model: 'PlayerVenueRelationship',
    field: 'noShowBlockClearedByUserId',
    action: 'anonymise',
    reason: 'Set to null where the account was the staff member who lifted a block.',
  },

  // ── Bookings: the club's records ──────────────────────────────────────
  {
    model: 'Booking',
    field: 'bookedByUserId',
    action: 'keep',
    reason:
      'Owner decision 2 (#370): a booking stays in the club’s records, because its statement and the platform fee are computed from it. ' +
      'It names a tombstone, shown as "Изтрит потребител" in the diary, the players list, the booking and its players. Deletion is refused while one is upcoming.',
  },
  {
    model: 'Booking',
    field: 'guestName',
    action: 'anonymise',
    reason:
      'Set to null on the bookings the account booked: a desk booking linked to the account carries the name the desk typed, so the diary would still name the person. Guest bookings that were never linked are not the account’s and are untouched.',
  },
  {
    model: 'Booking',
    field: 'guestPhone',
    action: 'anonymise',
    reason: 'Set to null on the bookings the account booked, with guestName.',
  },
  {
    model: 'Booking',
    field: 'guestEmail',
    action: 'anonymise',
    reason: 'Set to null on the bookings the account booked, with guestName.',
  },
  {
    model: 'Booking',
    field: 'notes',
    action: 'anonymise',
    reason:
      'Set to null on the bookings the account booked: free text ("ring the bell, gate code 4471").',
  },
  {
    model: 'Booking',
    field: 'cancellationReasonJson',
    action: 'anonymise',
    reason:
      'On the bookings the account booked, the free-text `reason` inside it is set to null; the refund quote beside it stays, as the record of the money.',
  },
  {
    model: 'BookingParticipant',
    field: 'userId',
    action: 'keep',
    reason:
      'The account’s places on other people’s bookings stay, as the booking does: the people on a game are part of its record. Shown as "Изтрит потребител". Deletion is refused while one is upcoming.',
  },
  {
    model: 'BookingParticipant',
    field: 'guestName',
    action: 'keep',
    reason:
      'A guest the booker named on a kept booking: the guest’s, not the account’s, and part of the booking’s record.',
  },
  {
    model: 'BookingParticipant',
    field: 'guestEmail',
    action: 'keep',
    reason: 'As guestName: the guest’s.',
  },
  {
    model: 'BookingSeries',
    field: 'customerUserId',
    action: 'keep',
    reason:
      'A weekly series the club entered for the person stays with its occurrences (bookings, kept). It names a tombstone.',
  },
  {
    model: 'BookingSeries',
    field: 'customerName',
    action: 'anonymise',
    reason:
      'Emptied on the series linked to the account (NOT NULL, so an empty string): the name the desk typed for the person.',
  },
  {
    model: 'BookingSeries',
    field: 'customerPhone',
    action: 'anonymise',
    reason: 'Emptied with customerName.',
  },
  {
    model: 'BookingSeries',
    field: 'notes',
    action: 'anonymise',
    reason: 'Set to null on the series linked to the account.',
  },
  {
    model: 'BookingSeries',
    field: 'createdByUserId',
    action: 'keep',
    reason: 'The staff member who entered it (a club account); the id names a tombstone.',
  },
  {
    model: 'BookingInviteLink',
    field: 'createdByUserId',
    action: 'delete',
    reason:
      'The links the account made to share its bookings. Each died when its booking started, and an account with an upcoming booking cannot be deleted.',
  },
  {
    model: 'BookingInviteLink',
    field: 'revokedByUserId',
    action: 'anonymise',
    reason: 'Set to null anywhere the account stopped a link it did not make.',
  },
  {
    model: 'BookingInviteLink',
    field: 'tokenHash',
    action: 'delete',
    reason: 'Deleted with the account’s links; another booker’s links are not the account’s.',
  },
  {
    model: 'Cancellation',
    field: 'cancelledByUserId',
    action: 'keep',
    reason: 'Who cancelled a kept booking: part of its record, and the id names a tombstone.',
  },
  {
    model: 'Cancellation',
    field: 'reason',
    action: 'keep',
    reason: 'Why a kept booking was cancelled: the club’s record of it.',
  },
  {
    model: 'CheckIn',
    field: 'userId',
    action: 'keep',
    reason: 'A check-in on a kept booking (nothing writes them yet); the id names a tombstone.',
  },
  {
    model: 'Refund',
    field: 'reason',
    action: 'keep',
    reason: 'A financial record of a kept booking.',
  },
  {
    model: 'Payment',
    field: 'failureReasonJson',
    action: 'keep',
    reason: 'What the payment provider said about a failed charge: a financial record.',
  },

  // ── Money ─────────────────────────────────────────────────────────────
  {
    model: 'ClubFeeLine',
    action: 'keep',
    reason:
      'The platform fee ledger: append-only, and it names no person at all, only the booking, venue and court.',
  },
  {
    model: 'CreditLedgerEntry',
    field: 'userId',
    action: 'keep',
    reason:
      'An append-only money ledger (its trigger refuses changes); a balance must stay reconstructable. The id names a tombstone. Unused credit is lost with the account: the owner’s decision is warn, then allow, so the profile and the deletion dialog list each club’s balance first.',
  },
  {
    model: 'BookingSplit',
    field: 'userId',
    action: 'keep',
    reason:
      'A share of a kept booking’s price (nothing writes them yet); the id names a tombstone.',
  },
  {
    model: 'BookingSplit',
    field: 'inviteEmail',
    action: 'anonymise',
    reason: 'Set to null on the account’s shares.',
  },
  {
    model: 'BookingSplit',
    field: 'tokenHash',
    action: 'keep',
    reason: 'The hash of a payment link; not personal.',
  },
  {
    model: 'Membership',
    field: 'playerUserId',
    action: 'keep',
    reason:
      'A club’s membership plan sold to the person: a commercial record (nothing writes them yet).',
  },
  {
    model: 'SeasonPass',
    field: 'playerUserId',
    action: 'keep',
    reason: 'A pass sold to the person: a commercial record (nothing writes them yet).',
  },
  {
    model: 'SeasonPass',
    field: 'name',
    action: 'keep',
    reason: 'The pass’s product name; not personal.',
  },

  // ── Reviews and moderation ────────────────────────────────────────────
  {
    model: 'Review',
    field: 'authorUserId',
    action: 'delete',
    reason:
      'The account’s reviews, and every venue they rated has its rating recomputed in the same transaction.',
  },
  {
    model: 'Review',
    field: 'body',
    action: 'delete',
    reason: 'Deleted with the review.',
  },
  {
    model: 'ModerationCase',
    field: 'reportedByUserId',
    action: 'anonymise',
    reason: 'Set to null: the case stays, the reporter goes.',
  },
  {
    model: 'ModerationCase',
    field: 'resolvedByUserId',
    action: 'keep',
    reason: 'Which moderator decided: the accountability record. The id names a tombstone.',
  },
  {
    model: 'ModerationCase',
    field: 'reason',
    action: 'keep',
    reason: 'Why the case was opened: a classifier category, not personal.',
  },
  {
    model: 'ContentReport',
    field: 'reporterUserId',
    action: 'delete',
    reason: 'The account’s own reports.',
  },
  {
    model: 'ContentReport',
    field: 'reason',
    action: 'delete',
    reason: 'Deleted with the report.',
  },

  // ── Notifications and devices ─────────────────────────────────────────
  {
    model: 'Notification',
    field: 'userId',
    action: 'delete',
    reason:
      'The account’s bell. Also deleted: other people’s bell rows that name the account, since their copy carries its name: a player joined or left (found by the place, which the club’s audit log keeps after the person left or was removed), or was added or removed by the account as booker.',
  },
  {
    model: 'Notification',
    field: 'body',
    action: 'delete',
    reason: 'Deleted with the rows above.',
  },
  {
    model: 'EmailOutbox',
    field: 'userId',
    action: 'delete',
    reason: 'The account’s email, sent or not, with the copy it carries.',
  },
  {
    model: 'PushSubscription',
    action: 'delete',
    reason: 'The account’s browsers: endpoint, keys and user agent.',
  },
  {
    model: 'DeviceToken',
    action: 'delete',
    reason: 'The account’s phones: the APNs token and the device name.',
  },
  {
    model: 'ContactRequest',
    action: 'keep',
    reason:
      'An enquiry from the landing page: anonymous, linked to no account. A person who asks for one to be erased is answered by the operator (docs/platform-admin-runbook.md).',
  },

  // ── Platform ──────────────────────────────────────────────────────────
  {
    model: 'PlatformAdminGrant',
    field: 'userId',
    action: 'keep',
    reason:
      'A grant row is never deleted (its trigger refuses it: who held platform authority is the record). A live grant is REVOKED by the deletion, with the account as the revoker.',
  },
  {
    model: 'PlatformAdminGrant',
    field: 'grantedByUserId',
    action: 'keep',
    reason: 'Who issued a grant: the accountability record. The id names a tombstone.',
  },
  {
    model: 'PlatformAdminGrant',
    field: 'revokedByUserId',
    action: 'keep',
    reason: 'Who ended a grant: the accountability record.',
  },
  {
    model: 'PlatformAdminGrant',
    field: 'reason',
    action: 'keep',
    reason: 'Why a grant was issued: the accountability record.',
  },
  {
    model: 'PlatformAuditEntry',
    field: 'actorUserId',
    action: 'keep',
    reason: 'An append-only record of what a platform admin did. The id names a tombstone.',
  },
  {
    model: 'PlatformAuditEntry',
    field: 'ipAddress',
    action: 'keep',
    reason:
      'Never written: no platform route passes an address to the platform audit writer, and the guardrail keeps it so. Nothing to erase.',
  },
  {
    model: 'PlatformAuditEntry',
    field: 'userAgent',
    action: 'keep',
    reason: 'Never written, as ipAddress.',
  },
  {
    model: 'PlatformAuditEntry',
    field: 'reason',
    action: 'keep',
    reason: 'The admin’s stated reason: the accountability record.',
  },
  {
    model: 'PlatformAuditEntry',
    field: 'detailsJson',
    action: 'keep',
    reason: 'What the admin did (ids, counts, before and after): the accountability record.',
  },
  {
    model: 'AuditEntry',
    field: 'actorUserId',
    action: 'keep',
    reason:
      'A club’s append-only history: the event stays (P26: "erasure is handled by anonymising the User row, not by deleting history"). The id names a tombstone.',
  },
  {
    model: 'AuditEntry',
    field: 'ipAddress',
    action: 'keep',
    reason:
      'Never written: no caller passes an address to appendAuditEntry, and the guardrail keeps it so. Nothing to erase.',
  },
  {
    model: 'AuditEntry',
    field: 'userAgent',
    action: 'keep',
    reason: 'Never written, as ipAddress.',
  },
  {
    model: 'AuditEntry',
    field: 'details',
    action: 'keep',
    reason:
      'The club’s own history, append-only. About a player it holds ids; where it holds words, they are what the club’s staff typed (a desk customer’s name, a note, the address a staff invitation went to): the club’s record, as its bookings are.',
  },
  {
    model: 'AuditEntry',
    field: 'detailsJson',
    action: 'keep',
    reason: 'As details.',
  },

  // ── Modules not built yet: no route writes these, decided anyway ──────
  {
    model: 'Coach',
    field: 'userId',
    action: 'anonymise',
    reason:
      'A coach profile at a club: kept, CLOSED, its bio and certifications cleared, because the club’s coach bookings point at it.',
  },
  {
    model: 'Coach',
    field: 'bio',
    action: 'anonymise',
    reason: 'Set to null with the profile closed.',
  },
  {
    model: 'CoachBooking',
    field: 'playerUserId',
    action: 'keep',
    reason: 'A club’s booking of a coach, kept as a court booking is. The id names a tombstone.',
  },
  {
    model: 'CoachBooking',
    field: 'notes',
    action: 'anonymise',
    reason:
      'Set to null on the account’s coach bookings: a coach’s notes about a player can be health data.',
  },
  {
    model: 'CoachReview',
    field: 'authorUserId',
    action: 'delete',
    reason: 'The account’s reviews of coaches, and the reviews of the account’s own coach profile.',
  },
  {
    model: 'CoachReview',
    field: 'body',
    action: 'delete',
    reason: 'Deleted with the review.',
  },
  {
    model: 'XpEvent',
    action: 'delete',
    reason: 'The account’s points. P18 permits DELETE on this log for exactly this.',
  },
  {
    model: 'UserAchievement',
    action: 'delete',
    reason: 'The account’s badges.',
  },
  {
    model: 'SkillRatingHistory',
    action: 'delete',
    reason: 'The account’s own rating history.',
  },
  {
    model: 'MatchParticipant',
    field: 'userId',
    action: 'keep',
    reason: 'A match other people played and were rated on; the id names a tombstone.',
  },
  {
    model: 'MatchResultRecord',
    field: 'reportedByUserId',
    action: 'keep',
    reason: 'Who reported a result others were rated on; the id names a tombstone.',
  },
  {
    model: 'OpenPlaySession',
    field: 'hostUserId',
    action: 'keep',
    reason: 'A session other people joined; the id names a tombstone.',
  },
  {
    model: 'OpenPlaySession',
    field: 'meetingPointLat',
    action: 'keep',
    reason: 'A public meeting point for a run or a ride, not where a person is.',
  },
  {
    model: 'OpenPlaySession',
    field: 'meetingPointLng',
    action: 'keep',
    reason: 'As meetingPointLat.',
  },
  {
    model: 'SessionParticipant',
    action: 'delete',
    reason: 'The account’s places in open-play sessions (its id is part of the key).',
  },
  {
    model: 'SessionChatMessage',
    field: 'senderUserId',
    action: 'delete',
    reason: 'The account’s messages: its own words.',
  },
  {
    model: 'SessionChatMessage',
    field: 'body',
    action: 'delete',
    reason: 'Deleted with the message.',
  },
  {
    model: 'Conversation',
    field: 'createdById',
    action: 'keep',
    reason: 'A conversation other people are in; the id names a tombstone.',
  },
  {
    model: 'ConversationParticipant',
    field: 'userId',
    action: 'anonymise',
    reason:
      'The account leaves every conversation (leftAt set). The row stays, so it does not vanish from the others’ history (the schema’s rule).',
  },
  {
    model: 'ChatMessage',
    field: 'senderId',
    action: 'keep',
    reason: 'The message stays as a tombstone in the others’ scrollback; the id names a tombstone.',
  },
  {
    model: 'ChatMessage',
    field: 'body',
    action: 'anonymise',
    reason:
      'Emptied, attachments cleared and deletedAt set on the account’s messages: the schema’s own soft delete, "message deleted".',
  },
  {
    model: 'UserBlock',
    action: 'delete',
    reason: 'Blocks by and of the account.',
  },
  {
    model: 'TournamentEntry',
    field: 'playerUserId',
    action: 'keep',
    reason: 'A bracket other people played; the id names a tombstone.',
  },
  {
    model: 'TournamentMatch',
    field: 'homeUserId',
    action: 'keep',
    reason: 'A fixture other people played; the id names a tombstone.',
  },
  {
    model: 'TournamentMatch',
    field: 'awayUserId',
    action: 'keep',
    reason: 'As homeUserId.',
  },
  {
    model: 'WearableConnection',
    action: 'delete',
    reason: 'The account’s Strava (or other) link: encrypted tokens and the provider’s athlete id.',
  },
  {
    model: 'Activity',
    action: 'delete',
    reason: 'The account’s runs and rides.',
  },

  // ── Aggregates ────────────────────────────────────────────────────────
  {
    model: 'UsageDaily',
    action: 'keep',
    reason:
      'Counts per day, event and venue, with nothing that names a person (tests/guardrails/usage-no-personal-data.test.ts).',
  },
];

/**
 * Columns the guardrail's net catches that hold no person's data: a club's or
 * a venue's own business data, product names, a retired table. Listed rather
 * than filtered by a cleverer pattern, so each one is a decision somebody read.
 *
 * A CLUB account is not deleted by the self-service path (owner decision 3);
 * its club and venues are the platform's to retire, see #370's follow-up.
 */
export const NOT_PERSONAL: Readonly<Record<string, string>> = {
  'VenueOrg.name': 'the club’s name',
  'VenueOrg.contactEmail': 'the club’s contact address, published by the club',
  'VenueOrg.contactPhone': 'the club’s contact phone, published by the club',
  'VenueOrg.addressLine': 'the club’s address',
  'Venue.name': 'a venue’s name',
  'Venue.addressLine': 'a venue’s public address',
  'Venue.phone': 'a venue’s public phone',
  'Venue.email': 'a venue’s public address',
  'Venue.lat': 'a venue’s location',
  'Venue.lng': 'a venue’s location',
  'Venue.coverPhotoUrl': 'a venue’s photo',
  'Resource.name': 'a court’s name',
  'PricingRule.name': 'a pricing rule’s label',
  'TenantCustomRole.name': 'a club’s role label',
  'ClubFeeLine.venueName': 'a venue’s name on the fee ledger',
  'ClubFeeLine.courtName': 'a court’s name on the fee ledger',
  'Achievement.name': 'a badge’s name',
  'Tournament.name': 'a tournament’s name',
  'TenantEntraGroupMapping.aadGroupName': 'a directory group’s name (retired table, #443)',
};
