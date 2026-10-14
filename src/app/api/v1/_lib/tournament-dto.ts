import type {
  ClubEntryRow,
  ClubTournamentDetail,
  MyTournamentEntry,
  TournamentSummary,
  TournamentView,
} from '@/app-layer/usecases/club-tournaments';

/** The API's JSON of a club's tournament (#579): dates as ISO strings. */
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toTournamentDto(t: TournamentSummary) {
  return {
    ...t,
    startsAt: t.startsAt.toISOString(),
    endsAt: iso(t.endsAt),
    entriesCloseAt: iso(t.entriesCloseAt),
  };
}
export type TournamentDto = ReturnType<typeof toTournamentDto>;

function toMyEntryDto(e: MyTournamentEntry) {
  return { ...e, createdAt: e.createdAt.toISOString() };
}

export function toTournamentViewDto(t: TournamentView) {
  return { ...toTournamentDto(t), myEntry: t.myEntry ? toMyEntryDto(t.myEntry) : null };
}
export type TournamentViewDto = ReturnType<typeof toTournamentViewDto>;

function toClubEntryDto(e: ClubEntryRow) {
  return {
    ...e,
    createdAt: e.createdAt.toISOString(),
    decidedAt: iso(e.decidedAt),
    withdrawnAt: iso(e.withdrawnAt),
  };
}

export function toClubTournamentDto(t: ClubTournamentDetail) {
  return { ...toTournamentDto(t), entries: t.entries.map(toClubEntryDto) };
}
export type ClubTournamentDto = ReturnType<typeof toClubTournamentDto>;
