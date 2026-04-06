export type AnalyticsSession = {
  created_at: string | null;
  duration_seconds: number;
};

export type AnalyticsFlashcard = {
  id: string;
};

function isValidDate(value: Date) {
  return !Number.isNaN(value.getTime());
}

export function getWeeklyStudyTime(
  sessions: AnalyticsSession[],
  referenceDate = new Date(),
) {
  const lastSevenDays = new Date(referenceDate);
  lastSevenDays.setDate(lastSevenDays.getDate() - 7);

  return sessions.reduce((total, session) => {
    if (!session.created_at || session.duration_seconds <= 0) {
      return total;
    }

    const createdAt = new Date(session.created_at);

    if (
      !isValidDate(createdAt) ||
      createdAt < lastSevenDays ||
      createdAt > referenceDate
    ) {
      return total;
    }

    return total + session.duration_seconds;
  }, 0);
}

export function getFlashcardCount(cards: AnalyticsFlashcard[]) {
  return cards.length;
}
